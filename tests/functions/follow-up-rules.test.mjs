// ============================================================================
// Regras de decisão do motor de follow-up (supabase/functions/_shared/
// follow-up-rules.ts). O módulo é puro: recebe dados e o relógio, devolve a
// decisão. Quem fala com o banco e com o WhatsApp é o index.ts de cada função.
//
// Cobre os cinco riscos levantados em 18-19/09/2026:
//   1. follow-up fora do horário de atendimento
//   2. primeira ativação atingindo o histórico inteiro, em ordem indefinida
//   3. follow-up para quem está esperando resposta ou está com uma pessoa do time
//   4. template e texto livre saindo com a variável vazia
//   5. (a união de tags é consulta, fica nos testes de ponta a ponta)
//
// Como rodar (Node 22.18+, que importa o TypeScript direto):
//   npm run test:functions
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const rules = await import('../../supabase/functions/_shared/follow-up-rules.ts').catch(() => null);
const skip = rules ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

const HOUR = 3600 * 1000;
const iso = (date) => date.toISOString();
const hoursBefore = (now, h) => new Date(now.getTime() - h * HOUR);

// Horário salvo pela tela Atendente IA → Horário de atendimento.
const SEG_A_SEX = {
  mon: { enabled: true, start: '09:00', end: '18:00' },
  tue: { enabled: true, start: '09:00', end: '18:00' },
  wed: { enabled: true, start: '09:00', end: '18:00' },
  thu: { enabled: true, start: '09:00', end: '18:00' },
  fri: { enabled: true, start: '09:00', end: '18:00' },
  sat: { enabled: false, start: '09:00', end: '13:00' },
  sun: { enabled: false, start: '09:00', end: '13:00' },
};
const SP = 'America/Sao_Paulo';

// ---- 1. Horário de atendimento ----------------------------------------------

test('horário: quarta às 3h da manhã em São Paulo está fora do horário', { skip }, () => {
  const now = new Date('2026-09-23T06:00:00Z'); // quarta, 03:00 em SP
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, now), 'closed');
});

test('horário: quarta às 10h30 em São Paulo está dentro do horário', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z'); // quarta, 10:30 em SP
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, now), 'open');
});

test('horário: sábado desligado fica fora do horário mesmo às 10h30', { skip }, () => {
  const now = new Date('2026-09-26T13:30:00Z'); // sábado, 10:30 em SP
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, now), 'closed');
});

test('horário: os limites entram (09:00 e 18:00) e o minuto seguinte sai', { skip }, () => {
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, new Date('2026-09-23T12:00:00Z')), 'open'); // 09:00
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, new Date('2026-09-23T21:00:00Z')), 'open'); // 18:00
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, new Date('2026-09-23T21:01:00Z')), 'closed'); // 18:01
});

test('horário: o fuso da conta decide, o mesmo instante abre em Tóquio e fecha em São Paulo', { skip }, () => {
  const now = new Date('2026-09-23T02:00:00Z'); // terça 23:00 em SP, quarta 11:00 em Tóquio
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, SP, now), 'closed');
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, 'Asia/Tokyo', now), 'open');
});

test('horário: fuso ausente ou inválido cai em America/Sao_Paulo', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z'); // 10:30 em SP
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, null, now), 'open');
  assert.equal(rules.businessHoursStatus(SEG_A_SEX, 'Marte/Olimpo', now), 'open');
});

test('horário: meia-noite e meia conta como 00:30, dentro de um horário de 24 horas', { skip }, () => {
  const diaInteiro = { ...SEG_A_SEX, wed: { enabled: true, start: '00:00', end: '23:59' } };
  const now = new Date('2026-09-23T03:30:00Z'); // quarta, 00:30 em SP
  assert.equal(rules.businessHoursStatus(diaInteiro, SP, now), 'open');
});

test('horário: conta que nunca salvou o horário fica como não configurada', { skip }, () => {
  const now = new Date('2026-09-23T06:00:00Z');
  assert.equal(rules.businessHoursStatus({}, SP, now), 'unconfigured');
  assert.equal(rules.businessHoursStatus(null, SP, now), 'unconfigured');
  assert.equal(rules.businessHoursStatus('lixo', SP, now), 'unconfigured');
});

test('horário: todos os dias desligados também conta como não configurada', { skip }, () => {
  const tudoDesligado = Object.fromEntries(
    Object.entries(SEG_A_SEX).map(([k, v]) => [k, { ...v, enabled: false }]),
  );
  assert.equal(rules.businessHoursStatus(tudoDesligado, SP, new Date('2026-09-23T13:30:00Z')), 'unconfigured');
});

test('horário: dia ligado sem hora de início e fim não vale como horário', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z'); // quarta
  assert.equal(rules.businessHoursStatus({ wed: { enabled: true } }, SP, now), 'unconfigured');
  // Com outro dia válido, a conta tem horário e a quarta malformada fica fechada.
  const comSegunda = { mon: { enabled: true, start: '09:00', end: '18:00' }, wed: { enabled: true } };
  assert.equal(rules.businessHoursStatus(comSegunda, SP, now), 'closed');
});

// ---- 2. Ordem das regras e janela de inatividade ------------------------------

test('ordem: regras saem por conta e por sequence_order, sem mexer na lista original', { skip }, () => {
  const lista = [
    { id: 'b3', org_id: 'org-b', sequence_order: 3, created_at: '2026-09-01T00:00:00Z' },
    { id: 'a2', org_id: 'org-a', sequence_order: 2, created_at: '2026-09-01T00:00:00Z' },
    { id: 'b1', org_id: 'org-b', sequence_order: 1, created_at: '2026-09-01T00:00:00Z' },
    { id: 'a1', org_id: 'org-a', sequence_order: 1, created_at: '2026-09-01T00:00:00Z' },
  ];
  const copia = structuredClone(lista);
  assert.deepEqual(rules.orderRules(lista).map((r) => r.id), ['a1', 'a2', 'b1', 'b3']);
  assert.deepEqual(lista, copia);
});

test('ordem: empate de sequence_order desempata pela regra mais antiga', { skip }, () => {
  const lista = [
    { id: 'nova', org_id: 'org-a', sequence_order: 1, created_at: '2026-09-10T00:00:00Z' },
    { id: 'antiga', org_id: 'org-a', sequence_order: 1, created_at: '2026-09-01T00:00:00Z' },
  ];
  assert.deepEqual(rules.orderRules(lista).map((r) => r.id), ['antiga', 'nova']);
});

test('janela: regra antiga olha de delay_hours até delay_hours + 7 dias de inatividade', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  const rule = { delay_hours: 24, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  assert.deepEqual(rules.inactivityWindow(rule, now), {
    newest: iso(hoursBefore(now, 24)),
    oldest: iso(hoursBefore(now, 24 + rules.MAX_EXTRA_IDLE_HOURS)),
  });
  assert.equal(rules.MAX_EXTRA_IDLE_HOURS, 168);
});

test('janela: regra criada há 30 horas não alcança conversa parada antes de ela existir', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  const criada = iso(hoursBefore(now, 30));
  const rule = { delay_hours: 24, created_at: criada, updated_at: criada };
  assert.deepEqual(rules.inactivityWindow(rule, now), { newest: iso(hoursBefore(now, 24)), oldest: criada });
});

test('janela: regra criada há 10 horas com 24h de espera ainda não tem ninguém para olhar', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  const criada = iso(hoursBefore(now, 10));
  assert.equal(rules.inactivityWindow({ delay_hours: 24, created_at: criada, updated_at: criada }, now), null);
});

test('janela: religar a regra (updated_at) recomeça a contagem como se fosse nova', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  const religada = iso(hoursBefore(now, 26));
  const rule = { delay_hours: 24, created_at: '2026-01-01T00:00:00Z', updated_at: religada };
  assert.deepEqual(rules.inactivityWindow(rule, now), { newest: iso(hoursBefore(now, 24)), oldest: religada });
});

test('janela: regra sem datas legíveis fica só com o teto de 7 dias', { skip }, () => {
  const now = new Date('2026-09-23T13:30:00Z');
  assert.deepEqual(rules.inactivityWindow({ delay_hours: 48, created_at: null, updated_at: 'ontem' }, now), {
    newest: iso(hoursBefore(now, 48)),
    oldest: iso(hoursBefore(now, 48 + 168)),
  });
});

// ---- 3. Quem está com a conversa e quem falou por último ------------------------

const JANELA = { oldest: '2026-09-20T00:00:00.000Z', newest: '2026-09-22T00:00:00.000Z' };
const conversa = (patch = {}) => ({
  status: 'ai_active',
  ai_paused: false,
  last_message_at: '2026-09-21T00:00:00.000Z',
  ...patch,
});

test('conversa: aberta com a IA e parada dentro da janela entra', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa(), JANELA, false), null);
});

test('conversa: fechada fica fora', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa({ status: 'closed' }), JANELA, false), 'closed');
});

test('conversa: com uma pessoa do time (human_active ou IA pausada) fica fora', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa({ status: 'human_active' }), JANELA, false), 'human');
  assert.equal(rules.conversationSkipReason(conversa({ ai_paused: true }), JANELA, false), 'human');
});

test('conversa: a regra pode declarar que quer incluir as conversas com o time', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa({ status: 'human_active', ai_paused: true }), JANELA, true), null);
  assert.equal(rules.includesHumanConversations({ include_human_active: true }), true);
  assert.equal(rules.includesHumanConversations({ include_human_active: 'true' }), false);
  assert.equal(rules.includesHumanConversations({}), false);
  assert.equal(rules.includesHumanConversations(null), false);
});

test('conversa: parada antes ou depois da janela, ou sem data, fica fora', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa({ last_message_at: '2026-09-19T23:59:59.000Z' }), JANELA, false), 'outside_window');
  assert.equal(rules.conversationSkipReason(conversa({ last_message_at: '2026-09-22T00:00:01.000Z' }), JANELA, false), 'outside_window');
  assert.equal(rules.conversationSkipReason(conversa({ last_message_at: null }), JANELA, false), 'outside_window');
});

test('conversa: data com fuso +00:00 (formato do Postgres) compara pelo instante', { skip }, () => {
  assert.equal(rules.conversationSkipReason(conversa({ last_message_at: '2026-09-21T00:00:00+00:00' }), JANELA, false), null);
});

test('última mensagem: só segue quando fomos nós que falamos por último', { skip }, () => {
  assert.equal(rules.lastMessageSkipReason({ direction: 'outbound' }), null);
  assert.equal(rules.lastMessageSkipReason({ direction: 'inbound' }), 'waiting_reply');
  assert.equal(rules.lastMessageSkipReason(null), 'no_messages');
});

// ---- 4. Nome da pessoa e variáveis ---------------------------------------------

test('primeiro nome: pega a primeira palavra do nome salvo em Pessoas', { skip }, () => {
  assert.equal(rules.firstNameOf('Maria Silva'), 'Maria');
  assert.equal(rules.firstNameOf('  João  '), 'João');
});

test('primeiro nome: vazio, telefone ou só emoji não é nome', { skip }, () => {
  assert.equal(rules.firstNameOf(null), '');
  assert.equal(rules.firstNameOf(''), '');
  assert.equal(rules.firstNameOf('5511999998888'), '');
  assert.equal(rules.firstNameOf('+55 11 99999-8888'), '');
  assert.equal(rules.firstNameOf('🌸'), '');
  assert.equal(rules.firstNameOf('.'), '');
});

test('primeiro nome: limpa enfeite em volta e pula emoji solto no começo', { skip }, () => {
  assert.equal(rules.firstNameOf('~Ana'), 'Ana');
  assert.equal(rules.firstNameOf('Maria, mãe do Pedro'), 'Maria');
  assert.equal(rules.firstNameOf('🌸 Bia 🌸'), 'Bia');
  assert.equal(rules.firstNameOf('🌸Bia🌸'), 'Bia');
});

test('primeiro nome: pula o tratamento quando há um nome depois dele', { skip }, () => {
  assert.equal(rules.firstNameOf('Dr. Pedro Alves'), 'Pedro');
  assert.equal(rules.firstNameOf('Dra Carla'), 'Carla');
  assert.equal(rules.firstNameOf('Sra. Lúcia'), 'Lúcia');
  assert.equal(rules.firstNameOf('Dr.'), 'Dr'); // sem nada depois, fica o que tem
});

test('texto livre: {nome} vira o primeiro nome', { skip }, () => {
  assert.equal(rules.renderFreeText('Oi, {nome}! Tudo certo?', 'Maria'), 'Oi, Maria! Tudo certo?');
  assert.equal(rules.renderFreeText('Oi {Nome}, e aí, {NOME}?', 'Maria'), 'Oi Maria, e aí, Maria?');
});

test('texto livre: sem nome, a frase continua natural', { skip }, () => {
  assert.equal(rules.renderFreeText('Oi, {nome}! Tudo certo?', ''), 'Oi! Tudo certo?');
  assert.equal(rules.renderFreeText('Oi, {nome}, tudo bem?', ''), 'Oi, tudo bem?');
  assert.equal(rules.renderFreeText('Oi {nome}, tudo bem?', ''), 'Oi, tudo bem?');
  assert.equal(rules.renderFreeText('{nome}, tudo bem?', ''), 'Tudo bem?');
  assert.equal(rules.renderFreeText('{nome}! Vi que você sumiu.', ''), 'Vi que você sumiu.');
});

test('texto livre: sem {nome} o texto sai como foi escrito', { skip }, () => {
  const texto = 'Oi, tudo certo? Passei para saber se ficou alguma dúvida.';
  assert.equal(rules.renderFreeText(texto, 'Maria'), texto);
  assert.equal(rules.renderFreeText(texto, ''), texto);
  assert.equal(rules.renderFreeText('Use {cupom} no site', 'Maria'), 'Use {cupom} no site');
});

test('variáveis: conta as variáveis diferentes do corpo e monta a prévia', { skip }, () => {
  assert.equal(rules.countVariables('Oi, tudo certo?'), 0);
  assert.equal(rules.countVariables('Oi, {{1}}, tudo certo, {{1}}?'), 1);
  assert.equal(rules.countVariables('Oi, {{1}}, amanhã às {{ 2 }}.'), 2);
  assert.equal(rules.renderPreview('Oi, {{1}}, amanhã às {{ 2 }}.', ['Maria', '10h']), 'Oi, Maria, amanhã às 10h.');
  assert.equal(rules.renderPreview('Oi, {{1}}, amanhã às {{2}}.', ['Maria']), 'Oi, Maria, amanhã às {{2}}.');
});

test('template: sem variável não precisa de parâmetro', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Oi, tudo certo?', undefined, ''), { ok: true, values: [] });
});

test('template: {{1}} recebe o primeiro nome da pessoa', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, tudo certo?', undefined, 'Maria'), { ok: true, values: ['Maria'] });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{ 1 }}, tudo certo?', [], 'Maria'), { ok: true, values: ['Maria'] });
});

test('template: pessoa sem nome usa o nome reserva da regra, e sem reserva o envio é recusado', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, tudo certo?', undefined, '', 'tudo bem'), { ok: true, values: ['tudo bem'] });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, tudo certo?', undefined, ''), { ok: false, reason: 'missing_name', index: 1 });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, tudo certo?', undefined, '', '   '), { ok: false, reason: 'missing_name', index: 1 });
});

test('template: valor fixo gravado na regra (template_params) continua valendo', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, tudo certo?', ['cliente'], 'Maria'), { ok: true, values: ['cliente'] });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, às {{2}}.', [null, '10h'], 'Maria'), { ok: true, values: ['Maria', '10h'] });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, às {{2}}.', ['', '10h'], 'Maria'), { ok: true, values: ['Maria', '10h'] });
});

test('template: valor fixo aceita {nome} e é recusado quando a pessoa está sem nome', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Olá {{1}}.', ['querida {nome}'], 'Maria'), { ok: true, values: ['querida Maria'] });
  assert.deepEqual(rules.resolveTemplateParams('Olá {{1}}.', ['querida {nome}'], ''), { ok: false, reason: 'missing_name', index: 1 });
  assert.deepEqual(rules.resolveTemplateParams('Olá {{1}}.', ['querida {nome}'], '', 'cliente'), { ok: true, values: ['querida cliente'] });
});

test('template: variável sem valor nunca sai vazia, o envio é recusado', { skip }, () => {
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, às {{2}}.', undefined, 'Maria'), { ok: false, reason: 'unmapped', index: 2 });
  assert.deepEqual(rules.resolveTemplateParams('Oi, {{1}}, às {{2}}.', ['x'], 'Maria'), { ok: false, reason: 'unmapped', index: 2 });
});

test('template: a regra sabe antes de enviar quais variáveis ela não preenche', { skip }, () => {
  assert.deepEqual(rules.unfillableVariables('Oi, tudo certo?', undefined), []);
  assert.deepEqual(rules.unfillableVariables('Oi, {{1}}, tudo certo?', undefined), []);
  assert.deepEqual(rules.unfillableVariables('Oi, {{1}}, às {{2}} do dia {{3}}.', undefined), [2, 3]);
  assert.deepEqual(rules.unfillableVariables('Oi, {{1}}, às {{2}} do dia {{3}}.', [null, '10h']), [3]);
  assert.deepEqual(rules.unfillableVariables('Oi, {{1}}, às {{2}}.', 'lixo'), [2]);
});
