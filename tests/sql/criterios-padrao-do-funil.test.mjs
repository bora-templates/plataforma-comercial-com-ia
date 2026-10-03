// ============================================================================
// Critérios padrão da IA nas etapas do funil.
// ----------------------------------------------------------------------------
// A IA só move o card para etapas com critério (stages.ai_criteria), e o funil
// que a instalação cria nascia sem critério nenhum: numa instalação nova a IA
// não movia card. A migration preenche os critérios das etapas com os nomes
// padrão que nunca tiveram critério (NULL). O que o dono escreveu, ou apagou
// (texto vazio), fica como está. A tela cria funil novo com os mesmos textos
// (src/lib/criterios-padrao.ts), e o primeiro teste confere que os dois batem.
//
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado) com as colunas de
// funil e etapa do banco que o assistente instala, reduzidas ao que a
// migration toca.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/criterios-padrao-do-funil.test.mjs
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { CRITERIOS_PADRAO, etapasDoFunilNovo } from '../../src/lib/criterios-padrao.ts';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATION = 'supabase/migrations/20261002150000_criterios_padrao_da_ia_no_funil.sql';

const FIXTURE = `
CREATE SCHEMA whatsapp_hub;
CREATE TYPE whatsapp_hub.crm_pipeline_kind AS ENUM ('comercial', 'projeto', 'educacao');

CREATE TABLE whatsapp_hub.pipelines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL,
  name       TEXT NOT NULL,
  kind       whatsapp_hub.crm_pipeline_kind NOT NULL DEFAULT 'comercial',
  position   INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE whatsapp_hub.stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  pipeline_id UUID NOT NULL REFERENCES whatsapp_hub.pipelines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INT NOT NULL DEFAULT 0,
  is_won      BOOLEAN NOT NULL DEFAULT false,
  is_lost     BOOLEAN NOT NULL DEFAULT false,
  probability INT DEFAULT 50,
  ai_criteria TEXT
);
`;

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';

// Funis que a instalação cria (20260630120000_crm_layer.sql).
const VENDAS = [
  { nome: 'Chegou agora' },
  { nome: 'Em conversa' },
  { nome: 'Recebeu oferta' },
  { nome: 'Decidindo' },
  { nome: 'Fechou', ganho: true },
  { nome: 'Não fechou', perdido: true },
];
const POS_VENDA = [
  { nome: 'Onboarding' },
  { nome: 'Em andamento' },
  { nome: 'Acompanhamento' },
  { nome: 'Concluído', ganho: true },
];
// Funil que a tela criava antes desta versão (usePipeline.createPipeline).
const FUNIL_DA_TELA = [
  { nome: 'Chegou agora' },
  { nome: 'Em conversa' },
  { nome: 'Fechou', ganho: true },
  { nome: 'Não fechou', perdido: true },
];

async function novoBanco() {
  const db = new PGlite();
  await db.exec(FIXTURE);
  return db;
}

async function criarFunil(db, { nome, etapas, org = ORG_A, tipo = 'comercial', criterios = {} }) {
  const { rows: [funil] } = await db.query(
    'INSERT INTO whatsapp_hub.pipelines (org_id, name, kind) VALUES ($1, $2, $3) RETURNING id',
    [org, nome, tipo],
  );
  for (const [posicao, etapa] of etapas.entries()) {
    await db.query(
      `INSERT INTO whatsapp_hub.stages (org_id, pipeline_id, name, position, is_won, is_lost, ai_criteria)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [org, funil.id, etapa.nome, posicao, etapa.ganho ?? false, etapa.perdido ?? false,
        etapa.nome in criterios ? criterios[etapa.nome] : null],
    );
  }
  return funil.id;
}

async function aplicarMigration(db) {
  assert.ok(existsSync(MIGRATION), `migration ausente: ${MIGRATION}`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
}

async function criteriosDoFunil(db, funilId) {
  const { rows } = await db.query(
    'SELECT name, ai_criteria FROM whatsapp_hub.stages WHERE pipeline_id = $1 ORDER BY position',
    [funilId],
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.ai_criteria]));
}

test('instalação nova: o funil Vendas ganha os critérios padrão e o Pós-venda fica sem', async () => {
  const db = await novoBanco();
  const vendas = await criarFunil(db, { nome: 'Vendas', etapas: VENDAS });
  const posVenda = await criarFunil(db, { nome: 'Pós-venda', etapas: POS_VENDA });

  await aplicarMigration(db);

  assert.deepEqual(await criteriosDoFunil(db, vendas), {
    'Chegou agora': null,
    'Em conversa': CRITERIOS_PADRAO['Em conversa'],
    'Recebeu oferta': CRITERIOS_PADRAO['Recebeu oferta'],
    Decidindo: CRITERIOS_PADRAO.Decidindo,
    Fechou: CRITERIOS_PADRAO.Fechou,
    'Não fechou': CRITERIOS_PADRAO['Não fechou'],
  });
  assert.deepEqual(Object.values(await criteriosDoFunil(db, posVenda)), [null, null, null, null]);
});

test('critério que o dono escreveu fica como está', async () => {
  const db = await novoBanco();
  const vendas = await criarFunil(db, {
    nome: 'Vendas', etapas: VENDAS, criterios: { Decidindo: 'Pediu o contrato para revisar.' },
  });

  await aplicarMigration(db);

  const criterios = await criteriosDoFunil(db, vendas);
  assert.equal(criterios.Decidindo, 'Pediu o contrato para revisar.');
  assert.equal(criterios.Fechou, CRITERIOS_PADRAO.Fechou);
});

test('critério que o dono apagou continua apagado', async () => {
  const db = await novoBanco();
  const vendas = await criarFunil(db, { nome: 'Vendas', etapas: VENDAS, criterios: { Fechou: '' } });

  await aplicarMigration(db);

  const criterios = await criteriosDoFunil(db, vendas);
  assert.equal(criterios.Fechou, '');
  assert.equal(criterios['Não fechou'], CRITERIOS_PADRAO['Não fechou']);
});

test('funil criado pela tela, em qualquer organização, ganha os critérios nas etapas com nome padrão', async () => {
  const db = await novoBanco();
  const daTela = await criarFunil(db, { nome: 'Comercial B2B', etapas: FUNIL_DA_TELA, org: ORG_B });

  await aplicarMigration(db);

  assert.deepEqual(await criteriosDoFunil(db, daTela), {
    'Chegou agora': null,
    'Em conversa': CRITERIOS_PADRAO['Em conversa'],
    Fechou: CRITERIOS_PADRAO.Fechou,
    'Não fechou': CRITERIOS_PADRAO['Não fechou'],
  });
});

test('etapa com nome padrão e outro papel fica sem critério', async () => {
  const db = await novoBanco();
  // O dono tirou a marca de ganho de "Fechou" e a de perdido de "Não fechou":
  // o critério padrão marcaria ganho ou perda numa etapa que não é mais isso.
  const funil = await criarFunil(db, {
    nome: 'Vendas',
    etapas: [{ nome: 'Em conversa' }, { nome: 'Fechou' }, { nome: 'Não fechou' }, { nome: 'Decidindo', ganho: true }],
  });

  await aplicarMigration(db);

  assert.deepEqual(await criteriosDoFunil(db, funil), {
    'Em conversa': CRITERIOS_PADRAO['Em conversa'],
    Fechou: null,
    'Não fechou': null,
    Decidindo: null,
  });
});

test('funil de outro tipo fica de fora', async () => {
  const db = await novoBanco();
  const educacao = await criarFunil(db, { nome: 'Turmas', etapas: VENDAS, tipo: 'educacao' });

  await aplicarMigration(db);

  assert.deepEqual(Object.values(await criteriosDoFunil(db, educacao)), [null, null, null, null, null, null]);
});

test('aplicar a migration de novo não muda nada', async () => {
  const db = await novoBanco();
  const vendas = await criarFunil(db, { nome: 'Vendas', etapas: VENDAS, criterios: { Decidindo: 'Pediu o contrato.' } });

  await aplicarMigration(db);
  const depoisDaPrimeira = await criteriosDoFunil(db, vendas);
  await aplicarMigration(db);

  assert.deepEqual(await criteriosDoFunil(db, vendas), depoisDaPrimeira);
});

test('a tela cria funil novo com os mesmos critérios', () => {
  const etapas = etapasDoFunilNovo('funil-1');
  assert.deepEqual(
    etapas.map(({ name, is_won, is_lost, ai_criteria }) => ({ name, is_won, is_lost, ai_criteria })),
    [
      { name: 'Chegou agora', is_won: false, is_lost: false, ai_criteria: null },
      { name: 'Em conversa', is_won: false, is_lost: false, ai_criteria: CRITERIOS_PADRAO['Em conversa'] },
      { name: 'Fechou', is_won: true, is_lost: false, ai_criteria: CRITERIOS_PADRAO.Fechou },
      { name: 'Não fechou', is_won: false, is_lost: true, ai_criteria: CRITERIOS_PADRAO['Não fechou'] },
    ],
  );
  assert.ok(etapas.every((etapa) => etapa.pipeline_id === 'funil-1'));
  assert.deepEqual(etapas.map((etapa) => etapa.position), [0, 1, 2, 3]);
});
