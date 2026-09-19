// ============================================================================
// npm run db:push e npm run db:status contra uma Management API simulada.
// ----------------------------------------------------------------------------
// O fetch é substituído por um dublê que responde às três leituras de estado
// com dados fixos e anota todo o resto como escrita. Nenhuma requisição sai da
// máquina e nenhum banco existe: o que se confere aqui é a DECISÃO (quais
// migrations são enviadas, em que ordem, e quando nada pode ser enviado).
//
// O efeito do SQL num Postgres de verdade está em push-migrations.pglite.test.mjs.
//
// Como rodar:
//   node --test tests/scripts/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '../../scripts/lib/migration-plan.mjs';

const OLD_FILES = {
  '20260101000001_init.sql': 'CREATE SCHEMA IF NOT EXISTS whatsapp_hub; CREATE TABLE whatsapp_hub.t_init (id int);',
  '20260101000002_limpeza.sql': 'DELETE FROM whatsapp_hub.t_init;',
  '20260201000000_canal_a.sql': 'CREATE TABLE whatsapp_hub.t_canal_a (id int);',
  '20260201000000_canal_b.sql': 'CREATE TABLE whatsapp_hub.t_canal_b (id int);',
};
const NEW_FILE = { '20260301000000_nova.sql': 'CREATE TABLE whatsapp_hub.t_nova (id int);' };

const step = (file) => `migration:${file}`;
const WIZARD_STEPS = ['connection_ok', ...Object.keys(OLD_FILES).map(step), 'migrations_done'];
const MANUAL_VERSIONS = ['20260101000001', '20260101000002', '20260201000000'];

function migrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'db-push-test-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

// A Management API devolve 400 com o SQLSTATE dentro de `message`.
function sqlError(sqlstate, message) {
  return jsonResponse(400, { message: `Failed to run sql query: ERROR:  ${sqlstate}: ${message}` });
}

// versions/steps: array = conteúdo da tabela, null = tabela não existe.
function fakeManagementApi({ versions, steps, hubSchema, respond }) {
  const writes = [];
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    const { query } = JSON.parse(init.body);
    const custom = respond?.(query);
    if (custom) return custom;
    if (query.includes('has_hub_schema')) {
      return jsonResponse(201, [{
        has_versions_table: versions !== null,
        has_steps_table: steps !== null,
        has_hub_schema: hubSchema,
      }]);
    }
    if (/select\s+version\s+from\s+supabase_migrations\.schema_migrations/i.test(query)) {
      if (versions === null) return sqlError('42P01', 'relation "supabase_migrations.schema_migrations" does not exist');
      return jsonResponse(201, versions.map((version) => ({ version })));
    }
    if (/select\s+step\s+from\s+public\._bootstrap_state/i.test(query)) {
      if (steps === null) return sqlError('42P01', 'relation "public._bootstrap_state" does not exist');
      return jsonResponse(201, steps.filter((s) => s.startsWith('migration:')).map((s) => ({ step: s })));
    }
    writes.push(query);
    return jsonResponse(201, []);
  };
  return { fetchImpl, writes, urls };
}

async function run(api, files, options = {}) {
  const dir = migrationsDir(files);
  const lines = [];
  try {
    const result = await runMigrations({
      mode: 'push',
      token: 'sbp_teste',
      ref: 'projetodeteste',
      env: {},
      dir,
      fetchImpl: api.fetchImpl,
      log: (line) => lines.push(line),
      ...options,
    });
    return { ...result, output: lines.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sentBodies = (api, files) =>
  Object.entries(files)
    .filter(([, sql]) => api.writes.some((query) => query.includes(sql)))
    .map(([name]) => name);

test('instalação de wizard: o db:push envia só a migration nova', async () => {
  const api = fakeManagementApi({ versions: null, steps: WIZARD_STEPS, hubSchema: true });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sentBodies(api, { ...OLD_FILES, ...NEW_FILE }), ['20260301000000_nova.sql']);
  assert.deepEqual(result.applied, ['20260301000000_nova.sql']);
});

test('instalação manual: o db:push envia só a migration nova', async () => {
  const api = fakeManagementApi({ versions: MANUAL_VERSIONS, steps: ['app_credentials_saved'], hubSchema: true });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sentBodies(api, { ...OLD_FILES, ...NEW_FILE }), ['20260301000000_nova.sql']);
});

test('a migration e o registro nos dois controles viajam na MESMA chamada', async () => {
  // Em chamadas separadas, cair entre uma e outra deixa a migration aplicada e
  // sem registro, e a próxima execução tenta aplicá-la de novo.
  const api = fakeManagementApi({ versions: MANUAL_VERSIONS, steps: WIZARD_STEPS, hubSchema: true });

  await run(api, { ...OLD_FILES, ...NEW_FILE });

  const call = api.writes.find((query) => query.includes(NEW_FILE['20260301000000_nova.sql']));
  assert.ok(call, 'a migration nova precisa ter sido enviada');
  assert.match(call, /supabase_migrations\.schema_migrations[\s\S]*'20260301000000'/);
  assert.match(call, /public\._bootstrap_state[\s\S]*'migration:20260301000000_nova\.sql'/);
});

test('trava: banco montado sem registro não recebe nenhuma escrita', async () => {
  const api = fakeManagementApi({ versions: [], steps: [], hubSchema: true });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE });

  assert.equal(result.exitCode, 3);
  assert.deepEqual(api.writes, []);
  assert.match(result.output, /SQL Editor/);
  assert.match(result.output, /20260101000001_init\.sql/);
});

test('banco novo: aplica todas, na ordem dos nomes', async () => {
  const api = fakeManagementApi({ versions: null, steps: null, hubSchema: false });

  const result = await run(api, { ...NEW_FILE, ...OLD_FILES });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.applied, [
    '20260101000001_init.sql',
    '20260101000002_limpeza.sql',
    '20260201000000_canal_a.sql',
    '20260201000000_canal_b.sql',
    '20260301000000_nova.sql',
  ]);
});

test('db:status não escreve nada e lista o que o db:push aplicaria', async () => {
  const api = fakeManagementApi({ versions: null, steps: WIZARD_STEPS, hubSchema: true });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE }, { mode: 'status' });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(api.writes, []);
  assert.match(result.output, /20260301000000_nova\.sql/);
  assert.doesNotMatch(result.output, /20260101000002_limpeza\.sql/);
});

test('db:status também para na trava, sem escrever', async () => {
  const api = fakeManagementApi({ versions: [], steps: [], hubSchema: true });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE }, { mode: 'status' });

  assert.equal(result.exitCode, 3);
  assert.deepEqual(api.writes, []);
});

test('migration que falha interrompe a fila: as seguintes não são enviadas', async () => {
  const files = { ...OLD_FILES, ...NEW_FILE, '20260401000000_depois.sql': 'CREATE TABLE whatsapp_hub.t_depois (id int);' };
  const api = fakeManagementApi({
    versions: MANUAL_VERSIONS,
    steps: WIZARD_STEPS,
    hubSchema: true,
    respond: (query) => (query.includes('t_nova') ? sqlError('42P07', 'relation "t_nova" already exists') : null),
  });

  const result = await run(api, files);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.applied, []);
  assert.ok(
    !api.writes.some((query) => query.includes('t_depois')),
    'a migration seguinte à que falhou não pode ser enviada',
  );
  assert.match(result.output, /t_nova.*already exists/);
});

test('falha ao LER o controle aborta: erro de leitura não é "banco sem registro"', async () => {
  // Tratar um 500 como tabela vazia levaria ao replay completo num banco novo
  // de mentira, ou à trava num banco saudável.
  const api = fakeManagementApi({
    versions: MANUAL_VERSIONS,
    steps: WIZARD_STEPS,
    hubSchema: true,
    respond: (query) =>
      /select\s+version/i.test(query) ? jsonResponse(500, { message: 'upstream request timeout' }) : null,
  });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(api.writes, []);
  assert.match(result.output, /upstream request timeout/);
});

test('42P01 na leitura de _bootstrap_state é tolerado como tabela ausente', async () => {
  // A sonda disse que a tabela existe, mas a leitura devolveu 42P01 (tabela
  // removida entre uma chamada e outra). Vale como instalação sem a tabela.
  const api = fakeManagementApi({
    versions: MANUAL_VERSIONS,
    steps: [],
    hubSchema: true,
    respond: (query) =>
      /select\s+step/i.test(query) ? sqlError('42P01', 'relation "public._bootstrap_state" does not exist') : null,
  });

  const result = await run(api, { ...OLD_FILES, ...NEW_FILE });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.applied, ['20260301000000_nova.sql']);
});

test('placeholder de segredo é trocado pelo valor do ambiente na hora do envio', async () => {
  const files = { ...OLD_FILES, '20260301000000_cron.sql': "SELECT cron.schedule('x', '__SUPABASE_URL__/functions/v1/x');" };
  const api = fakeManagementApi({ versions: MANUAL_VERSIONS, steps: WIZARD_STEPS, hubSchema: true });

  const result = await run(api, files, { env: { SUPABASE_URL: 'https://abc.supabase.co' } });

  assert.equal(result.exitCode, 0);
  const call = api.writes.find((query) => query.includes('cron.schedule'));
  assert.match(call, /https:\/\/abc\.supabase\.co\/functions\/v1\/x/);
  assert.doesNotMatch(call, /__SUPABASE_URL__/);
});

test('placeholder sem a variável de ambiente para antes de qualquer escrita', async () => {
  const files = {
    ...OLD_FILES,
    ...NEW_FILE,
    '20260401000000_cron.sql': "SELECT cron.schedule('x', '__SUPABASE_URL__/functions/v1/x');",
  };
  const api = fakeManagementApi({ versions: MANUAL_VERSIONS, steps: WIZARD_STEPS, hubSchema: true });

  const result = await run(api, files, { env: {} });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(api.writes, []);
  assert.match(result.output, /SUPABASE_URL/);
  assert.match(result.output, /20260401000000_cron\.sql/);
});

test('controles já iguais e nada pendente: nenhuma escrita', async () => {
  const api = fakeManagementApi({
    versions: MANUAL_VERSIONS,
    steps: Object.keys(OLD_FILES).map(step),
    hubSchema: true,
  });

  const result = await run(api, OLD_FILES);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(api.writes, []);
});

test('sincronização: instalação de wizard sem pendência ganha as versions, sem reexecutar migration', async () => {
  const api = fakeManagementApi({ versions: null, steps: WIZARD_STEPS, hubSchema: true });

  const result = await run(api, OLD_FILES);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sentBodies(api, OLD_FILES), []);
  const recorded = api.writes.join('\n');
  for (const version of MANUAL_VERSIONS) assert.match(recorded, new RegExp(`'${version}'`));
});

test('as chamadas vão para o projeto informado, com o token no cabeçalho', async () => {
  const seen = [];
  const api = fakeManagementApi({ versions: MANUAL_VERSIONS, steps: WIZARD_STEPS, hubSchema: true });
  const spy = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, method: init.method });
    return api.fetchImpl(url, init);
  };

  await run(api, { ...OLD_FILES, ...NEW_FILE }, { fetchImpl: spy });

  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.url, 'https://api.supabase.com/v1/projects/projetodeteste/database/query');
    assert.equal(call.auth, 'Bearer sbp_teste');
    assert.equal(call.method, 'POST');
  }
});

test('db:status avisa quando o scripts/push-migrations.mjs do clone ainda é o antigo', async () => {
  // Atualização parcial: a pessoa trouxe o db:status e a lib, mas o script de
  // push continua sendo o que reaplica tudo. O status não pode dar sinal verde.
  const dir = mkdtempSync(join(tmpdir(), 'db-push-script-'));
  const oldScript = join(dir, 'push-migrations.mjs');
  writeFileSync(oldScript, "import { readFileSync } from 'node:fs';\nasync function main() {}\nmain();\n");
  const api = fakeManagementApi({ versions: null, steps: WIZARD_STEPS, hubSchema: true });

  try {
    const result = await run(api, { ...OLD_FILES, ...NEW_FILE }, { mode: 'status', pushScriptPath: oldScript });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(api.writes, []);
    assert.match(result.output, /push-migrations\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
