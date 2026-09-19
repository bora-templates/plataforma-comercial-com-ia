// ============================================================================
// check-follow-ups de ponta a ponta: o handler de verdade roda contra um
// PostgREST, um Zernio e uma UAZAPI de mentira (tests/functions/lib).
//
// Como rodar (precisa do Deno, o mesmo runtime das Edge Functions):
//   npm run test:functions:e2e
// ============================================================================

import assert from 'node:assert/strict';
import { cronRequest, loadEdgeHandler } from './lib/fake-backend.ts';
import { daysAgoDate, hoursAgo, hoursClosedNow, hoursOpenNow, newScenario, type Scenario } from './lib/scenario.ts';

const handler = await loadEdgeHandler(
  new URL('../../supabase/functions/check-follow-ups/index.ts', import.meta.url).href,
);

interface RunResult {
  ok: boolean;
  rules: number;
  enqueued: number;
  sent: number;
  deferred?: number;
  errors: string[];
}

async function run(): Promise<RunResult> {
  const res = await handler(cronRequest('check-follow-ups'));
  assert.equal(res.status, 200);
  return await res.json() as RunResult;
}

// O fetch de mentira é global, então cada teste monta e desmonta o seu cenário.
// Os sanitizers ficam desligados porque o supabase-js deixa timers internos
// abertos (renovação de sessão), que não têm relação com o que é testado aqui.
function scenarioTest(name: string, fn: (s: Scenario) => Promise<void>): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const s = await newScenario();
      try {
        await fn(s);
      } finally {
        s.done();
      }
    },
  });
}

const templateParams = (call: { body: Record<string, unknown> }): string[] => {
  const template = call.body.template as { elements: Array<{ components: Array<{ parameters: Array<{ text: string }> }> }> };
  return (template.elements[0].components[0]?.parameters ?? []).map((p) => p.text);
};
const templateName = (call: { body: Record<string, unknown> }): string =>
  (call.body.template as { elements: Array<{ name: string }> }).elements[0].name;

// ---- Comportamento que já existia e precisa continuar ---------------------------

scenarioTest('inatividade: envia o template, grava na conversa, registra o envio e zera o relógio', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo? Ficou alguma dúvida?');
  const ruleId = s.addRule({ template_id: templateId, delay_hours: 24 });
  const lead = s.addLead({ idleHours: 30 });

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.equal(result.sent, 1);
  const sent = s.backend.zernioMessages();
  assert.equal(sent.length, 1);
  assert.equal(templateName(sent[0]), 'toque_1');
  assert.deepEqual(s.backend.rows('follow_up_log').map((l) => [l.rule_id, l.contact_id]), [[ruleId, lead.contactId]]);
  const saved = s.backend.rows('messages').filter((m) => m.sender_type === 'system');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, 'Oi, tudo certo? Ficou alguma dúvida?');
  const conv = s.backend.rows('conversations').find((c) => c.id === lead.conversationId)!;
  assert.ok(Date.parse(String(conv.last_message_at)) > Date.parse(hoursAgo(1)));
});

scenarioTest('inatividade: cada regra dispara uma vez só por pessoa', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, delay_hours: 24 });
  const lead = s.addLead({ idleHours: 30 });

  assert.equal((await run()).sent, 1);
  // A conversa para de novo por 30 horas, com a nossa mensagem por último.
  const conv = s.backend.rows('conversations').find((c) => c.id === lead.conversationId)!;
  conv.last_message_at = hoursAgo(30);
  for (const m of s.backend.rows('messages')) {
    if (m.sender_type === 'system') m.created_at = hoursAgo(30);
  }

  assert.equal((await run()).sent, 0);
  assert.equal(s.backend.zernioMessages().length, 1);
});

// ---- 1. Horário de atendimento -------------------------------------------------

scenarioTest('horário: fora do horário de atendimento não envia e não registra, fica para a próxima rodada', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.setBusinessHours(hoursClosedNow());

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(result.deferred, 1);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.equal(s.backend.rows('follow_up_log').length, 0);
});

scenarioTest('horário: dentro do horário de atendimento envia', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.setBusinessHours(hoursOpenNow());

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.equal(result.sent, 1);
  assert.equal(result.deferred, 0);
});

scenarioTest('horário: conta que nunca salvou o horário continua enviando a qualquer hora', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.setBusinessHours({});

  assert.equal((await run()).sent, 1);
});

scenarioTest('horário: sem resposta após campanha também espera o horário para enfileirar', async (s) => {
  const templateId = s.addTemplate('reengajamento', 'Oi, conseguiu ver?');
  s.addRule({ trigger_condition: 'no_reply', template_id: templateId, delay_hours: 17 });
  const lead = s.addLead({ idleHours: 20 });
  const campaignId = crypto.randomUUID();
  s.backend.seed('campaigns', { id: campaignId, org_id: s.orgId, name: 'Campanha', status: 'completed', total_contacts: 1 });
  s.backend.seed('campaign_contacts', {
    id: crypto.randomUUID(), org_id: s.orgId, campaign_id: campaignId, contact_id: lead.contactId,
    status: 'delivered', sent_at: hoursAgo(20), replied_at: null, template_id_override: null,
  });
  s.setBusinessHours(hoursClosedNow());

  const closed = await run();
  assert.equal(closed.enqueued, 0);
  assert.equal(closed.deferred, 1);
  assert.equal(s.backend.rows('campaign_contacts').length, 1);

  // Mesmo cenário com o horário aberto: a fila recebe a linha do follow-up.
  s.backend.rows('app_settings')[0].business_hours = hoursOpenNow();
  const open = await run();
  assert.equal(open.enqueued, 1);
  assert.equal(s.backend.rows('campaign_contacts').length, 2);
});

// ---- 2. Primeira ativação e ordem das regras --------------------------------------

scenarioTest('ordem: conversa que casa com as três regras recebe só o toque 1, mesmo que o toque 3 venha antes na tabela', async (s) => {
  const t3 = s.addTemplate('toque_3_encerramento', 'Vou parar de te chamar por aqui.');
  const t1 = s.addTemplate('toque_1', 'Oi, tudo certo?');
  const t2 = s.addTemplate('toque_2', 'Lembrei da nossa conversa.');
  s.addRule({ template_id: t3, delay_hours: 96, sequence_order: 3 });
  s.addRule({ template_id: t1, delay_hours: 24, sequence_order: 1 });
  s.addRule({ template_id: t2, delay_hours: 48, sequence_order: 2 });
  s.addLead({ idleHours: 100 });

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(s.backend.zernioMessages().map(templateName), ['toque_1']);
});

scenarioTest('primeira ativação: conversa que já estava parada quando a regra foi criada fica de fora', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, delay_hours: 24, created_at: hoursAgo(30), updated_at: hoursAgo(30) });
  const antiga = s.addLead({ idleHours: 40, name: 'Antiga' });
  const nova = s.addLead({ idleHours: 26, name: 'Nova' });

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(s.backend.rows('follow_up_log').map((l) => l.contact_id), [nova.contactId]);
  assert.ok(!s.backend.rows('follow_up_log').some((l) => l.contact_id === antiga.contactId));
});

scenarioTest('primeira ativação: religar a regra não alcança quem parou enquanto ela estava desligada', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, delay_hours: 24, created_at: hoursAgo(24 * 90), updated_at: hoursAgo(2) });
  s.addLead({ idleHours: 30 });

  assert.equal((await run()).sent, 0);
});

scenarioTest('teto: conversa parada há 20 dias não recebe o follow-up de 24 horas', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, delay_hours: 24 });
  s.addLead({ idleHours: 24 * 20 });

  assert.equal((await run()).sent, 0);
});

// ---- 3. Quem falou por último e quem está com a conversa ------------------------------

scenarioTest('lead esperando resposta: última mensagem é do lead, o follow-up não sai', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, conseguiu ver minha mensagem?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, lastMessage: 'inbound' });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.equal(s.backend.rows('follow_up_log').length, 0);
});

scenarioTest('lead esperando resposta: nota interna do time não conta como resposta', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, conseguiu ver minha mensagem?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, lastMessage: 'inbound', privateNoteAfter: true });

  assert.equal((await run()).sent, 0);
});

scenarioTest('conversa sem nenhuma mensagem não recebe follow-up de inatividade', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, lastMessage: null });

  assert.equal((await run()).sent, 0);
});

scenarioTest('conversa com uma pessoa do time (human_active ou IA pausada) fica de fora', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, conversation: { status: 'human_active', ai_paused: true } });
  s.addLead({ idleHours: 30, conversation: { status: 'ai_active', ai_paused: true } });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(s.backend.zernioMessages().length, 0);
});

scenarioTest('conversa com o time entra quando a regra declara include_human_active', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, params: { include_human_active: true } });
  s.addLead({ idleHours: 30, conversation: { status: 'human_active', ai_paused: true } });

  assert.equal((await run()).sent, 1);
});

// ---- 4. Variáveis -----------------------------------------------------------------

scenarioTest('template com {{1}}: a variável sai com o primeiro nome, e a conversa guarda o texto montado', async (s) => {
  const templateId = s.addTemplate('toque_1_nome', 'Oi, {{1}}, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, name: 'Maria Silva' });

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['Maria']);
  const saved = s.backend.rows('messages').find((m) => m.sender_type === 'system')!;
  assert.equal(saved.content, 'Oi, Maria, tudo certo?');
});

scenarioTest('template com {{1}} e pessoa sem nome: não envia vazio, avisa e tenta de novo depois', async (s) => {
  const templateId = s.addTemplate('toque_1_nome', 'Oi, {{1}}, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, name: null });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.equal(s.backend.rows('follow_up_log').length, 0);
  assert.match(result.errors.join('\n'), /sem nome/);
});

scenarioTest('template com {{1}} e pessoa sem nome: usa o nome reserva gravado na regra', async (s) => {
  const templateId = s.addTemplate('toque_1_nome', 'Oi, {{1}}, tudo certo?');
  s.addRule({ template_id: templateId, params: { name_fallback: 'tudo bem' } });
  s.addLead({ idleHours: 30, name: '5511988887777' });

  await run();

  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['tudo bem']);
});

scenarioTest('template com mais variáveis do que a regra preenche: a regra inteira é recusada com um aviso só', async (s) => {
  const templateId = s.addTemplate('lembrete', 'Oi, {{1}}, sua conversa é amanhã às {{2}}.');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.addLead({ idleHours: 31 });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /\{\{2\}\}/);
});

scenarioTest('texto livre (UAZAPI): {nome} vira o primeiro nome no envio e na conversa', async (s) => {
  s.addRule({ provider: 'uazapi', message_text: 'Oi, {nome}! Ficou alguma dúvida?' });
  s.addLead({ idleHours: 30, name: 'João Pedro', conversation: { provider: 'uazapi' } });

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.equal(s.backend.uazapiTexts()[0].body.text, 'Oi, João! Ficou alguma dúvida?');
  const saved = s.backend.rows('messages').find((m) => m.sender_type === 'system')!;
  assert.equal(saved.content, 'Oi, João! Ficou alguma dúvida?');
});

// ---- 5. Filtro de tag ---------------------------------------------------------------

scenarioTest('filtro de tag: vale a tag da pessoa e também a tag da oportunidade, que é onde o fluxo coloca', async (s) => {
  const tagId = crypto.randomUUID();
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId, params: { tag_id: tagId } });
  const naPessoa = s.addLead({ idleHours: 30, name: 'Tag na pessoa' });
  const naOportunidade = s.addLead({ idleHours: 30, name: 'Tag na oportunidade' });
  const semTag = s.addLead({ idleHours: 30, name: 'Sem tag' });
  s.backend.seed('contact_tags', { org_id: s.orgId, contact_id: naPessoa.contactId, tag_id: tagId });
  const dealId = s.addDeal(naOportunidade.contactId);
  s.backend.seed('deal_tags', { org_id: s.orgId, deal_id: dealId, tag_id: tagId });
  s.addDeal(semTag.contactId);

  const result = await run();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    s.backend.rows('follow_up_log').map((l) => l.contact_id).sort(),
    [naPessoa.contactId, naOportunidade.contactId].sort(),
  );
});

// ---- Falha de leitura nunca vira envio repetido ----------------------------------------

scenarioTest('se a leitura do registro de envios falhar, a regra não envia nada nesta rodada', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.backend.forcedErrors.push({ method: 'GET', table: 'follow_up_log', status: 414, code: 'PGRST000', message: 'URI too long' });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.match(result.errors.join('\n'), /URI too long/);
});

// ---- Gatilho "sem compra" --------------------------------------------------------------

scenarioTest('sem compra: respeita o horário, preenche o nome e continua alcançando cliente antigo', async (s) => {
  const templateId = s.addTemplate('cliente_sumiu', 'Oi, {{1}}! Faz um tempo que a gente não se fala.');
  s.addRule({ trigger_condition: 'no_purchase', template_id: templateId, delay_hours: 24 * 30, params: { days: 30 } });
  const lead = s.addLead({ idleHours: 24 * 60, name: 'Carla Souza', lastMessage: 'inbound' });
  s.addDeal(lead.contactId, { lead_type: 'Cliente', last_purchase_at: daysAgoDate(45) });
  s.setBusinessHours(hoursClosedNow());

  assert.equal((await run()).sent, 0);

  s.backend.rows('app_settings')[0].business_hours = hoursOpenNow();
  const result = await run();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['Carla']);
});

// ---- A cadência do kit, do começo ao fim ---------------------------------------------

// Faz o tempo passar: a conversa e a nossa última mensagem ficam `hours` no passado.
function letConversationRest(s: Scenario, conversationId: string, hours: number): void {
  const conv = s.backend.rows('conversations').find((c) => c.id === conversationId)!;
  conv.last_message_at = hoursAgo(hours);
  const ours = s.backend.rows('messages')
    .filter((m) => m.conversation_id === conversationId && m.sender_type === 'system');
  if (ours.length > 0) ours[ours.length - 1].created_at = hoursAgo(hours);
}

scenarioTest('cadência de três toques: 24h, depois 48h, depois 96h, e então a plataforma para sozinha', async (s) => {
  const t1 = s.addTemplate('toque_1', 'Oi, tudo certo?');
  const t2 = s.addTemplate('toque_2', 'Lembrei da nossa conversa.');
  const t3 = s.addTemplate('toque_3', 'Vou parar de te chamar por aqui.');
  s.addRule({ template_id: t1, delay_hours: 24, sequence_order: 1 });
  s.addRule({ template_id: t2, delay_hours: 48, sequence_order: 2 });
  s.addRule({ template_id: t3, delay_hours: 96, sequence_order: 3 });
  const lead = s.addLead({ idleHours: 25 });
  const sentSoFar = () => s.backend.zernioMessages().map(templateName);

  await run();
  assert.deepEqual(sentSoFar(), ['toque_1']);

  await run(); // 15 minutos depois nada muda
  assert.deepEqual(sentSoFar(), ['toque_1']);

  letConversationRest(s, lead.conversationId, 49);
  await run();
  assert.deepEqual(sentSoFar(), ['toque_1', 'toque_2']);

  letConversationRest(s, lead.conversationId, 97);
  await run();
  assert.deepEqual(sentSoFar(), ['toque_1', 'toque_2', 'toque_3']);

  letConversationRest(s, lead.conversationId, 97);
  const last = await run();
  assert.deepEqual(sentSoFar(), ['toque_1', 'toque_2', 'toque_3']);
  assert.deepEqual(last.errors, []);
});

scenarioTest('lead que respondeu ao toque 1 e foi atendido segue para o toque 2 quando some de novo', async (s) => {
  const t1 = s.addTemplate('toque_1', 'Oi, tudo certo?');
  const t2 = s.addTemplate('toque_2', 'Lembrei da nossa conversa.');
  const rule1 = s.addRule({ template_id: t1, delay_hours: 24, sequence_order: 1 });
  s.addRule({ template_id: t2, delay_hours: 48, sequence_order: 2 });
  const lead = s.addLead({ idleHours: 50 }); // última mensagem é do atendente
  s.backend.seed('follow_up_log', { org_id: s.orgId, rule_id: rule1, contact_id: lead.contactId, sent_at: hoursAgo(200) });

  await run();

  assert.deepEqual(s.backend.zernioMessages().map(templateName), ['toque_2']);
});

// ---- Canal e falha de envio -----------------------------------------------------------

scenarioTest('conversa de Instagram parada não entra no follow-up de WhatsApp', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30, phone: null, conversation: { channel: 'instagram', zernio_conversation_id: 'ig-conv-1' } });

  const result = await run();

  assert.equal(result.sent, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(s.backend.externalCalls.length, 0);
});

scenarioTest('envio recusado pelo Zernio não entra no registro, e a próxima rodada tenta de novo', async (s) => {
  const templateId = s.addTemplate('toque_1', 'Oi, tudo certo?');
  s.addRule({ template_id: templateId });
  s.addLead({ idleHours: 30 });
  s.backend.zernioSendError = { status: 400, error: 'Required parameter is missing' };

  const failed = await run();
  assert.equal(failed.sent, 0);
  assert.equal(s.backend.rows('follow_up_log').length, 0);
  assert.match(failed.errors.join('\n'), /Required parameter is missing/);

  s.backend.zernioSendError = null;
  assert.equal((await run()).sent, 1);
});
