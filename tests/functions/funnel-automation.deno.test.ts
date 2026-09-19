// ============================================================================
// funnel-automation de ponta a ponta: o handler de verdade roda contra um
// PostgREST e um Zernio de mentira (tests/functions/lib). Cobre as ações que
// mandam mensagem quando a oportunidade entra numa etapa.
//
// Como rodar:
//   npm run test:functions:e2e
// ============================================================================

import assert from 'node:assert/strict';
import { cronRequest, loadEdgeHandler } from './lib/fake-backend.ts';
import { newScenario, type Scenario } from './lib/scenario.ts';

const handler = await loadEdgeHandler(
  new URL('../../supabase/functions/funnel-automation/index.ts', import.meta.url).href,
);

interface RunResult {
  ok: boolean;
  executed?: number;
  errors?: string[];
}

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

// Uma oportunidade que acabou de entrar na etapa, com uma automação ativa nela.
async function enterStage(s: Scenario, actions: unknown[], lead: { contactId: string }): Promise<RunResult> {
  const stageId = crypto.randomUUID();
  const pipelineId = crypto.randomUUID();
  const dealId = s.addDeal(lead.contactId, { stage_id: stageId, pipeline_id: pipelineId });
  s.backend.seed('funnel_automations', {
    id: crypto.randomUUID(), org_id: s.orgId, pipeline_id: pipelineId, stage_id: stageId,
    name: 'Automação de teste', is_active: true, actions,
  });
  const res = await handler(cronRequest('funnel-automation', { deal_id: dealId, stage_id: stageId }));
  assert.equal(res.status, 200);
  return await res.json() as RunResult;
}

const templateParams = (call: { body: Record<string, unknown> }): string[] => {
  const template = call.body.template as { elements: Array<{ components: Array<{ parameters: Array<{ text: string }> }> }> };
  return (template.elements[0].components[0]?.parameters ?? []).map((p) => p.text);
};

// ---- Comportamento que já existia e precisa continuar ------------------------------

scenarioTest('adicionar tag: a tag vai para a oportunidade', async (s) => {
  const lead = s.addLead();
  const tagId = crypto.randomUUID();

  const result = await enterStage(s, [{ type: 'add_tag', tag_id: tagId }], lead);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(s.backend.rows('deal_tags').map((t) => t.tag_id), [tagId]);
});

scenarioTest('disparar template sem variável: envia e grava na conversa', async (s) => {
  const lead = s.addLead();
  const templateId = s.addTemplate('confirmacao', 'A sua conversa com a equipe está confirmada.');

  const result = await enterStage(s, [{ type: 'send_template', template_id: templateId }], lead);

  assert.deepEqual(result.errors, []);
  assert.equal(s.backend.zernioMessages().length, 1);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), []);
  const saved = s.backend.rows('messages').find((m) => m.sender_type === 'system')!;
  assert.equal(saved.content, 'A sua conversa com a equipe está confirmada.');
});

// ---- Variáveis ------------------------------------------------------------------------

scenarioTest('disparar template com {{1}}: a variável sai com o primeiro nome', async (s) => {
  const lead = s.addLead({ name: 'Maria Silva' });
  const templateId = s.addTemplate('boas_vindas', 'Oi, {{1}}, aqui é a Tati. Posso te ajudar?');

  const result = await enterStage(s, [{ type: 'send_template', template_id: templateId }], lead);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['Maria']);
  const saved = s.backend.rows('messages').find((m) => m.sender_type === 'system')!;
  assert.equal(saved.content, 'Oi, Maria, aqui é a Tati. Posso te ajudar?');
});

scenarioTest('disparar template com variável sem valor: não envia vazio e explica o motivo', async (s) => {
  const lead = s.addLead({ name: 'Maria Silva' });
  const templateId = s.addTemplate('lembrete', 'Oi, {{1}}, sua conversa é amanhã às {{2}}.');

  const result = await enterStage(s, [{ type: 'send_template', template_id: templateId }], lead);

  assert.equal(s.backend.zernioMessages().length, 0);
  assert.match((result.errors ?? []).join('\n'), /send_template.*\{\{2\}\}/);
});

scenarioTest('disparar template: valor fixo gravado na ação preenche as outras variáveis', async (s) => {
  const lead = s.addLead({ name: 'Maria Silva' });
  const templateId = s.addTemplate('lembrete', 'Oi, {{1}}, sua conversa é amanhã às {{2}}.');

  const result = await enterStage(s, [{ type: 'send_template', template_id: templateId, params: [null, '10h'] }], lead);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['Maria', '10h']);
});

scenarioTest('disparar template com {{1}} e pessoa sem nome: recusa, e aceita o nome reserva da ação', async (s) => {
  const semNome = s.addLead({ name: null });
  const templateId = s.addTemplate('boas_vindas', 'Oi, {{1}}, posso te ajudar?');

  const refused = await enterStage(s, [{ type: 'send_template', template_id: templateId }], semNome);
  assert.equal(s.backend.zernioMessages().length, 0);
  assert.match((refused.errors ?? []).join('\n'), /sem nome/);

  const outro = s.addLead({ name: '🌸' });
  const ok = await enterStage(s, [{ type: 'send_template', template_id: templateId, name_fallback: 'tudo bem' }], outro);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(templateParams(s.backend.zernioMessages()[0]), ['tudo bem']);
});

scenarioTest('disparar mensagem de texto: {nome} vira o primeiro nome no envio e na conversa', async (s) => {
  const lead = s.addLead({ name: 'João Pedro' });

  const result = await enterStage(s, [{ type: 'send_text', text: 'Oi, {nome}! Que bom te ver por aqui.' }], lead);

  assert.deepEqual(result.errors, []);
  assert.equal(s.backend.zernioMessages()[0].body.message, 'Oi, João! Que bom te ver por aqui.');
  const saved = s.backend.rows('messages').find((m) => m.sender_type === 'system')!;
  assert.equal(saved.content, 'Oi, João! Que bom te ver por aqui.');
});

scenarioTest('disparar mensagem de texto para pessoa sem nome: a frase continua natural', async (s) => {
  const lead = s.addLead({ name: null });

  await enterStage(s, [{ type: 'send_text', text: 'Oi, {nome}! Que bom te ver por aqui.' }], lead);

  assert.equal(s.backend.zernioMessages()[0].body.message, 'Oi! Que bom te ver por aqui.');
});
