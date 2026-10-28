// ============================================================================
// Remoção de número desativado (src/lib/channel-remove.ts + api/channel-remove.ts)
// ----------------------------------------------------------------------------
// Roda a regra contra um banco de canais em memória. Nenhuma chamada sai da
// máquina.
//
// Como rodar (Node 22.18+):
//   npm run test:api
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../src/lib/channel-remove.ts').catch(() => null);
const skip = mod ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

// Tabela falsa: a busca e o delete sempre filtram por org_id, como o servidor.
function fakeDb(rows) {
  const deleted = [];
  return {
    deleted,
    rows,
    deps: {
      findChannel: async (orgId, id) => {
        const r = rows.find((c) => c.id === id && c.org_id === orgId);
        return r ? { id: r.id, is_active: r.is_active } : null;
      },
      deleteChannel: async (orgId, id) => {
        const i = rows.findIndex((c) => c.id === id && c.org_id === orgId);
        if (i >= 0) {
          deleted.push(id);
          rows.splice(i, 1);
        }
        return null;
      },
    },
  };
}

const seed = () => [
  { id: 'c-off', org_id: 'org-a', is_active: false },
  { id: 'c-on', org_id: 'org-a', is_active: true },
  { id: 'c-b', org_id: 'org-b', is_active: false },
];

test('número desativado da própria organização é apagado', { skip }, async () => {
  const db = fakeDb(seed());
  const r = await mod.removeChannel(db.deps, { orgId: 'org-a', channelId: 'c-off' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.deepEqual(db.deleted, ['c-off']);
  assert.ok(db.rows.some((c) => c.id === 'c-b'), 'outra organização não é tocada');
});

test('número ativo dá 409 e não é apagado', { skip }, async () => {
  const db = fakeDb(seed());
  const r = await mod.removeChannel(db.deps, { orgId: 'org-a', channelId: 'c-on' });
  assert.equal(r.status, 409);
  assert.equal(r.body.message, 'Desative o número antes de remover.');
  assert.deepEqual(db.deleted, []);
});

test('admin de outra organização não apaga o número', { skip }, async () => {
  const db = fakeDb(seed());
  const r = await mod.removeChannel(db.deps, { orgId: 'org-a', channelId: 'c-b' });
  assert.equal(r.status, 404);
  assert.deepEqual(db.deleted, []);
  assert.ok(db.rows.some((c) => c.id === 'c-b'));
});

test('sem channelId a resposta é 400', { skip }, async () => {
  const db = fakeDb(seed());
  const r = await mod.removeChannel(db.deps, { orgId: 'org-a', channelId: '' });
  assert.equal(r.status, 400);
  assert.deepEqual(db.deleted, []);
});
