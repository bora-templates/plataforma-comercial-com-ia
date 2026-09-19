// ============================================================================
// Decisão "quais migrations aplicar" do npm run db:push.
// ----------------------------------------------------------------------------
// Existem dois controles de migration neste projeto: o wizard /setup anota em
// public._bootstrap_state (step 'migration:<arquivo>') e o db:push anota em
// supabase_migrations.schema_migrations (version = prefixo numérico). Uma
// instalação feita pelo wizard tem o primeiro cheio e o segundo vazio. Se o
// db:push olhar só para o segundo, ele reaplica tudo desde a primeira migration
// em cima de um banco em produção.
//
// Este arquivo cobre a função pura, sem rede e sem banco.
//
// Como rodar:
//   node --test tests/scripts/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMigrations, parseMigrationFile } from '../../scripts/lib/migration-plan.mjs';

// Repositório de mentira, com um par de prefixo repetido igual ao que existe
// de verdade em supabase/migrations (20260811120000_*).
const FILES = [
  '20260101000001_init.sql',
  '20260101000002_tabelas.sql',
  '20260201000000_canal_a.sql',
  '20260201000000_canal_b.sql',
  '20260301000000_nova.sql',
];

const step = (file) => `migration:${file}`;
const names = (list) => list.map((m) => m.file);

test('banco novo: sem registro e sem schema, aplica tudo em ordem', () => {
  const plan = planMigrations({ files: FILES, versions: [], steps: null, hubSchemaExists: false });

  assert.equal(plan.blocked, null);
  assert.deepEqual(names(plan.pending), [
    '20260101000001_init.sql',
    '20260101000002_tabelas.sql',
    '20260201000000_canal_a.sql',
    '20260201000000_canal_b.sql',
    '20260301000000_nova.sql',
  ]);
});

test('instalação feita pelo wizard: só a migration nova fica pendente', () => {
  const plan = planMigrations({
    files: FILES,
    versions: [],
    steps: FILES.slice(0, 4).map(step),
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked, null);
  assert.deepEqual(names(plan.pending), ['20260301000000_nova.sql']);
});

test('instalação manual: só a migration nova fica pendente', () => {
  const plan = planMigrations({
    files: FILES,
    versions: ['20260101000001', '20260101000002', '20260201000000'],
    steps: null,
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked, null);
  assert.deepEqual(names(plan.pending), ['20260301000000_nova.sql']);
});

test('basta estar em UMA das duas fontes para contar como aplicada', () => {
  const plan = planMigrations({
    files: FILES,
    versions: ['20260101000001', '20260201000000'],
    steps: [step('20260101000002_tabelas.sql')],
    hubSchemaExists: true,
  });

  assert.deepEqual(names(plan.pending), ['20260301000000_nova.sql']);
});

test('prefixo repetido: a version registrada cobre os dois arquivos do par', () => {
  // É o estado real da instalação manual: a tabela tem chave em version, então
  // só uma linha existe para o par. Tratar o segundo arquivo como pendente
  // faria a produção reaplicar uma migration que não é idempotente.
  const plan = planMigrations({
    files: FILES,
    versions: ['20260101000001', '20260101000002', '20260201000000', '20260301000000'],
    steps: null,
    hubSchemaExists: true,
  });

  assert.deepEqual(names(plan.pending), []);
});

test('trava: schema existe e nenhuma fonte tem registro', () => {
  const plan = planMigrations({ files: FILES, versions: [], steps: [], hubSchemaExists: true });

  assert.equal(plan.blocked?.code, 'BANCO_SEM_REGISTRO');
});

test('trava ignora registros que não são de migrations deste repositório', () => {
  // _bootstrap_state guarda outros checkpoints (api/credentials.ts grava
  // app_credentials_saved) e schema_migrations pode ter versions de outro
  // produto no mesmo projeto Supabase. Nenhum dos dois prova que as migrations
  // daqui rodaram.
  const plan = planMigrations({
    files: FILES,
    versions: ['20990101000000'],
    steps: ['connection_ok', 'app_credentials_saved'],
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked?.code, 'BANCO_SEM_REGISTRO');
});

test('trava: a primeira migration sem registro basta, mesmo com uma posterior registrada', () => {
  // Alguém que registra na mão só a última migration deixaria as anteriores
  // como pendentes, e o replay começaria pela primeira.
  const plan = planMigrations({
    files: FILES,
    versions: ['20260301000000'],
    steps: [],
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked?.code, 'BANCO_SEM_REGISTRO');
});

test('sem trava quando o wizard parou no meio: continua de onde ele parou', () => {
  const plan = planMigrations({
    files: FILES,
    versions: [],
    steps: [step('20260101000001_init.sql'), step('20260101000002_tabelas.sql')],
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked, null);
  assert.deepEqual(names(plan.pending), [
    '20260201000000_canal_a.sql',
    '20260201000000_canal_b.sql',
    '20260301000000_nova.sql',
  ]);
});

test('migration colada no SQL Editor (sem registro) volta como pendente, sem trava', () => {
  // A seção 7 do INSTALL.md manda colar a migration de segurança no SQL Editor.
  // Ela é idempotente, então reaplicar e registrar é o comportamento certo,
  // mesmo que uma migration mais nova já esteja registrada.
  const plan = planMigrations({
    files: FILES,
    versions: ['20260301000000'],
    steps: [
      step('20260101000001_init.sql'),
      step('20260101000002_tabelas.sql'),
      step('20260201000000_canal_a.sql'),
    ],
    hubSchemaExists: true,
  });

  assert.equal(plan.blocked, null);
  assert.deepEqual(names(plan.pending), ['20260201000000_canal_b.sql']);
});

test('a ordem de entrada dos arquivos não muda a ordem de aplicação', () => {
  const plan = planMigrations({
    files: [...FILES].reverse(),
    versions: [],
    steps: null,
    hubSchemaExists: false,
  });

  assert.deepEqual(names(plan.pending), FILES);
});

test('sincronização: instalação de wizard ganha as versions que faltam, sem repetir o par', () => {
  const plan = planMigrations({
    files: FILES,
    versions: [],
    steps: FILES.slice(0, 4).map(step),
    hubSchemaExists: true,
  });

  assert.deepEqual(plan.missingVersions, [
    { version: '20260101000001', name: 'init' },
    { version: '20260101000002', name: 'tabelas' },
    { version: '20260201000000', name: 'canal_a' },
  ]);
  assert.deepEqual(plan.missingSteps, []);
});

test('sincronização: instalação manual ganha os steps que faltam para o wizard enxergar', () => {
  const plan = planMigrations({
    files: FILES,
    versions: ['20260101000001', '20260101000002', '20260201000000'],
    steps: ['app_credentials_saved'],
    hubSchemaExists: true,
  });

  assert.deepEqual(plan.missingVersions, []);
  assert.deepEqual(plan.missingSteps, [
    'migration:20260101000001_init.sql',
    'migration:20260101000002_tabelas.sql',
    'migration:20260201000000_canal_a.sql',
    'migration:20260201000000_canal_b.sql',
  ]);
});

test('sincronização: sem a tabela _bootstrap_state não há step a gravar', () => {
  const plan = planMigrations({
    files: FILES,
    versions: ['20260101000001', '20260101000002', '20260201000000'],
    steps: null,
    hubSchemaExists: true,
  });

  assert.deepEqual(plan.missingSteps, []);
});

test('identidade do arquivo: version é o que vem antes do primeiro underscore', () => {
  // Mudar esta regra faz instalações existentes verem migrations antigas como
  // pendentes, porque a version já gravada deixa de bater.
  assert.deepEqual(parseMigrationFile('20260422120001_init.sql'), {
    file: '20260422120001_init.sql',
    version: '20260422120001',
    name: 'init',
  });
  assert.deepEqual(parseMigrationFile('20260811120000_mt_agent_media_org_scope.sql'), {
    file: '20260811120000_mt_agent_media_org_scope.sql',
    version: '20260811120000',
    name: 'mt_agent_media_org_scope',
  });
  assert.deepEqual(parseMigrationFile('semprefixo.sql'), {
    file: 'semprefixo.sql',
    version: 'semprefixo',
    name: '',
  });
});
