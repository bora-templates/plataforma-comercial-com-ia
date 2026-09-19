// ============================================================================
// Wizard /setup (api/bootstrap.ts) e db:push enxergando o mesmo histórico.
// ----------------------------------------------------------------------------
// O wizard sempre anotou as migrations só em public._bootstrap_state. Instalação
// nova precisa nascer com supabase_migrations.schema_migrations preenchida
// também, para o db:push, o Supabase CLI oficial e o painel do Supabase
// concordarem com o wizard desde o primeiro dia.
//
// Roda o runMigrations de verdade do wizard contra um Postgres embutido (PGlite)
// e depois pergunta ao db:push o que ele faria com aquele banco.
//
// Precisa de Node 22.18+ (importa o TypeScript direto) e do PGlite:
//   npm i --no-save @electric-sql/pglite
//   node --test tests/scripts/
// Sem um dos dois, estes testes aparecem como pulados.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planMigrations } from '../../scripts/lib/migration-plan.mjs';

const pglite = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite').catch(() => null);
const bootstrap = await import('../../api/bootstrap.ts').catch(() => null);
const skip = !pglite
  ? 'PGlite ausente: npm i --no-save @electric-sql/pglite'
  : !bootstrap
    ? 'este Node não importa TypeScript direto (precisa de 22.18+)'
    : false;

const FILES = {
  '20260101000001_init.sql':
    'CREATE SCHEMA IF NOT EXISTS whatsapp_hub;\nCREATE TABLE whatsapp_hub.clientes (id int PRIMARY KEY, nome text);',
  '20260201000000_canal_a.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN canal_a boolean;',
  '20260201000000_canal_b.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN canal_b boolean;',
};
const BODY = {
  supabase_url: 'https://projetodeteste.supabase.co',
  supabase_service_role_key: 'service-role-de-teste',
};

// O wizard lê supabase/migrations a partir do diretório corrente e usa o fetch
// global. Cada arquivo de teste roda em processo próprio, então trocar os dois
// aqui não vaza para os outros testes.
async function wizardInstall(files, { breakSchemaMigrations = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wizard-test-'));
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(root, 'supabase/migrations', name), sql);

  const db = new pglite.PGlite();
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    try {
      const results = await db.exec(query);
      return { ok: true, status: 201, text: async () => JSON.stringify(results.at(-1)?.rows ?? []) };
    } catch (err) {
      const message = `Failed to run sql query: ERROR:  ${err.code}: ${err.message}`;
      return { ok: false, status: 400, text: async () => JSON.stringify({ message }) };
    }
  };
  process.chdir(root);
  try {
    if (breakSchemaMigrations) {
      // Um objeto no caminho, com o nome da tabela e o formato errado.
      await db.exec('CREATE SCHEMA supabase_migrations; CREATE VIEW supabase_migrations.schema_migrations AS SELECT 1 AS x;');
    }
    await bootstrap.prepareBootstrapTables('projetodeteste', 'sbp_teste');
    await bootstrap.runMigrations('projetodeteste', 'sbp_teste', BODY, 'chave-de-teste');
  } finally {
    process.chdir(realCwd);
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
  return db;
}

const column = async (db, sql, key) => (await db.query(sql)).rows.map((row) => row[key]);

test('instalação nova pelo wizard nasce com os dois controles preenchidos', { skip }, async () => {
  const db = await wizardInstall(FILES);

  assert.deepEqual(
    await column(db, `SELECT step FROM public._bootstrap_state WHERE step LIKE 'migration:%' ORDER BY step`, 'step'),
    [
      'migration:20260101000001_init.sql',
      'migration:20260201000000_canal_a.sql',
      'migration:20260201000000_canal_b.sql',
    ],
  );
  assert.deepEqual(
    await column(db, 'SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version', 'version'),
    ['20260101000001', '20260201000000'],
  );
});

test('depois do wizard, o db:push não vê nada pendente nem nada a igualar', { skip }, async () => {
  const db = await wizardInstall(FILES);

  const plan = planMigrations({
    files: Object.keys(FILES),
    versions: await column(db, 'SELECT version FROM supabase_migrations.schema_migrations', 'version'),
    steps: await column(db, 'SELECT step FROM public._bootstrap_state', 'step'),
    hubSchemaExists: true,
  });

  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.missingVersions, []);
  assert.deepEqual(plan.missingSteps, []);
  assert.equal(plan.blocked, null);
});

test('falha no segundo controle não derruba a instalação', { skip }, async () => {
  // schema_migrations é registro secundário para o wizard. Se ele não puder ser
  // escrito, as migrations e o _bootstrap_state têm que sair inteiros.
  const db = await wizardInstall(FILES, { breakSchemaMigrations: true });

  assert.deepEqual(
    await column(
      db,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'whatsapp_hub' AND table_name = 'clientes' ORDER BY column_name`,
      'column_name',
    ),
    ['canal_a', 'canal_b', 'id', 'nome'],
  );
  assert.equal(
    (await column(db, `SELECT step FROM public._bootstrap_state WHERE step LIKE 'migration:%'`, 'step')).length,
    3,
  );
});

test('migration tolerada como "já aplicada" pelo wizard também entra nos dois controles', { skip }, async () => {
  // Replay do wizard sobre banco já migrado: a migration falha com "already
  // exists", o wizard marca e segue. A marca tem que ir para as duas tabelas.
  const files = {
    ...FILES,
    '20260301000000_repetida.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN canal_a boolean;',
  };

  const db = await wizardInstall(files);

  assert.ok(
    (await column(db, 'SELECT step FROM public._bootstrap_state', 'step')).includes(
      'migration:20260301000000_repetida.sql',
    ),
  );
  assert.ok(
    (await column(db, 'SELECT version FROM supabase_migrations.schema_migrations', 'version')).includes(
      '20260301000000',
    ),
  );
});
