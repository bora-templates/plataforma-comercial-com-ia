// ============================================================================
// Modo de teste da IA (supabase/functions/_shared/ai-test-mode.ts e a cópia da
// tela em src/lib/ai-test-mode.ts).
// ----------------------------------------------------------------------------
// Com ai_agent_config.test_mode ligado, a IA só conversa com os números de
// test_allowlist. Os outros contatos vão para o atendimento humano, como se a
// IA estivesse desligada para eles. O número casa só pelos dígitos, com a regra
// do Brasil para o nono dígito, e o número digitado sem o 55 ganha o 55.
//
// O contato do Instagram não tem nome de usuário gravado no banco
// (contacts.instagram_id guarda o id do remetente que a Zernio manda), então a
// lista aceita só números de WhatsApp e o contato do Instagram nunca casa.
//
// Como rodar (Node 22.18+, que importa o TypeScript direto):
//   npm run test:functions
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const engine = await import('../../supabase/functions/_shared/ai-test-mode.ts').catch(() => null);
const ui = await import('../../src/lib/ai-test-mode.ts').catch(() => null);
const skip = engine && ui ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

const on = (list) => ({ test_mode: true, test_allowlist: list });

test('modo desligado libera todos os contatos', { skip }, () => {
  assert.equal(engine.aiTestModeAllows({ test_mode: false, test_allowlist: [] }, { phone: '+5511999990000' }), true);
  assert.equal(engine.aiTestModeAllows({ test_mode: false, test_allowlist: ['11988887777'] }, { phone: '+5511999990000' }), true);
  // Instalação que ainda não rodou a migration: as colunas não vêm.
  assert.equal(engine.aiTestModeAllows({}, { phone: '+5511999990000' }), true);
  assert.equal(engine.aiTestModeAllows(null, { phone: null }), true);
});

test('modo ligado com lista vazia nega todos', { skip }, () => {
  assert.equal(engine.aiTestModeAllows(on([]), { phone: '+5511999990000' }), false);
  assert.equal(engine.aiTestModeAllows({ test_mode: true, test_allowlist: null }, { phone: '+5511999990000' }), false);
  assert.equal(engine.aiTestModeAllows(on([]), { phone: null }), false);
});

test('número da lista casa com o contato, com ou sem o nono dígito', { skip }, () => {
  // Lista com o nono dígito, contato gravado sem ele (WhatsApp antigo) e vice-versa.
  assert.equal(engine.aiTestModeAllows(on(['+55 11 99999-0000']), { phone: '+5511999990000' }), true);
  assert.equal(engine.aiTestModeAllows(on(['+55 11 99999-0000']), { phone: '+551199990000' }), true);
  assert.equal(engine.aiTestModeAllows(on(['551199990000']), { phone: '+5511999990000' }), true);
  // DDD diferente não casa, mesmo com os 8 últimos iguais.
  assert.equal(engine.aiTestModeAllows(on(['5511999990000']), { phone: '+5521999990000' }), false);
  // Outro número não casa.
  assert.equal(engine.aiTestModeAllows(on(['5511999990000']), { phone: '+5511999990001' }), false);
});

test('número digitado sem o 55 ganha o 55', { skip }, () => {
  assert.equal(engine.aiTestModeAllows(on(['(11) 99999-0000']), { phone: '+5511999990000' }), true);
  assert.equal(engine.aiTestModeAllows(on(['11 9999-0000']), { phone: '+5511999990000' }), true);
  assert.equal(engine.aiTestModeAllows(on(['1199990000']), { phone: '+551199990000' }), true);
});

test('número de fora do Brasil compara os dígitos inteiros', { skip }, () => {
  // Com o +, o número é internacional e não ganha o 55.
  assert.equal(engine.aiTestModeAllows(on(['+1 212 555 1234']), { phone: '+12125551234' }), true);
  assert.equal(engine.aiTestModeAllows(on(['+351 912 345 678']), { phone: '+351912345678' }), true);
  assert.equal(engine.aiTestModeAllows(on(['+351 912 345 678']), { phone: '+351912345679' }), false);
  // Sem a regra do nono dígito fora do Brasil.
  assert.equal(engine.aiTestModeAllows(on(['+351 912 345 678']), { phone: '+35112345678' }), false);
});

test('contato do Instagram (sem telefone) nunca casa com o modo ligado', { skip }, () => {
  assert.equal(engine.aiTestModeAllows(on(['5511999990000']), { phone: null }), false);
  // Um @ que tenha ficado no banco não libera ninguém.
  assert.equal(engine.aiTestModeAllows(on(['@lojateste']), { phone: null }), false);
});

test('chave do número: regra do Brasil e limites', { skip }, () => {
  assert.equal(engine.allowlistPhoneKey('+55 11 99999-0000'), engine.allowlistPhoneKey('551199990000'));
  assert.equal(engine.allowlistPhoneKey('11999990000'), engine.allowlistPhoneKey('+5511999990000'));
  assert.equal(engine.allowlistPhoneKey('123'), null);
  assert.equal(engine.allowlistPhoneKey('1234567890123456'), null);
  assert.equal(engine.allowlistPhoneKey('@lojateste'), null);
  assert.equal(engine.allowlistPhoneKey(''), null);
});

test('validação: aceita até 20 números de 10 a 15 dígitos, um por linha', { skip }, () => {
  const ok = engine.validateTestAllowlist('  +55 11 99999-0000 \n\n(21) 98888-7777\n+1 212 555 1234\n');
  assert.equal(ok.error, null);
  assert.deepEqual(ok.items, ['+55 11 99999-0000', '(21) 98888-7777', '+1 212 555 1234']);

  assert.deepEqual(engine.validateTestAllowlist(''), { items: [], error: null });

  const vinte = Array.from({ length: 20 }, (_, i) => `119999900${String(i).padStart(2, '0')}`).join('\n');
  assert.equal(engine.validateTestAllowlist(vinte).error, null);
  const vinteEUm = `${vinte}\n11999990099`;
  assert.match(engine.validateTestAllowlist(vinteEUm).error, /20/);
});

test('validação: recusa número curto, longo, texto solto e @', { skip }, () => {
  assert.match(engine.validateTestAllowlist('119999').error, /119999/);
  assert.match(engine.validateTestAllowlist('+55 11 99999-0000 1234 5').error, /número/);
  assert.match(engine.validateTestAllowlist('fulano').error, /fulano/);
  assert.match(engine.validateTestAllowlist('@lojateste').error, /WhatsApp/);
});

test('validação: número repetido entra uma vez só', { skip }, () => {
  const r = engine.validateTestAllowlist('11 99999-0000\n+5511999990000\n551199990000');
  assert.equal(r.error, null);
  assert.deepEqual(r.items, ['11 99999-0000']);
});

test('tela e motor concordam sobre a validação e a chave do número', { skip }, () => {
  const casos = [
    '',
    '11 99999-0000',
    '+55 11 99999-0000\n(21) 98888-7777',
    '+1 212 555 1234',
    '119999',
    '@lojateste',
    'fulano',
    '11 99999-0000\n+5511999990000',
    Array.from({ length: 21 }, (_, i) => `119999900${String(i).padStart(2, '0')}`).join('\n'),
  ];
  for (const texto of casos) {
    assert.deepEqual(ui.validateTestAllowlist(texto), engine.validateTestAllowlist(texto), texto);
  }
  for (const n of ['+55 11 99999-0000', '1199990000', '+12125551234', '123', '@x']) {
    assert.equal(ui.allowlistPhoneKey(n), engine.allowlistPhoneKey(n), n);
  }
  assert.equal(ui.AI_TEST_ALLOWLIST_MAX, engine.AI_TEST_ALLOWLIST_MAX);
});
