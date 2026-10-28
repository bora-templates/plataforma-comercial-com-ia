// ============================================================================
// Modo de teste da IA: colunas test_mode e test_allowlist em ai_agent_config.
// ----------------------------------------------------------------------------
// O default é desligado e com a lista vazia, para nada mudar em quem já está no
// ar nem na organização nova. A lista aceita no máximo 20 números, e rodar a
// migration duas vezes não dá erro.
//
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado) com a tabela do
// agente reduzida ao que a migration toca.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/modo-de-teste-da-ia.test.mjs
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATION = 'supabase/migrations/20261028120000_modo_de_teste_da_ia.sql';

const FIXTURE = `
CREATE SCHEMA whatsapp_hub;
CREATE TABLE whatsapp_hub.ai_agent_config (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL UNIQUE,
  is_active        BOOLEAN DEFAULT true,
  active_whatsapp  BOOLEAN NOT NULL DEFAULT true,
  active_instagram BOOLEAN NOT NULL DEFAULT false
);
`;

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';

async function bancoComMigration() {
  assert.ok(existsSync(MIGRATION), `migration ausente: ${MIGRATION}`);
  const db = new PGlite();
  await db.exec(FIXTURE);
  // Organização que já existia antes da migration.
  await db.query('INSERT INTO whatsapp_hub.ai_agent_config (org_id) VALUES ($1)', [ORG_A]);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

test('quem já está no ar e a organização nova ficam com o modo de teste desligado', async () => {
  const db = await bancoComMigration();
  await db.query('INSERT INTO whatsapp_hub.ai_agent_config (org_id) VALUES ($1)', [ORG_B]);
  const { rows } = await db.query(
    'SELECT org_id, test_mode, test_allowlist FROM whatsapp_hub.ai_agent_config ORDER BY org_id',
  );
  assert.deepEqual(rows.map((r) => [r.test_mode, r.test_allowlist]), [[false, []], [false, []]]);
});

test('a lista aceita 20 números e recusa o 21º', async () => {
  const db = await bancoComMigration();
  const vinte = Array.from({ length: 20 }, (_, i) => `55119999900${String(i).padStart(2, '0')}`);
  await db.query(
    'UPDATE whatsapp_hub.ai_agent_config SET test_mode = true, test_allowlist = $1 WHERE org_id = $2',
    [vinte, ORG_A],
  );
  await assert.rejects(
    db.query('UPDATE whatsapp_hub.ai_agent_config SET test_allowlist = $1 WHERE org_id = $2', [[...vinte, '5511999990099'], ORG_A]),
    /ai_agent_config_test_allowlist_max/,
  );
});

test('rodar a migration de novo não dá erro', async () => {
  const db = await bancoComMigration();
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const { rows } = await db.query('SELECT test_mode FROM whatsapp_hub.ai_agent_config');
  assert.equal(rows.length, 1);
});
