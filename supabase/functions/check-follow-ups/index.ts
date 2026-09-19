// ============================================================================
// check-follow-ups  (cron target, 15min)
// ----------------------------------------------------------------------------
// Motor das regras de follow-up (aba Fluxos → Follow-ups). Três gatilhos:
//
//  · no_reply     — reengajamento de broadcast (caminho clássico): enfileira
//                   nova linha em campaign_contacts com template_id_override;
//                   o dispatch-campaign envia via Zernio Broadcast. Agora
//                   também bumpa campaigns.total_contacts (fix do progresso
//                   >100% — antes só `sent` crescia).
//  · inactivity   — conversa de WhatsApp sem movimento há delay_hours: envia
//                   direto 1:1 (API oficial via template aprovado OU UAZAPI
//                   via texto).
//  · no_purchase  — cliente sem compra há params.days dias: mesmo envio 1:1.
//
// Canal por regra (`provider`): 'zernio' (oficial — template aprovado, abre
// janela) ou 'uazapi' (não oficial — message_text livre; risco de banimento
// maior, avisado na UI). Dedup dos gatilhos 1:1 via follow_up_log (1 disparo
// por regra × contato). Filtros opcionais em params: temperature, lead_type,
// tag_id (tag da pessoa OU da oportunidade, que é onde os fluxos gravam).
//
// Travas de segurança (decisão em _shared/follow-up-rules.ts, testada em
// tests/functions). Valem desde 19/09/2026:
//  1. Horário de atendimento: conta fora do horário (app_settings.business_hours
//     no fuso de ai_agent_config.timezone) não envia nem enfileira nada, e nada
//     vai para o follow_up_log. A rodada seguinte dentro do horário envia. Conta
//     que nunca salvou o horário continua enviando a qualquer hora.
//  2. Ordem e janela: regras rodam por conta e por sequence_order. A regra de
//     inatividade só olha conversa cuja última mensagem veio DEPOIS de ela ser
//     ligada (created_at/updated_at) e há no máximo delay_hours + 7 dias.
//  3. Quem falou por último: inatividade só dispara quando a última mensagem
//     não privada é nossa (outbound). Lead esperando resposta fica de fora.
//     Conversa com o time (human_active ou ai_paused) fica de fora, a menos que
//     a regra grave params.include_human_active = true.
//  4. Variáveis: {{1}} do template recebe o primeiro nome da pessoa (ou
//     params.name_fallback); params.template_params ainda fixa valores. Variável
//     sem valor nunca sai vazia: a regra é recusada. message_text aceita {nome}.
//  5. Leitura que falha (follow_up_log, filtros) derruba a regra naquela rodada
//     em vez de virar envio repetido.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import {
  createInboxConversation,
  sendInboxTemplate,
  type ZernioContext,
} from '../_shared/zernio.ts';
import { uazapiContextFromChannel, uazapiSendText, type UazapiContext } from '../_shared/uazapi.ts';
import { getSoleUazapiChannel, loadOrgZernioContext } from '../_shared/channels.ts';
import {
  type BusinessHoursStatus,
  businessHoursStatus,
  conversationSkipReason,
  firstNameOf,
  type IdleWindow,
  inactivityWindow,
  includesHumanConversations,
  lastMessageSkipReason,
  orderRules,
  renderFreeText,
  renderPreview,
  resolveTemplateParams,
  unfillableVariables,
} from '../_shared/follow-up-rules.ts';

interface FollowUpRule {
  id: string;
  org_id: string;
  campaign_id: string | null;
  trigger_condition: 'no_reply' | 'inactivity' | 'no_purchase';
  delay_hours: number;
  template_id: string | null;
  sequence_order: number;
  is_active: boolean;
  provider: 'zernio' | 'uazapi';
  message_text: string | null;
  params: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

interface TargetContact {
  contact_id: string;
  conversation_id: string | null;
  phone: string | null;
  name: string | null;
  zernio_conversation_id: string | null;
  conv_provider: string | null;
  channel_id: string | null;
}

// O que a regra envia, resolvido uma vez por regra (não por contato).
type MessagePlan =
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; language: string; body: string };

type Admin = ReturnType<typeof getAdminClient>;

const PER_RULE_LIMIT = 200;
// Lista de ids em .in() vira query string. 100 UUIDs dão ~4KB, folgado no gateway.
const IN_CHUNK = 100;

// Roda a consulta em fatias de ids e junta o resultado. Erro de leitura sobe:
// quem chama desiste da regra nesta rodada em vez de decidir com dado pela metade.
async function inChunks<T>(
  ids: string[],
  label: string,
  run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await run(ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// Filtros opcionais da regra (temperature / lead_type / tag_id) — aplicados
// sobre os contatos candidatos consultando deals, contact_tags e deal_tags.
async function applyRuleFilters(
  admin: Admin,
  contactIds: string[],
  rule: FollowUpRule,
): Promise<Set<string>> {
  const params = rule.params;
  let allowed = new Set(contactIds);
  const temperature = typeof params.temperature === 'string' ? params.temperature : null;
  const leadType = typeof params.lead_type === 'string' ? params.lead_type : null;
  const tagId = typeof params.tag_id === 'string' ? params.tag_id : null;

  if ((temperature || leadType) && allowed.size > 0) {
    const rows = await inChunks<{ contact_id: string }>([...allowed], 'deals', (chunk) => {
      let q = admin.from('deals').select('contact_id').eq('org_id', rule.org_id).in('contact_id', chunk);
      if (temperature) q = q.eq('temperature', temperature);
      if (leadType) q = q.eq('lead_type', leadType);
      return q;
    });
    allowed = new Set(rows.map((d) => d.contact_id));
  }
  if (tagId && allowed.size > 0) {
    const ids = [...allowed];
    const tagged = new Set<string>();
    // Tag na pessoa (posta à mão em Conversas ou na importação).
    const onContact = await inChunks<{ contact_id: string }>(ids, 'contact_tags', (chunk) =>
      admin.from('contact_tags').select('contact_id').eq('org_id', rule.org_id).eq('tag_id', tagId).in('contact_id', chunk));
    for (const row of onContact) tagged.add(row.contact_id);
    // Tag na oportunidade: é onde a ação "Adicionar tag" dos fluxos grava.
    const deals = await inChunks<{ id: string; contact_id: string }>(ids, 'deals', (chunk) =>
      admin.from('deals').select('id, contact_id').eq('org_id', rule.org_id).in('contact_id', chunk));
    const contactByDeal = new Map(deals.map((d) => [d.id, d.contact_id]));
    const onDeal = await inChunks<{ deal_id: string }>([...contactByDeal.keys()], 'deal_tags', (chunk) =>
      admin.from('deal_tags').select('deal_id').eq('org_id', rule.org_id).eq('tag_id', tagId).in('deal_id', chunk));
    for (const row of onDeal) {
      const contactId = contactByDeal.get(row.deal_id);
      if (contactId) tagged.add(contactId);
    }
    allowed = new Set(ids.filter((id) => tagged.has(id)));
  }
  return allowed;
}

// Resolve o que a regra envia. Erro aqui é de configuração da regra, então
// aparece uma vez por rodada, e nenhum contato recebe nada.
async function loadMessagePlan(admin: Admin, rule: FollowUpRule): Promise<MessagePlan> {
  if (rule.provider === 'uazapi') {
    const text = (rule.message_text ?? '').trim();
    if (!text) throw new Error('regra UAZAPI sem message_text');
    return { kind: 'text', text };
  }
  if (!rule.template_id) throw new Error('regra oficial sem template');
  const { data: tpl, error } = await admin
    .from('templates')
    .select('name, language, body, status')
    .eq('org_id', rule.org_id)
    .eq('id', rule.template_id)
    .maybeSingle();
  if (error) throw new Error(`templates: ${error.message}`);
  const template = tpl as { name: string; language: string; body: string; status: string } | null;
  if (!template || template.status !== 'approved') throw new Error('template não aprovado');
  const unfillable = unfillableVariables(template.body, rule.params.template_params);
  if (unfillable.length > 0) {
    const list = unfillable.map((n) => `{{${n}}}`).join(', ');
    throw new Error(
      `template "${template.name}" tem variável que o follow-up não preenche: ${list}. `
      + 'O follow-up preenche só a {{1}}, com o primeiro nome da pessoa.',
    );
  }
  return { kind: 'template', name: template.name, language: template.language, body: template.body };
}

// Envio 1:1 do follow-up (inactivity / no_purchase) + persistência na inbox.
async function sendDirectFollowUp(
  admin: Admin,
  rule: FollowUpRule,
  plan: MessagePlan,
  target: TargetContact,
  zctx: ZernioContext | null,
  uctx: UazapiContext | null,
): Promise<void> {
  if (!target.phone) throw new Error('contato sem telefone');
  const firstName = firstNameOf(target.name);

  let content: string;
  let contentType: 'text' | 'template';
  let externalId: string | null = null;

  if (plan.kind === 'text') {
    if (!uctx) throw new Error('UAZAPI não configurada');
    const text = renderFreeText(plan.text, firstName);
    const sent = await uazapiSendText(uctx, { phone: target.phone, text });
    externalId = sent.messageId;
    content = text;
    contentType = 'text';
  } else {
    if (!zctx) throw new Error('Zernio não configurado');
    // Parâmetro vazio nunca sai: sem valor para a variável, este contato fica
    // para depois (sem registro no follow_up_log).
    const resolved = resolveTemplateParams(plan.body, rule.params.template_params, firstName, rule.params.name_fallback);
    if (!resolved.ok) {
      throw new Error(
        resolved.reason === 'missing_name'
          ? `pessoa sem nome para preencher a variável {{${resolved.index}}} (complete o nome em Pessoas ou grave params.name_fallback na regra)`
          : `variável {{${resolved.index}}} do template sem valor`,
      );
    }
    const components = resolved.values.length > 0
      ? [{ type: 'body', parameters: resolved.values.map((text) => ({ type: 'text', text })) }]
      : [];

    // Resolve/cria a conversa 1:1 no Zernio (template abre a janela de 24h).
    let zConvId = target.conv_provider === 'uazapi' ? null : target.zernio_conversation_id;
    if (!zConvId) {
      const created = await createInboxConversation({
        apiKey: zctx.apiKey,
        accountId: zctx.accountId,
        participantId: target.phone,
      });
      zConvId = created.conversationId;
      if (zConvId && target.conversation_id) {
        await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', target.conversation_id);
      }
    }
    if (!zConvId) throw new Error('não resolveu a conversa no Zernio');
    const sent = await sendInboxTemplate({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      conversationId: zConvId,
      name: plan.name,
      language: plan.language,
      components,
    });
    externalId = sent.messageId;
    content = renderPreview(plan.body, resolved.values);
    contentType = 'template';
  }

  // Persistência na inbox (sender_type system — automação, não operador).
  let conversationId = target.conversation_id;
  if (!conversationId) {
    const { data: conv } = await admin
      .from('conversations')
      .insert({
        contact_id: target.contact_id,
        status: 'ai_active',
        channel: 'whatsapp',
        provider: rule.provider === 'uazapi' ? 'uazapi' : 'zernio',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    conversationId = (conv as { id: string } | null)?.id ?? null;
  }
  if (conversationId) {
    await admin.from('messages').insert({
      conversation_id: conversationId,
      direction: 'outbound',
      sender_type: 'system',
      content_type: contentType,
      content,
      zernio_message_id: externalId,
      meta_status: 'sent',
      is_private_note: false,
    });
    await admin
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
  }
}

// Candidatos por gatilho -------------------------------------------------------

// inactivity: conversas de WhatsApp da org da regra paradas DENTRO da janela
// (ver inactivityWindow). As mais recentes vêm primeiro: quem acabou de cruzar a
// espera da regra nunca fica atrás de conversa antiga no limite de 200.
async function inactivityTargets(
  admin: Admin,
  rule: FollowUpRule,
  window: IdleWindow,
  includeHuman: boolean,
): Promise<TargetContact[]> {
  let query = admin
    .from('conversations')
    .select('id, contact_id, status, ai_paused, last_message_at, zernio_conversation_id, provider, channel_id, contact:contact_id(phone, name)')
    .eq('org_id', rule.org_id)
    .eq('channel', 'whatsapp')
    .neq('status', 'closed')
    .gte('last_message_at', window.oldest)
    .lte('last_message_at', window.newest);
  if (!includeHuman) query = query.neq('status', 'human_active').eq('ai_paused', false);
  const { data, error } = await query.order('last_message_at', { ascending: false }).limit(PER_RULE_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  return ((data ?? []) as unknown as Array<{
    id: string;
    contact_id: string;
    status: string | null;
    ai_paused: boolean | null;
    last_message_at: string | null;
    zernio_conversation_id: string | null;
    provider: string | null;
    channel_id: string | null;
    contact: { phone: string | null; name: string | null } | null;
  }>)
    // A consulta já filtra. A decisão é repetida linha a linha para um filtro
    // esquecido na consulta nunca virar mensagem enviada.
    .filter((c) => conversationSkipReason(c, window, includeHuman) === null)
    .map((c) => ({
      contact_id: c.contact_id,
      conversation_id: c.id,
      phone: c.contact?.phone ?? null,
      name: c.contact?.name ?? null,
      zernio_conversation_id: c.zernio_conversation_id,
      conv_provider: c.provider,
      channel_id: c.channel_id,
    }));
}

// Última mensagem não privada da conversa (nota interna do time não conta).
async function lastPublicMessage(admin: Admin, conversationId: string): Promise<{ direction: string } | null> {
  const { data, error } = await admin
    .from('messages')
    .select('direction')
    .eq('conversation_id', conversationId)
    .eq('is_private_note', false)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`messages: ${error.message}`);
  return ((data ?? []) as Array<{ direction: string }>)[0] ?? null;
}

// no_purchase: clientes sem compra há params.days dias.
async function noPurchaseTargets(admin: Admin, rule: FollowUpRule): Promise<TargetContact[]> {
  const days = Number(rule.params.days) || Math.max(1, Math.round(rule.delay_hours / 24));
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: deals, error } = await admin
    .from('deals')
    .select('contact_id, last_purchase_at')
    .eq('org_id', rule.org_id)
    .eq('lead_type', 'Cliente')
    .not('last_purchase_at', 'is', null)
    .lte('last_purchase_at', cutoff)
    .limit(PER_RULE_LIMIT);
  if (error) throw new Error(`deals: ${error.message}`);
  const contactIds = [...new Set(((deals ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id))];
  if (contactIds.length === 0) return [];
  const convs = await inChunks<{
    id: string; contact_id: string; zernio_conversation_id: string | null; provider: string | null; channel_id: string | null;
  }>(contactIds, 'conversations', (chunk) =>
    admin
      .from('conversations')
      .select('id, contact_id, zernio_conversation_id, provider, channel_id')
      .eq('org_id', rule.org_id)
      .in('contact_id', chunk));
  const convByContact = new Map(convs.map((c) => [c.contact_id, c]));
  const contacts = await inChunks<{ id: string; phone: string | null; name: string | null }>(contactIds, 'contacts', (chunk) =>
    admin.from('contacts').select('id, phone, name').eq('org_id', rule.org_id).in('id', chunk));
  return contacts.map((c) => {
    const conv = convByContact.get(c.id) ?? null;
    return {
      contact_id: c.id,
      conversation_id: conv?.id ?? null,
      phone: c.phone,
      name: c.name,
      zernio_conversation_id: conv?.zernio_conversation_id ?? null,
      conv_provider: conv?.provider ?? null,
      channel_id: conv?.channel_id ?? null,
    };
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const admin = getAdminClient();
  const now = new Date();

  const { data: rules, error: rulesErr } = await admin
    .from('follow_up_rules')
    .select('id, org_id, campaign_id, trigger_condition, delay_hours, template_id, sequence_order, is_active, provider, message_text, params, created_at, updated_at')
    .eq('is_active', true);
  if (rulesErr) return jsonResponse({ ok: false, error: rulesErr.message }, { status: 500 });

  // Ordem da cadência: por conta e por sequence_order (toque 1 antes do 3).
  const active = orderRules((rules ?? []) as FollowUpRule[]);
  if (active.length === 0) return jsonResponse({ ok: true, enqueued: 0, sent: 0, deferred: 0, rules: 0, errors: [] });

  // Só orgs ativas — regras de orgs arquivadas são puladas.
  const ruleOrgIds = [...new Set(active.map((r) => r.org_id))];
  const { data: activeOrgRows } = await admin
    .from('organizations')
    .select('id')
    .eq('status', 'active')
    .in('id', ruleOrgIds);
  const activeOrgs = new Set(((activeOrgRows ?? []) as Array<{ id: string }>).map((o) => o.id));

  // Contextos resolvidos POR ORG sob demanda (cache no request). O envio direto
  // 1:1 usa o contexto da org dona da regra: Zernio (template) ou UAZAPI (texto).
  const zctxByOrg = new Map<string, ZernioContext | null>();
  const uctxByOrg = new Map<string, UazapiContext | null>();
  const zctxOf = async (orgId: string): Promise<ZernioContext | null> => {
    if (zctxByOrg.has(orgId)) return zctxByOrg.get(orgId) ?? null;
    let ctx: ZernioContext | null = null;
    try { ctx = await loadOrgZernioContext(admin, orgId); } catch { /* regra oficial falha com erro claro */ }
    zctxByOrg.set(orgId, ctx);
    return ctx;
  };
  const uctxOf = async (orgId: string): Promise<UazapiContext | null> => {
    if (uctxByOrg.has(orgId)) return uctxByOrg.get(orgId) ?? null;
    let ctx: UazapiContext | null = null;
    try {
      const channel = await getSoleUazapiChannel(admin, orgId);
      if (channel) ctx = await uazapiContextFromChannel(channel);
    } catch { /* regra uazapi falha com erro claro */ }
    uctxByOrg.set(orgId, ctx);
    return ctx;
  };

  // Horário de atendimento POR ORG (cache no request). Mesma fonte que o
  // process-ai-message usa: app_settings.business_hours + ai_agent_config.timezone.
  // Leitura que falha sobe e a regra fica para a próxima rodada.
  const hoursByOrg = new Map<string, BusinessHoursStatus>();
  const hoursOf = async (orgId: string): Promise<BusinessHoursStatus> => {
    const cached = hoursByOrg.get(orgId);
    if (cached) return cached;
    const [settings, agent] = await Promise.all([
      admin.from('app_settings').select('business_hours').eq('org_id', orgId).maybeSingle(),
      admin.from('ai_agent_config').select('timezone').eq('org_id', orgId).maybeSingle(),
    ]);
    if (settings.error) throw new Error(`app_settings: ${settings.error.message}`);
    if (agent.error) throw new Error(`ai_agent_config: ${agent.error.message}`);
    const status = businessHoursStatus(
      (settings.data as { business_hours?: unknown } | null)?.business_hours,
      (agent.data as { timezone?: string | null } | null)?.timezone,
      now,
    );
    hoursByOrg.set(orgId, status);
    return status;
  };

  let totalEnqueued = 0;
  let totalSent = 0;
  let deferred = 0;
  const skipped: Record<string, number> = {};
  const errors: string[] = [];

  for (const rule of active) {
    try {
      // Org arquivada: pula a regra inteira.
      if (!activeOrgs.has(rule.org_id)) continue;

      // Fora do horário de atendimento da conta: nada sai, nada é enfileirado e
      // nada é registrado. A próxima rodada dentro do horário cuida disso.
      if ((await hoursOf(rule.org_id)) === 'closed') {
        deferred++;
        continue;
      }

      // ---- no_reply: caminho clássico via campaign_contacts/broadcast ------
      if (rule.trigger_condition === 'no_reply') {
        if (!rule.template_id) continue; // regra malformada
        const cutoff = new Date(Date.now() - rule.delay_hours * 3600 * 1000).toISOString();
        let query = admin
          .from('campaign_contacts')
          .select('id, campaign_id, contact_id, sent_at')
          .eq('org_id', rule.org_id)
          .in('status', ['sent', 'delivered', 'read'])
          .is('replied_at', null)
          .is('template_id_override', null)
          .lte('sent_at', cutoff)
          .limit(500);
        if (rule.campaign_id) query = query.eq('campaign_id', rule.campaign_id);
        const { data: eligible, error: eligErr } = await query;
        if (eligErr) { errors.push(`rule ${rule.id}: ${eligErr.message}`); continue; }
        const batch = (eligible ?? []) as Array<{ id: string; campaign_id: string; contact_id: string }>;
        if (batch.length === 0) continue;

        // Dedupe durável: template_id_override persiste após envio.
        const alreadyEnq = await inChunks<{ contact_id: string }>(
          [...new Set(batch.map((b) => b.contact_id))],
          'campaign_contacts',
          (chunk) => admin
            .from('campaign_contacts')
            .select('contact_id')
            .eq('org_id', rule.org_id)
            .in('contact_id', chunk)
            .eq('template_id_override', rule.template_id),
        );
        const seen = new Set(alreadyEnq.map((r) => r.contact_id));

        const toInsert = batch
          .filter((b) => !seen.has(b.contact_id))
          .map((b) => ({
            campaign_id: b.campaign_id,
            contact_id: b.contact_id,
            status: 'pending' as const,
            template_id_override: rule.template_id,
            error_message: `Follow-up (ordem ${rule.sequence_order})`,
          }));
        if (toInsert.length === 0) continue;

        const { error: insErr } = await admin.from('campaign_contacts').insert(toInsert);
        if (insErr) { errors.push(`rule ${rule.id}: insert: ${insErr.message}`); continue; }

        // Reabre campanhas concluídas E bumpa total_contacts — sem isso o
        // progresso do card passa de 100% (sent cresce, total não).
        const byCampaign = new Map<string, number>();
        for (const r of toInsert) byCampaign.set(r.campaign_id, (byCampaign.get(r.campaign_id) ?? 0) + 1);
        for (const [campaignId, count] of byCampaign) {
          await admin
            .from('campaigns')
            .update({ status: 'sending', completed_at: null })
            .eq('id', campaignId)
            .eq('status', 'completed');
          await admin.rpc('bump_campaign_counter', {
            p_campaign_id: campaignId,
            p_column: 'total_contacts',
            p_delta: count,
          });
        }
        totalEnqueued += toInsert.length;
        continue;
      }

      // ---- inactivity / no_purchase: envio direto 1:1 ----------------------
      let targets: TargetContact[];
      if (rule.trigger_condition === 'inactivity') {
        // Regra ligada há menos tempo que a própria espera ainda não tem quem olhar.
        const window = inactivityWindow(rule, now);
        if (!window) continue;
        targets = await inactivityTargets(admin, rule, window, includesHumanConversations(rule.params));
      } else {
        targets = await noPurchaseTargets(admin, rule);
      }
      if (targets.length === 0) continue;

      // Dedup por regra×contato (follow_up_log) + filtros opcionais. Se a leitura
      // do log falhar, a regra para aqui: enviar sem saber quem já recebeu
      // repetiria o follow-up.
      const ids = [...new Set(targets.map((t) => t.contact_id))];
      const logged = await inChunks<{ contact_id: string }>(ids, 'follow_up_log', (chunk) =>
        admin.from('follow_up_log').select('contact_id').eq('rule_id', rule.id).in('contact_id', chunk));
      const done = new Set(logged.map((l) => l.contact_id));
      const allowed = await applyRuleFilters(admin, ids.filter((id) => !done.has(id)), rule);
      const pending = targets.filter((t) => !done.has(t.contact_id) && allowed.has(t.contact_id));
      if (pending.length === 0) continue;

      // O que enviar + contextos da org da regra (Zernio p/ template, UAZAPI p/ texto).
      const plan = await loadMessagePlan(admin, rule);
      const zctx = rule.provider === 'zernio' ? await zctxOf(rule.org_id) : null;
      const uctx = rule.provider === 'uazapi' ? await uctxOf(rule.org_id) : null;

      for (const target of pending) {
        try {
          // Inatividade só vale quando fomos nós que falamos por último. Se a
          // última mensagem é do lead, ele está esperando resposta.
          if (rule.trigger_condition === 'inactivity' && target.conversation_id) {
            const reason = lastMessageSkipReason(await lastPublicMessage(admin, target.conversation_id));
            if (reason) {
              skipped[reason] = (skipped[reason] ?? 0) + 1;
              continue;
            }
          }
          await sendDirectFollowUp(admin, rule, plan, target, zctx, uctx);
          await admin.from('follow_up_log').insert({ rule_id: rule.id, contact_id: target.contact_id });
          totalSent++;
        } catch (err) {
          errors.push(`rule ${rule.id} contato ${target.contact_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(JSON.stringify({
    event: 'check_follow_ups_run',
    rules: active.length,
    enqueued: totalEnqueued,
    sent: totalSent,
    deferred,
    skipped,
    errors: errors.length,
  }));
  return jsonResponse({ ok: true, rules: active.length, enqueued: totalEnqueued, sent: totalSent, deferred, skipped, errors });
});
