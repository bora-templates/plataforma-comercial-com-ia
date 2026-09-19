// ============================================================================
// funnel-automation — executor das Automações de Funil
// ----------------------------------------------------------------------------
// Invocada pelo trigger on_deal_stage_automation (pg_net) quando um deal ENTRA
// numa etapa com automação ativa. Payload: { deal_id, stage_id }.
//
// Ações suportadas (funnel_automations.actions, array JSONB):
//   add_tag{tag_id}                       → deal_tags (ignora duplicata). O filtro
//                                           de tag do follow-up lê a tag da pessoa
//                                           E a da oportunidade, então esta vale lá
//   next_action{action_type, delay_hours, note} → crm_activities (due_at)
//   set_lead_type{value} / set_temperature{value} → update no deal
//   send_template{template_id, params?, name_fallback?}
//                                         → template 1:1 via Zernio (oficial).
//                                           {{1}} recebe o primeiro nome da pessoa
//                                           (ou name_fallback); params fixa valores
//                                           por posição e aceita {nome}. Variável
//                                           sem valor nunca sai vazia: a ação falha
//                                           com o motivo em `errors`.
//   send_text{text}                       → texto pela conversa do contato
//                                           (provider da conversa: Zernio/UAZAPI);
//                                           {nome} vira o primeiro nome
//   assign{user_id}                       → conversations.assigned_to
//   add_to_pipeline{pipeline_id, stage_id}→ novo deal no outro funil (skip se
//                                           o contato já tem deal lá — evita loop)
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { sendInboxWithResolve } from '../_shared/inbox-delivery.ts';
import { createInboxConversation, sendInboxTemplate } from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';
import {
  firstNameOf,
  renderFreeText,
  renderPreview,
  resolveTemplateParams,
  unfillableVariables,
} from '../_shared/follow-up-rules.ts';

type Admin = ReturnType<typeof getAdminClient>;
type Action = Record<string, unknown> & { type: string };

interface DealRow {
  id: string;
  org_id: string;
  contact_id: string;
  stage_id: string | null;
  pipeline_id: string | null;
  title: string;
}

async function conversationOf(admin: Admin, orgId: string, contactId: string) {
  const { data } = await admin
    .from('conversations')
    .select('id, channel, provider, channel_id, zernio_conversation_id, zernio_account_id')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  return data as {
    id: string;
    channel: 'whatsapp' | 'instagram';
    provider: string | null;
    channel_id: string | null;
    zernio_conversation_id: string | null;
    zernio_account_id: string | null;
  } | null;
}

async function recordSystemMessage(
  admin: Admin,
  orgId: string,
  conversationId: string,
  contentType: 'text' | 'template',
  content: string,
  externalId: string | null,
) {
  await admin.from('messages').insert({
    org_id: orgId,
    conversation_id: conversationId,
    direction: 'outbound',
    sender_type: 'system',
    content_type: contentType,
    content,
    zernio_message_id: externalId,
    meta_status: 'sent',
    is_private_note: false,
  });
  await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);
}

async function runAction(admin: Admin, deal: DealRow, action: Action, errors: string[]): Promise<void> {
  const t = action.type;

  if (t === 'add_tag' && typeof action.tag_id === 'string') {
    const { error } = await admin
      .from('deal_tags')
      .upsert({ org_id: deal.org_id, deal_id: deal.id, tag_id: action.tag_id }, { onConflict: 'deal_id,tag_id', ignoreDuplicates: true });
    if (error) errors.push(`add_tag: ${error.message}`);
    return;
  }

  if (t === 'next_action') {
    const delayHours = Number(action.delay_hours) || 24;
    const { error } = await admin.from('crm_activities').insert({
      org_id: deal.org_id,
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: typeof action.action_type === 'string' ? action.action_type : 'followup',
      body: typeof action.note === 'string' && action.note.trim() ? action.note : 'Ação criada por automação do funil',
      due_at: new Date(Date.now() + delayHours * 3600 * 1000).toISOString(),
      done: false,
    });
    if (error) errors.push(`next_action: ${error.message}`);
    return;
  }

  if (t === 'set_lead_type' && (action.value === 'Lead' || action.value === 'Cliente')) {
    const { error } = await admin.from('deals').update({ lead_type: action.value }).eq('id', deal.id);
    if (error) errors.push(`set_lead_type: ${error.message}`);
    return;
  }

  if (t === 'set_temperature' && ['Frio', 'Morno', 'Quente'].includes(String(action.value))) {
    const { error } = await admin.from('deals').update({ temperature: action.value }).eq('id', deal.id);
    if (error) errors.push(`set_temperature: ${error.message}`);
    return;
  }

  if (t === 'assign' && typeof action.user_id === 'string') {
    const conv = await conversationOf(admin, deal.org_id, deal.contact_id);
    if (!conv) { errors.push('assign: contato sem conversa'); return; }
    const { error } = await admin
      .from('conversations')
      .update({ assigned_to: action.user_id, assigned_at: new Date().toISOString() })
      .eq('id', conv.id);
    if (error) errors.push(`assign: ${error.message}`);
    return;
  }

  if (t === 'add_to_pipeline' && typeof action.pipeline_id === 'string' && typeof action.stage_id === 'string') {
    // Skip se o contato já tem deal no funil destino — evita duplicação e
    // loops entre automações de funis diferentes.
    const { data: existing } = await admin
      .from('deals')
      .select('id')
      .eq('org_id', deal.org_id)
      .eq('contact_id', deal.contact_id)
      .eq('pipeline_id', action.pipeline_id)
      .limit(1);
    if ((existing ?? []).length > 0) return;
    const { error } = await admin.from('deals').insert({
      org_id: deal.org_id,
      contact_id: deal.contact_id,
      pipeline_id: action.pipeline_id,
      stage_id: action.stage_id,
      title: deal.title,
      status: 'open',
    });
    if (error) errors.push(`add_to_pipeline: ${error.message}`);
    return;
  }

  if (t === 'send_text' && typeof action.text === 'string' && action.text.trim()) {
    const conv = await conversationOf(admin, deal.org_id, deal.contact_id);
    const { data: contact } = await admin
      .from('contacts')
      .select('phone, instagram_id, name')
      .eq('org_id', deal.org_id)
      .eq('id', deal.contact_id)
      .maybeSingle();
    const c = contact as { phone: string | null; instagram_id?: string | null; name?: string | null } | null;
    if (!conv || !c) { errors.push('send_text: contato sem conversa'); return; }
    // {nome} vira o primeiro nome; sem nome, o marcador sai e a frase continua natural.
    const text = renderFreeText(action.text, firstNameOf(c.name));
    try {
      const messageId = await sendInboxWithResolve(admin, {
        conversationRowId: conv.id,
        orgId: deal.org_id,
        channel: conv.channel,
        phone: c.phone,
        instagramId: c.instagram_id ?? null,
        storedZernioConversationId: conv.zernio_conversation_id,
        channelId: conv.channel_id ?? null,
        zernioAccountId: conv.zernio_account_id,
        provider: conv.provider,
      }, { text });
      await recordSystemMessage(admin, deal.org_id, conv.id, 'text', text, messageId);
    } catch (err) {
      errors.push(`send_text: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (t === 'send_template' && typeof action.template_id === 'string') {
    try {
      const { data: tpl } = await admin
        .from('templates')
        .select('name, language, body, status')
        .eq('org_id', deal.org_id)
        .eq('id', action.template_id)
        .maybeSingle();
      const template = tpl as { name: string; language: string; body: string; status: string } | null;
      if (!template || template.status !== 'approved') throw new Error('template não aprovado');
      const { data: contact } = await admin.from('contacts').select('phone, name').eq('org_id', deal.org_id).eq('id', deal.contact_id).maybeSingle();
      const person = contact as { phone: string | null; name: string | null } | null;
      const phone = person?.phone;
      if (!phone) throw new Error('contato sem telefone');

      // Parâmetro vazio nunca sai (a Meta recusa, ou entrega a frase quebrada):
      // {{1}} é o primeiro nome, o resto só com valor fixo em action.params.
      const unfillable = unfillableVariables(template.body, action.params);
      if (unfillable.length > 0) {
        throw new Error(
          `template "${template.name}" tem variável que o fluxo não preenche: ${unfillable.map((n) => `{{${n}}}`).join(', ')}. `
          + 'O fluxo preenche só a {{1}}, com o primeiro nome da pessoa.',
        );
      }
      const resolved = resolveTemplateParams(template.body, action.params, firstNameOf(person?.name), action.name_fallback);
      if (!resolved.ok) {
        throw new Error(
          resolved.reason === 'missing_name'
            ? `pessoa sem nome para preencher a variável {{${resolved.index}}} (complete o nome em Pessoas ou grave name_fallback na ação)`
            : `variável {{${resolved.index}}} do template sem valor`,
        );
      }
      const paramValues = resolved.values;
      const components = paramValues.length > 0
        ? [{ type: 'body', parameters: paramValues.map((text) => ({ type: 'text', text })) }]
        : [];

      // Template (oficial/Zernio) usa o accountId do canal da conversa quando há;
      // senão o default da org.
      const conv = await conversationOf(admin, deal.org_id, deal.contact_id);
      const ctx = await loadOrgZernioContext(admin, deal.org_id, conv?.zernio_account_id ?? null);
      let zConvId = conv?.provider === 'uazapi' ? null : conv?.zernio_conversation_id ?? null;
      if (!zConvId) {
        const created = await createInboxConversation({ apiKey: ctx.apiKey, accountId: ctx.accountId, participantId: phone });
        zConvId = created.conversationId;
        if (zConvId && conv) {
          await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', conv.id);
        }
      }
      if (!zConvId) throw new Error('não resolveu a conversa no Zernio');
      const sent = await sendInboxTemplate({
        apiKey: ctx.apiKey,
        accountId: ctx.accountId,
        conversationId: zConvId,
        name: template.name,
        language: template.language,
        components,
      });
      if (conv) await recordSystemMessage(admin, deal.org_id, conv.id, 'template', renderPreview(template.body, paramValues), sent.messageId);
    } catch (err) {
      errors.push(`send_template: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  errors.push(`ação desconhecida/malformada: ${t}`);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body: { deal_id?: string; stage_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }
  const dealId = body.deal_id;
  const stageId = body.stage_id;
  if (!dealId || !stageId) return jsonResponse({ ok: false, error: 'deal_id/stage_id obrigatórios' }, { status: 400 });

  const admin = getAdminClient();

  // Idempotência leve: se o deal já saiu da etapa, não executa. Carrega o
  // org_id do deal — toda credencial/query subsequente é da org dona do deal.
  const { data: dealRow } = await admin
    .from('deals')
    .select('id, org_id, contact_id, stage_id, pipeline_id, title')
    .eq('id', dealId)
    .maybeSingle();
  const deal = dealRow as DealRow | null;
  if (!deal || deal.stage_id !== stageId) {
    return jsonResponse({ ok: true, skipped: 'deal fora da etapa' });
  }

  // Org arquivada: não executa automações.
  const { data: orgRow } = await admin
    .from('organizations')
    .select('status')
    .eq('id', deal.org_id)
    .maybeSingle();
  if ((orgRow as { status?: string } | null)?.status !== 'active') {
    return jsonResponse({ ok: true, skipped: 'org not active' });
  }

  const { data: autos } = await admin
    .from('funnel_automations')
    .select('id, name, actions')
    .eq('org_id', deal.org_id)
    .eq('stage_id', stageId)
    .eq('is_active', true);
  const automations = (autos ?? []) as Array<{ id: string; name: string; actions: Action[] }>;
  if (automations.length === 0) return jsonResponse({ ok: true, executed: 0 });

  const errors: string[] = [];
  let executed = 0;
  for (const auto of automations) {
    const actions = Array.isArray(auto.actions) ? auto.actions : [];
    for (const action of actions) {
      await runAction(admin, deal, action, errors);
      executed++;
    }
  }

  console.log(JSON.stringify({ event: 'funnel_automation_run', deal_id: dealId, stage_id: stageId, executed, errors }));
  return jsonResponse({ ok: true, executed, errors });
});
