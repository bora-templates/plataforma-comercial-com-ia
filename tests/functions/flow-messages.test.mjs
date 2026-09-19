// ============================================================================
// Avisos das telas Fluxos → Follow-ups e Fluxos → Oportunidades (src/lib/
// flow-messages.ts). A tela precisa concordar com o motor: o que o motor recusa
// enviar, a tela não deixa salvar.
//
// Como rodar (Node 22.18+):
//   npm run test:functions
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const ui = await import('../../src/lib/flow-messages.ts').catch(() => null);
const engine = await import('../../supabase/functions/_shared/follow-up-rules.ts').catch(() => null);
const skip = ui && engine ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

test('tela: template sem variável ou só com {{1}} pode ser usado em fluxo', { skip }, () => {
  assert.deepEqual(ui.unfilledFlowVariables('Oi, tudo certo?'), []);
  assert.deepEqual(ui.unfilledFlowVariables('Oi, {{1}}, tudo certo?'), []);
  assert.equal(ui.usesNameVariable('Oi, tudo certo?'), false);
  assert.equal(ui.usesNameVariable('Oi, {{ 1 }}, tudo certo?'), true);
});

test('tela: template com {{2}} em diante é apontado, porque o fluxo só preenche a {{1}}', { skip }, () => {
  assert.deepEqual(ui.unfilledFlowVariables('Oi, {{1}}, amanhã às {{2}} do dia {{3}}.'), [2, 3]);
  assert.deepEqual(ui.unfilledFlowVariables(null), []);
});

test('tela e motor concordam sobre quais variáveis ficam sem valor', { skip }, () => {
  for (const body of ['Oi!', 'Oi, {{1}}!', 'Oi, {{1}}, às {{2}}.', '{{1}} {{2}} {{3}} {{2}}', 'Dia {{ 2 }} para {{1}}']) {
    assert.deepEqual(ui.unfilledFlowVariables(body), engine.unfillableVariables(body, undefined), body);
  }
});

test('tela e motor concordam sobre o que é horário de atendimento configurado', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  const casos = [
    {},
    null,
    { wed: { enabled: true } },
    { wed: { enabled: false, start: '09:00', end: '18:00' } },
    { wed: { enabled: true, start: '09:00', end: '18:00' } },
    { sun: { enabled: true, start: '09:00', end: '13:00' } },
  ];
  for (const hours of casos) {
    const engineSays = engine.businessHoursStatus(hours, 'America/Sao_Paulo', now) !== 'unconfigured';
    assert.equal(ui.hasBusinessHours(hours), engineSays, JSON.stringify(hours));
  }
});
