// ============================================================================
// Funil da organização nova (v1, várias organizações).
// ----------------------------------------------------------------------------
// O super-admin cria a organização em api/admin/orgs.ts, que chama
// seed_org_defaults. A função semeava configurações e o mapa de UTM e não
// criava funil: a organização nascia sem funil, a mensagem recebida não virava
// card (attribute_inbound_lead devolve sem_funil_comercial) e o dono só
// percebia ao abrir Oportunidades vazia.
//
// A migration faz a organização nova nascer com os funis da instalação
// ("Vendas", o padrão, e "Pós-venda", com as mesmas etapas, porcentagens e
// critérios da IA) e dá esses funis às organizações ativas que já existiam sem
// nenhum. Organização que já tem funil não ganha outro.
//
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado) com as colunas de
// organização, funil e etapa do banco que o assistente instala, reduzidas ao
// que a migration toca. Os default privileges são os do banco instalado: toda
// função nova do schema nasce com EXECUTE para authenticated.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/funil-da-organizacao-nova.test.mjs
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { CRITERIOS_PADRAO } from '../../src/lib/criterios-padrao.ts';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATION = 'supabase/migrations/20261002160000_funil_da_organizacao_nova.sql';

const FIXTURE = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA whatsapp_hub;
GRANT USAGE ON SCHEMA whatsapp_hub TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

CREATE TYPE whatsapp_hub.crm_pipeline_kind AS ENUM ('comercial', 'projeto', 'educacao');

CREATE TABLE whatsapp_hub.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.pipelines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  name       TEXT NOT NULL,
  kind       whatsapp_hub.crm_pipeline_kind NOT NULL DEFAULT 'comercial',
  position   INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  pipeline_id UUID NOT NULL REFERENCES whatsapp_hub.pipelines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INT NOT NULL DEFAULT 0,
  is_won      BOOLEAN NOT NULL DEFAULT false,
  is_lost     BOOLEAN NOT NULL DEFAULT false,
  probability INT NOT NULL DEFAULT 50 CHECK (probability BETWEEN 0 AND 100),
  color       TEXT,
  ai_criteria TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.app_settings (id SERIAL PRIMARY KEY, org_id UUID NOT NULL);
CREATE TABLE whatsapp_hub.repurchase_config (id SERIAL PRIMARY KEY, org_id UUID NOT NULL);

-- O mapa de UTM tem teste próprio; aqui só importa que a semente continua
-- sendo chamada.
CREATE TABLE whatsapp_hub.utm_seed_calls (org_id UUID NOT NULL);
CREATE FUNCTION whatsapp_hub.seed_utm_channel_map(p_org UUID)
RETURNS VOID LANGUAGE sql AS $$ INSERT INTO whatsapp_hub.utm_seed_calls VALUES (p_org) $$;
REVOKE ALL ON FUNCTION whatsapp_hub.seed_utm_channel_map(UUID) FROM PUBLIC;
`;

// Funis da instalação (20260630120000_crm_layer.sql), com as porcentagens que
// 20260720120000_stage_probability_defaults.sql calcula para eles e os
// critérios de 20261002150000_criterios_padrao_da_ia_no_funil.sql.
const ETAPAS_VENDAS = [
  { name: 'Chegou agora', position: 0, is_won: false, is_lost: false, probability: 23, ai_criteria: null },
  { name: 'Em conversa', position: 1, is_won: false, is_lost: false, probability: 45, ai_criteria: CRITERIOS_PADRAO['Em conversa'] },
  { name: 'Recebeu oferta', position: 2, is_won: false, is_lost: false, probability: 68, ai_criteria: CRITERIOS_PADRAO['Recebeu oferta'] },
  { name: 'Decidindo', position: 3, is_won: false, is_lost: false, probability: 90, ai_criteria: CRITERIOS_PADRAO.Decidindo },
  { name: 'Fechou', position: 4, is_won: true, is_lost: false, probability: 100, ai_criteria: CRITERIOS_PADRAO.Fechou },
  { name: 'Não fechou', position: 5, is_won: false, is_lost: true, probability: 0, ai_criteria: CRITERIOS_PADRAO['Não fechou'] },
];
const ETAPAS_POS_VENDA = [
  { name: 'Onboarding', position: 0, is_won: false, is_lost: false, probability: 30, ai_criteria: null },
  { name: 'Em andamento', position: 1, is_won: false, is_lost: false, probability: 60, ai_criteria: null },
  { name: 'Acompanhamento', position: 2, is_won: false, is_lost: false, probability: 90, ai_criteria: null },
  { name: 'Concluído', position: 3, is_won: true, is_lost: false, probability: 100, ai_criteria: null },
];

async function novoBanco() {
  const db = new PGlite();
  await db.exec(FIXTURE);
  return db;
}

async function aplicarMigration(db) {
  assert.ok(existsSync(MIGRATION), `migration ausente: ${MIGRATION}`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
}

async function criarOrganizacao(db, slug, status = 'active') {
  const { rows: [org] } = await db.query(
    'INSERT INTO whatsapp_hub.organizations (name, slug, status) VALUES ($1, $1, $2) RETURNING id',
    [slug, status],
  );
  return org.id;
}

async function criarFunil(db, orgId, nome) {
  const { rows: [funil] } = await db.query(
    'INSERT INTO whatsapp_hub.pipelines (org_id, name, is_default) VALUES ($1, $2, true) RETURNING id',
    [orgId, nome],
  );
  await db.query(
    "INSERT INTO whatsapp_hub.stages (org_id, pipeline_id, name) VALUES ($1, $2, 'Novo contato')",
    [orgId, funil.id],
  );
  return funil.id;
}

// O que o api/admin/orgs.ts faz depois de criar a organização.
async function semearComoOPainel(db, orgId) {
  await db.query('SELECT whatsapp_hub.seed_org_defaults($1)', [orgId]);
}

async function funisDa(db, orgId) {
  const { rows: funis } = await db.query(
    `SELECT id, name, kind, position, is_default FROM whatsapp_hub.pipelines
      WHERE org_id = $1 ORDER BY position, name`,
    [orgId],
  );
  const resultado = [];
  for (const funil of funis) {
    const { rows: etapas } = await db.query(
      `SELECT name, position, is_won, is_lost, probability, ai_criteria, org_id FROM whatsapp_hub.stages
        WHERE pipeline_id = $1 ORDER BY position`,
      [funil.id],
    );
    resultado.push({ ...funil, etapas });
  }
  return resultado;
}

test('organização nova nasce com os funis da instalação e os critérios da IA', async () => {
  const db = await novoBanco();
  await aplicarMigration(db);
  const nova = await criarOrganizacao(db, 'clinica-b');

  await semearComoOPainel(db, nova);

  const funis = await funisDa(db, nova);
  assert.deepEqual(
    funis.map(({ name, kind, position, is_default }) => ({ name, kind, position, is_default })),
    [
      { name: 'Vendas', kind: 'comercial', position: 0, is_default: true },
      { name: 'Pós-venda', kind: 'comercial', position: 1, is_default: false },
    ],
  );
  const semOrg = (etapas) => etapas.map(({ org_id, ...resto }) => resto);
  assert.deepEqual(semOrg(funis[0].etapas), ETAPAS_VENDAS);
  assert.deepEqual(semOrg(funis[1].etapas), ETAPAS_POS_VENDA);
  assert.ok(funis.every((funil) => funil.etapas.every((etapa) => etapa.org_id === nova)));
});

test('organização nova continua ganhando as configurações e o mapa de UTM', async () => {
  const db = await novoBanco();
  await aplicarMigration(db);
  const nova = await criarOrganizacao(db, 'clinica-b');

  await semearComoOPainel(db, nova);

  for (const tabela of ['app_settings', 'repurchase_config', 'utm_seed_calls']) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM whatsapp_hub.${tabela} WHERE org_id = $1`, [nova]);
    assert.equal(rows[0].n, 1, tabela);
  }
});

test('semear de novo não duplica funil nem etapa', async () => {
  const db = await novoBanco();
  await aplicarMigration(db);
  const nova = await criarOrganizacao(db, 'clinica-b');

  await semearComoOPainel(db, nova);
  await semearComoOPainel(db, nova);

  const funis = await funisDa(db, nova);
  assert.equal(funis.length, 2);
  assert.deepEqual(funis.map((funil) => funil.etapas.length), [6, 4]);
});

test('organização que já tem funil não ganha outro', async () => {
  const db = await novoBanco();
  await aplicarMigration(db);
  const org = await criarOrganizacao(db, 'loja-c');
  await criarFunil(db, org, 'Comercial');

  await semearComoOPainel(db, org);

  assert.deepEqual((await funisDa(db, org)).map((funil) => funil.name), ['Comercial']);
});

test('a migration dá os funis para a organização ativa que existia sem funil e só para ela', async () => {
  const db = await novoBanco();
  const principal = await criarOrganizacao(db, 'principal');
  await criarFunil(db, principal, 'Vendas');
  const semFunil = await criarOrganizacao(db, 'clinica-b');
  const arquivada = await criarOrganizacao(db, 'antiga', 'archived');

  await aplicarMigration(db);

  assert.deepEqual((await funisDa(db, semFunil)).map((funil) => funil.name), ['Vendas', 'Pós-venda']);
  assert.deepEqual((await funisDa(db, principal)).map((funil) => funil.name), ['Vendas']);
  assert.deepEqual(await funisDa(db, arquivada), []);
});

test('aplicar a migration de novo não muda nada', async () => {
  const db = await novoBanco();
  await criarOrganizacao(db, 'clinica-b');
  await aplicarMigration(db);
  const { rows: [antes] } = await db.query('SELECT count(*)::int AS funis, (SELECT count(*)::int FROM whatsapp_hub.stages) AS etapas FROM whatsapp_hub.pipelines');

  await aplicarMigration(db);

  const { rows: [depois] } = await db.query('SELECT count(*)::int AS funis, (SELECT count(*)::int FROM whatsapp_hub.stages) AS etapas FROM whatsapp_hub.pipelines');
  assert.deepEqual(depois, antes);
});

test('só o servidor chama as funções de semente', async () => {
  const db = await novoBanco();
  await aplicarMigration(db);

  const pode = async (papel, funcao) => {
    const { rows } = await db.query('SELECT has_function_privilege($1, $2, $3) AS pode', [papel, funcao, 'EXECUTE']);
    return rows[0].pode;
  };
  for (const funcao of [
    'whatsapp_hub.seed_org_defaults(uuid)',
    'whatsapp_hub.seed_org_pipelines(uuid)',
    'whatsapp_hub.seed_utm_channel_map(uuid)',
  ]) {
    assert.equal(await pode('authenticated', funcao), false, `authenticated em ${funcao}`);
    assert.equal(await pode('anon', funcao), false, `anon em ${funcao}`);
    assert.equal(await pode('service_role', funcao), true, `service_role em ${funcao}`);
  }
});
