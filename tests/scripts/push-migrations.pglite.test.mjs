// ============================================================================
// npm run db:push contra um Postgres de verdade, embutido (PGlite, WASM).
// ----------------------------------------------------------------------------
// push-migrations.test.mjs confere a decisão com um dublê que só enxerga texto.
// Aqui o fetch da Management API é ligado a um Postgres embutido, então o SQL
// que o script gera roda de fato: registro nas duas tabelas, guarda para a
// tabela ausente, transação por chamada e dados que não podem sumir.
//
// Nada hospedado é tocado. O PGlite não é dependência do projeto:
//   npm i --no-save @electric-sql/pglite
//   node --test tests/scripts/
// Sem o pacote instalado, estes testes aparecem como pulados.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '../../scripts/lib/migration-plan.mjs';

const pglite = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite').catch(() => null);
const skip = pglite ? false : 'PGlite ausente: npm i --no-save @electric-sql/pglite';

// A segunda migration é destrutiva de propósito: é o tipo de coisa que o replay
// executaria num banco em produção. As de canal não são idempotentes.
const OLD_FILES = {
  '20260101000001_init.sql':
    'CREATE SCHEMA IF NOT EXISTS whatsapp_hub;\nCREATE TABLE whatsapp_hub.clientes (id int PRIMARY KEY, nome text);',
  '20260101000002_limpeza.sql': 'DELETE FROM whatsapp_hub.clientes;',
  '20260102000000_setup_infra.sql':
    'CREATE TABLE IF NOT EXISTS public._bootstrap_state (\n  step text PRIMARY KEY,\n  completed_at timestamptz NOT NULL DEFAULT now(),\n  metadata jsonb\n);',
  '20260201000000_canal_a.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN canal_a boolean;',
  '20260201000000_canal_b.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN canal_b boolean;',
};
const NEW_FILE = { '20260301000000_nova.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN nova boolean;' };
const ALL_FILES = { ...OLD_FILES, ...NEW_FILE };

const OLD_VERSIONS = ['20260101000001', '20260101000002', '20260102000000', '20260201000000'];
const ALL_VERSIONS = [...OLD_VERSIONS, '20260301000000'];
const stepsOf = (files) => Object.keys(files).map((file) => `migration:${file}`).sort();

const BOOTSTRAP_TABLE = `CREATE TABLE IF NOT EXISTS public._bootstrap_state (
  step text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT now(), metadata jsonb);`;

async function database() {
  const db = new pglite.PGlite();
  // Igual à Management API: a chamada inteira é uma transação, a resposta é o
  // resultado do último comando e o erro traz o SQLSTATE dentro de `message`.
  const fetchImpl = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    try {
      const results = await db.exec(query);
      const rows = results.at(-1)?.rows ?? [];
      return { ok: true, status: 201, text: async () => JSON.stringify(rows) };
    } catch (err) {
      const message = `Failed to run sql query: ERROR:  ${err.code}: ${err.message}`;
      return { ok: false, status: 400, text: async () => JSON.stringify({ message }) };
    }
  };
  return { db, fetchImpl };
}

async function applyBodies(db, files) {
  for (const sql of Object.values(files)) await db.exec(sql);
}

// Como o wizard /setup deixa o banco: _bootstrap_state criada antes de tudo,
// um step por arquivo, e supabase_migrations nem existe.
async function seedWizardInstall(db) {
  await db.exec(BOOTSTRAP_TABLE);
  await applyBodies(db, OLD_FILES);
  for (const step of ['connection_ok', ...stepsOf(OLD_FILES), 'migrations_done']) {
    await db.query(`INSERT INTO public._bootstrap_state (step, metadata) VALUES ($1, '{}'::jsonb)`, [step]);
  }
  await db.exec(`INSERT INTO whatsapp_hub.clientes (id, nome) VALUES (1, 'Cliente em produção');`);
}

// Como o db:push antigo deixa o banco: uma linha por version (o par de prefixo
// repetido vira uma só) e _bootstrap_state sem nenhum step de migration.
async function seedManualInstall(db) {
  await applyBodies(db, OLD_FILES);
  await db.exec(`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[]);`);
  for (const version of OLD_VERSIONS) {
    await db.query(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, 'x')`, [version]);
  }
  await db.exec(`INSERT INTO public._bootstrap_state (step, metadata) VALUES ('app_credentials_saved', '{}'::jsonb);`);
  await db.exec(`INSERT INTO whatsapp_hub.clientes (id, nome) VALUES (1, 'Cliente em produção');`);
}

async function snapshot(db) {
  const has = async (rel) => (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [rel])).rows[0].ok;
  const column = async (sql, key) => (await db.query(sql)).rows.map((row) => row[key]);
  return {
    clientes: (await has('whatsapp_hub.clientes'))
      ? await column('SELECT nome FROM whatsapp_hub.clientes ORDER BY id', 'nome')
      : null,
    colunas: await column(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'whatsapp_hub' AND table_name = 'clientes' ORDER BY column_name`,
      'column_name',
    ),
    versions: (await has('supabase_migrations.schema_migrations'))
      ? await column('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version', 'version')
      : null,
    steps: (await has('public._bootstrap_state'))
      ? await column(`SELECT step FROM public._bootstrap_state WHERE step LIKE 'migration:%' ORDER BY step`, 'step')
      : null,
  };
}

async function run(fetchImpl, files, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'db-push-pglite-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  const lines = [];
  try {
    const result = await runMigrations({
      mode: 'push',
      token: 'sbp_teste',
      ref: 'projetodeteste',
      env: {},
      dir,
      fetchImpl,
      log: (line) => lines.push(line),
      ...options,
    });
    return { ...result, output: lines.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('instalação de wizard: aplica só a nova, preserva os dados e iguala os dois controles', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await seedWizardInstall(db);

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(await snapshot(db), {
    clientes: ['Cliente em produção'],
    colunas: ['canal_a', 'canal_b', 'id', 'nome', 'nova'],
    versions: ALL_VERSIONS,
    steps: stepsOf(ALL_FILES),
  });
});

test('instalação manual: aplica só a nova e o wizard passa a enxergar todas', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await seedManualInstall(db);

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(await snapshot(db), {
    clientes: ['Cliente em produção'],
    colunas: ['canal_a', 'canal_b', 'id', 'nome', 'nova'],
    versions: ALL_VERSIONS,
    steps: stepsOf(ALL_FILES),
  });
});

test('rodar de novo não muda nada', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await seedWizardInstall(db);
  await run(fetchImpl, ALL_FILES);
  const before = await snapshot(db);

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(await snapshot(db), before);
});

test('banco novo: aplica tudo e os steps ficam completos, inclusive os anteriores à tabela', { skip }, async () => {
  // _bootstrap_state só nasce na terceira migration. As duas primeiras rodam
  // quando a tabela ainda não existe e não podem ficar sem step no fim.
  const { db, fetchImpl } = await database();

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(await snapshot(db), {
    clientes: [],
    colunas: ['canal_a', 'canal_b', 'id', 'nome', 'nova'],
    versions: ALL_VERSIONS,
    steps: stepsOf(ALL_FILES),
  });
});

test('trava: banco montado sem registro fica exatamente como estava', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await applyBodies(db, OLD_FILES);
  await db.exec(`INSERT INTO whatsapp_hub.clientes (id, nome) VALUES (1, 'Cliente em produção');`);
  const before = await snapshot(db);

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 3, result.output);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(before.clientes, ['Cliente em produção']);
});

test('db:status não altera o banco, nem cria a tabela de controle', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await seedWizardInstall(db);
  const before = await snapshot(db);

  const result = await run(fetchImpl, ALL_FILES, { mode: 'status' });

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(await snapshot(db), before);
  assert.equal(before.versions, null);
});

test('migration que falha no meio é desfeita inteira e não fica registrada', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await seedWizardInstall(db);
  const files = {
    ...ALL_FILES,
    '20260401000000_quebrada.sql':
      'ALTER TABLE whatsapp_hub.clientes ADD COLUMN meio_caminho boolean;\nSELECT 1/0;',
    '20260501000000_depois.sql': 'ALTER TABLE whatsapp_hub.clientes ADD COLUMN depois boolean;',
  };

  const result = await run(fetchImpl, files);

  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(result.applied, ['20260301000000_nova.sql']);
  const after = await snapshot(db);
  assert.deepEqual(after.colunas, ['canal_a', 'canal_b', 'id', 'nome', 'nova']);
  assert.deepEqual(after.versions, ALL_VERSIONS);
  assert.deepEqual(after.steps, stepsOf(ALL_FILES));
});

test('instalação sem a tabela _bootstrap_state: aplica e registra só em schema_migrations', { skip }, async () => {
  const { db, fetchImpl } = await database();
  const semInfra = Object.fromEntries(Object.entries(OLD_FILES).filter(([file]) => !file.includes('setup_infra')));
  await applyBodies(db, semInfra);
  await db.exec(`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[]);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260101000001'), ('20260101000002'), ('20260201000000');`);

  const result = await run(fetchImpl, { ...semInfra, ...NEW_FILE });

  assert.equal(result.exitCode, 0, result.output);
  const after = await snapshot(db);
  assert.deepEqual(after.steps, null);
  assert.deepEqual(after.versions, ['20260101000001', '20260101000002', '20260201000000', '20260301000000']);
  assert.deepEqual(after.colunas, ['canal_a', 'canal_b', 'id', 'nome', 'nova']);
});

test('tabela de controle criada por um Supabase CLI antigo (só a coluna version) é aceita', { skip }, async () => {
  const { db, fetchImpl } = await database();
  await applyBodies(db, OLD_FILES);
  await db.exec(`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
    INSERT INTO supabase_migrations.schema_migrations (version)
    VALUES ('20260101000001'), ('20260101000002'), ('20260102000000'), ('20260201000000');`);

  const result = await run(fetchImpl, ALL_FILES);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual((await snapshot(db)).versions, ALL_VERSIONS);
});

test('nome de migration com aspas simples não quebra o SQL de registro', { skip }, async () => {
  const { db, fetchImpl } = await database();
  const files = { "20260101000001_d'agua.sql": 'CREATE SCHEMA whatsapp_hub;' };

  const result = await run(fetchImpl, files);

  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual((await snapshot(db)).versions, ['20260101000001']);
});
