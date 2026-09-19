// ============================================================================
// O que o comprador recebe: o bundle montado pelo wizard /setup, e não o index.ts
// solto. Este arquivo roda um cenário de cada função a partir do bundle gravado
// por tests/functions/lib/write-wizard-bundles.mjs. Sem os bundles, fica pulado.
//
// Como rodar:
//   npm run test:functions:e2e
// ============================================================================

import assert from 'node:assert/strict';
import { cronRequest, type Handler, loadEdgeHandler } from './lib/fake-backend.ts';
import { newScenario } from './lib/scenario.ts';

const bundleUrl = (slug: string) => new URL(`../.artifacts/edge-bundles/${slug}/index.ts`, import.meta.url);

async function bundleHandler(slug: string): Promise<Handler | null> {
  try {
    await Deno.stat(bundleUrl(slug));
  } catch {
    return null;
  }
  return await loadEdgeHandler(bundleUrl(slug).href);
}

const followUps = await bundleHandler('check-follow-ups');
const funnel = await bundleHandler('funnel-automation');
const textParams = (call: { body: Record<string, unknown> }): string[] => {
  const template = call.body.template as { elements: Array<{ components: Array<{ parameters: Array<{ text: string }> }> }> };
  return (template.elements[0].components[0]?.parameters ?? []).map((p) => p.text);
};

Deno.test({
  name: 'bundle do wizard · check-follow-ups: envia com o primeiro nome e respeita quem está esperando resposta',
  ignore: !followUps,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await newScenario();
    try {
      const templateId = s.addTemplate('toque_1_nome', 'Oi, {{1}}, tudo certo?');
      s.addRule({ template_id: templateId });
      s.addLead({ idleHours: 30, name: 'Maria Silva' });
      s.addLead({ idleHours: 30, name: 'Esperando Resposta', lastMessage: 'inbound' });

      const res = await followUps!(cronRequest('check-follow-ups'));
      const result = await res.json() as { sent: number; errors: string[] };

      assert.deepEqual(result.errors, []);
      assert.equal(result.sent, 1);
      assert.deepEqual(textParams(s.backend.zernioMessages()[0]), ['Maria']);
    } finally {
      s.done();
    }
  },
});

Deno.test({
  name: 'bundle do wizard · funnel-automation: template da etapa sai com o primeiro nome',
  ignore: !funnel,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await newScenario();
    try {
      const lead = s.addLead({ name: 'João Pedro' });
      const templateId = s.addTemplate('boas_vindas', 'Oi, {{1}}, posso te ajudar?');
      const stageId = crypto.randomUUID();
      const pipelineId = crypto.randomUUID();
      const dealId = s.addDeal(lead.contactId, { stage_id: stageId, pipeline_id: pipelineId });
      s.backend.seed('funnel_automations', {
        id: crypto.randomUUID(), org_id: s.orgId, pipeline_id: pipelineId, stage_id: stageId,
        name: 'Boas-vindas', is_active: true, actions: [{ type: 'send_template', template_id: templateId }],
      });

      const res = await funnel!(cronRequest('funnel-automation', { deal_id: dealId, stage_id: stageId }));
      const result = await res.json() as { errors: string[] };

      assert.deepEqual(result.errors, []);
      assert.deepEqual(textParams(s.backend.zernioMessages()[0]), ['João']);
    } finally {
      s.done();
    }
  },
});
