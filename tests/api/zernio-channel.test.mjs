// ============================================================================
// Número oficial da Zernio vira canal da organização (src/lib/zernio-channel.ts)
// ----------------------------------------------------------------------------
// A tela Configurações > Canais lista as linhas de whatsapp_hub.channels. A
// conexão da Zernio (api/zernio-connect) guardava a conta só nas credenciais,
// então o número oficial nunca aparecia e o vínculo de operador e a IA por
// número não valiam para ele. Aqui a gravação do canal roda contra uma tabela
// em memória com as mesmas regras do banco: provider + zernio_account_id
// obrigatórios e uma linha por (org_id, provider, zernio_account_id).
//
// Como rodar:
//   npm run test:api
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncZernioChannel } from '../../src/lib/zernio-channel.ts';

// Tabela de canais em memória, com a resposta no formato do supabase-js.
function channelsTable({ raceOnInsert = null } = {}) {
  const rows = [];
  let seq = 0;
  const builder = () => {
    const filters = [];
    let op = 'select';
    let patch = null;
    let inserted = null;
    const matching = () => rows.filter((row) => filters.every(([col, val]) => row[col] === val));
    const run = (mode) => {
      if (op === 'update') {
        for (const row of matching()) Object.assign(row, patch);
        return { data: null, error: null };
      }
      if (op === 'insert') {
        if (raceOnInsert) {
          rows.push({ ...raceOnInsert });
          raceOnInsert = null;
        }
        const clash = rows.find((row) => row.org_id === inserted.org_id && row.provider === inserted.provider
          && row.zernio_account_id === inserted.zernio_account_id);
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "channels_zernio_account_unique"' } };
        if (inserted.provider === 'zernio' && !inserted.zernio_account_id) {
          return { data: null, error: { code: '23514', message: 'violates check constraint "channels_provider_shape"' } };
        }
        const row = {
          id: `canal-${++seq}`, is_active: true, ai_enabled: true, assigned_member: null, phone: null, ...inserted,
        };
        rows.push(row);
        return { data: mode === 'single' ? { id: row.id } : [{ id: row.id }], error: null };
      }
      const found = matching();
      if (mode === 'maybe') {
        if (found.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
        return { data: found[0] ?? null, error: null };
      }
      return { data: found, error: null };
    };
    const b = {
      select() { return b; },
      eq(col, val) { filters.push([col, val]); return b; },
      update(p) { op = 'update'; patch = p; return b; },
      insert(r) { op = 'insert'; inserted = r; return b; },
      maybeSingle() { return Promise.resolve(run('maybe')); },
      single() { return Promise.resolve(run('single')); },
      then(resolve, reject) { return Promise.resolve(run('many')).then(resolve, reject); },
    };
    return b;
  };
  // Mesmo formato do cliente do supabase-js: db.schema('whatsapp_hub').from('channels').
  const db = { schema: () => ({ from: () => builder() }) };
  return { db, rows };
}

const account = (id, name = 'Conta Zernio') => ({ id, name });
const info = (phone, verifiedName = null) => ({
  display_phone_number: phone, verified_name: verifiedName,
  messaging_limit_tier: null, quality_rating: null, health_status: null,
});

test('primeira conexão grava o número oficial como canal ativo da organização', async () => {
  const t = channelsTable();
  const result = await syncZernioChannel(t.db, {
    orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+55 11 99000-0001', 'Escola Contraluz'),
  });
  assert.equal(result.created, true);
  assert.equal(t.rows.length, 1);
  const [row] = t.rows;
  assert.equal(row.id, result.channelId);
  assert.equal(row.org_id, 'org-a');
  assert.equal(row.provider, 'zernio');
  assert.equal(row.zernio_account_id, 'zacc-1');
  assert.equal(row.phone, '+55 11 99000-0001');
  assert.equal(row.label, 'Escola Contraluz');
  assert.equal(row.is_active, true);
});

test('sem nome verificado o rótulo usa o nome da conta e, sem ele, WhatsApp oficial', async () => {
  const t = channelsTable();
  await syncZernioChannel(t.db, { orgId: 'org-a', account: account('zacc-1', 'Comercial'), numberInfo: null });
  await syncZernioChannel(t.db, { orgId: 'org-a', account: account('zacc-2', '  '), numberInfo: info(null) });
  assert.equal(t.rows[0].label, 'Comercial');
  assert.equal(t.rows[0].phone, null);
  assert.equal(t.rows[1].label, 'WhatsApp oficial');
});

test('reconectar atualiza o telefone e mantém o que a equipe ajustou no canal', async () => {
  const t = channelsTable();
  const first = await syncZernioChannel(t.db, {
    orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+55 11 99000-0001', 'Escola Contraluz'),
  });
  Object.assign(t.rows[0], { label: 'Atendimento', is_active: false, ai_enabled: false, assigned_member: 'user-1' });

  const again = await syncZernioChannel(t.db, {
    orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+55 11 99000-0009', 'Escola Contraluz'),
  });
  assert.equal(again.created, false);
  assert.equal(again.channelId, first.channelId);
  assert.equal(t.rows.length, 1);
  assert.deepEqual(
    { phone: t.rows[0].phone, label: t.rows[0].label, is_active: t.rows[0].is_active,
      ai_enabled: t.rows[0].ai_enabled, assigned_member: t.rows[0].assigned_member },
    { phone: '+55 11 99000-0009', label: 'Atendimento', is_active: false, ai_enabled: false, assigned_member: 'user-1' },
  );
});

test('outra conta da mesma chave vira outro canal', async () => {
  const t = channelsTable();
  await syncZernioChannel(t.db, { orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+5511990000001') });
  await syncZernioChannel(t.db, { orgId: 'org-a', account: account('zacc-2'), numberInfo: info('+5511990000002') });
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows.map((r) => r.zernio_account_id), ['zacc-1', 'zacc-2']);
});

test('a mesma conta em outra organização é outro canal', async () => {
  const t = channelsTable();
  await syncZernioChannel(t.db, { orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+5511990000001') });
  await syncZernioChannel(t.db, { orgId: 'org-b', account: account('zacc-1'), numberInfo: info('+5511990000001') });
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows.map((r) => r.org_id), ['org-a', 'org-b']);
});

test('se outro pedido gravou o mesmo canal no meio do caminho, devolve o canal que ficou', async () => {
  const t = channelsTable({
    raceOnInsert: { id: 'canal-do-outro-pedido', org_id: 'org-a', provider: 'zernio', zernio_account_id: 'zacc-1',
      label: 'Escola Contraluz', phone: '+5511990000001', is_active: true },
  });
  const result = await syncZernioChannel(t.db, {
    orgId: 'org-a', account: account('zacc-1'), numberInfo: info('+5511990000001', 'Escola Contraluz'),
  });
  assert.equal(result.created, false);
  assert.equal(result.channelId, 'canal-do-outro-pedido');
  assert.equal(t.rows.length, 1);
});
