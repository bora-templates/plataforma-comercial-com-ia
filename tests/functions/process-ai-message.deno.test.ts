// ============================================================================
// process-ai-message de ponta a ponta, só o portão que decide se a IA responde.
// O handler de verdade roda contra o PostgREST de mentira (tests/functions/lib).
//
// Modo de teste da IA: com ai_agent_config.test_mode ligado, só o contato cujo
// número está em test_allowlist passa pelo portão. O resto vai para o
// atendimento humano (human_active + ai_paused), como a IA desligada.
//
// Quem passa pelo portão para na falta da chave da OpenAI (o cenário não tem
// credencial de LLM), então nenhum teste chama provedor de IA.
//
// Como rodar:
//   npm run test:functions:e2e
// ============================================================================

import assert from 'node:assert/strict';
import { cronRequest, loadEdgeHandler, type Row, SCHEMA } from './lib/fake-backend.ts';
import { newScenario, type Scenario } from './lib/scenario.ts';

const handler = await loadEdgeHandler(
  new URL('../../supabase/functions/process-ai-message/index.ts', import.meta.url).href,
);

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

function setAgent(s: Scenario, patch: Row): void {
  s.backend.seed('ai_agent_config', {
    id: crypto.randomUUID(), org_id: s.orgId, is_active: true, active_whatsapp: true, active_instagram: true,
    auto_move_leads: false, timezone: 'America/Sao_Paulo', ...patch,
  });
}

// Contato com uma mensagem nova dele, que é o que dispara a função.
function inbound(s: Scenario, opts: { phone?: string | null; channel?: string } = {}): {
  conversationId: string; messageId: string;
} {
  const { conversationId } = s.addLead({
    phone: opts.phone === undefined ? '+5511999990000' : opts.phone,
    lastMessage: null,
    idleHours: 0,
    conversation: { channel: opts.channel ?? 'whatsapp' },
  });
  const messageId = crypto.randomUUID();
  s.backend.seed('messages', {
    id: messageId, org_id: s.orgId, conversation_id: conversationId, direction: 'inbound', sender_type: 'contact',
    content_type: 'text', content: 'Oi, quero saber o preço', is_private_note: false,
    created_at: new Date().toISOString(),
  });
  return { conversationId, messageId };
}

async function run(messageId: string): Promise<{ status: number; body: Row }> {
  const res = await handler(cronRequest('process-ai-message', { message_id: messageId }));
  return { status: res.status, body: await res.json() as Row };
}

const conversation = (s: Scenario, id: string): Row =>
  s.backend.rows('conversations').find((c) => c.id === id) as Row;

// Passou pelo portão: a função seguiu e parou na chave da OpenAI que falta.
function passedTheGate(res: { status: number; body: Row }): void {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error), /openai_api_key/);
}

scenarioTest('agente desligado: a conversa vai para o atendimento humano, como antes', async (s) => {
  setAgent(s, { is_active: false });
  const { conversationId, messageId } = inbound(s);
  const res = await run(messageId);
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, 'ai agent disabled');
  assert.equal(conversation(s, conversationId).status, 'human_active');
  assert.equal(conversation(s, conversationId).ai_paused, true);
});

scenarioTest('modo de teste ligado: contato fora da lista vai para o atendimento humano', async (s) => {
  setAgent(s, { test_mode: true, test_allowlist: ['+55 21 98888-7777'] });
  const { conversationId, messageId } = inbound(s, { phone: '+5511999990000' });
  const res = await run(messageId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.skipped, 'ai test mode: contact not in allowlist');
  assert.equal(res.body.routed_to_human, true);
  assert.equal(conversation(s, conversationId).status, 'human_active');
  assert.equal(conversation(s, conversationId).ai_paused, true);
});

scenarioTest('modo de teste ligado com lista vazia: ninguém passa', async (s) => {
  setAgent(s, { test_mode: true, test_allowlist: [] });
  const { conversationId, messageId } = inbound(s);
  const res = await run(messageId);
  assert.equal(res.body.skipped, 'ai test mode: contact not in allowlist');
  assert.equal(conversation(s, conversationId).status, 'human_active');
});

scenarioTest('modo de teste ligado: número da lista passa, mesmo sem o nono dígito e sem o 55', async (s) => {
  setAgent(s, { test_mode: true, test_allowlist: ['(11) 9999-0000'] });
  const { conversationId, messageId } = inbound(s, { phone: '+5511999990000' });
  passedTheGate(await run(messageId));
  assert.equal(conversation(s, conversationId).status, 'ai_active');
  assert.equal(conversation(s, conversationId).ai_paused, false);
});

scenarioTest('modo de teste ligado: conversa do Instagram vai para o atendimento humano', async (s) => {
  setAgent(s, { test_mode: true, test_allowlist: ['+5511999990000'] });
  const { conversationId, messageId } = inbound(s, { phone: null, channel: 'instagram' });
  const res = await run(messageId);
  assert.equal(res.body.skipped, 'ai test mode: contact not in allowlist');
  assert.equal(conversation(s, conversationId).status, 'human_active');
});

scenarioTest('modo de teste desligado: todo contato passa, como antes', async (s) => {
  setAgent(s, { test_mode: false, test_allowlist: ['+55 21 98888-7777'] });
  const { conversationId, messageId } = inbound(s, { phone: '+5511999990000' });
  passedTheGate(await run(messageId));
  assert.equal(conversation(s, conversationId).status, 'ai_active');
});

// ---- Leitura da configuração do agente --------------------------------------------

const agentReads = (s: Scenario): string[] =>
  s.backend.restLog.filter((line) => line.startsWith('GET whatsapp_hub.ai_agent_config'));

scenarioTest('banco sem a migration (coluna inexistente): relê sem as colunas e a IA segue sem modo de teste', async (s) => {
  const def = SCHEMA['whatsapp_hub.ai_agent_config'];
  const original = [...def.columns];
  def.columns = original.filter((c) => c !== 'test_mode' && c !== 'test_allowlist');
  try {
    setAgent(s, {});
    const { conversationId, messageId } = inbound(s);
    passedTheGate(await run(messageId));
    assert.equal(agentReads(s).length, 2);
    assert.equal(conversation(s, conversationId).status, 'ai_active');
  } finally {
    def.columns = original;
  }
});

scenarioTest('erro de leitura que não é coluna inexistente: não relê e a conversa vai para o humano', async (s) => {
  setAgent(s, { test_mode: true, test_allowlist: ['+55 21 98888-7777'] });
  s.backend.forcedErrors.push({
    method: 'GET', table: 'ai_agent_config', status: 500, code: '57014', message: 'canceling statement due to statement timeout',
  });
  const { conversationId, messageId } = inbound(s, { phone: '+5511999990000' });
  const res = await run(messageId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.routed_to_human, true);
  assert.equal(agentReads(s).length, 1);
  assert.equal(conversation(s, conversationId).status, 'human_active');
  assert.equal(conversation(s, conversationId).ai_paused, true);
});
