// ============================================================================
// Teste do card que nasce pelo formulario da pagina (ingest_landing_lead).
// ----------------------------------------------------------------------------
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado), monta as tabelas
// que o card toca com as colunas do banco que o assistente instala, aplica a
// funcao atual (20260718150000) e depois a correcao deste repo.
//
// O defeito: a funcao escolhia o funil e o codigo de rastreio de qualquer
// organizacao, nao preferia o funil padrao e podia ser chamada por qualquer
// usuario logado (SECURITY DEFINER ignora a RLS).
//
// Diferente da mensagem do WhatsApp, o formulario e um pedido explicito: quem
// preenche de novo depois de um card ganho ou perdido ganha card novo.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/card-do-formulario.test.mjs
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATIONS = 'supabase/migrations';
const BASE_MIGRATION = '20260718150000_ingest_landing_lead.sql';
const FIX_MIGRATION = '20261002130000_card_do_formulario_por_organizacao.sql';

// Colunas copiadas do banco instalado pelo assistente (02/10/2026), reduzidas
// ao que o card toca. Default privileges iguais aos de 20260422120001_init.sql.
const FIXTURE = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA whatsapp_hub;
GRANT USAGE ON SCHEMA whatsapp_hub TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

CREATE TYPE whatsapp_hub.crm_deal_status AS ENUM ('open', 'won', 'lost');
CREATE TYPE whatsapp_hub.crm_pipeline_kind AS ENUM ('comercial', 'projeto', 'educacao');

CREATE TABLE whatsapp_hub.organizations (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE whatsapp_hub.contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  phone      TEXT,
  name       TEXT,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.pipelines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  name       TEXT NOT NULL,
  kind       whatsapp_hub.crm_pipeline_kind NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  pipeline_id UUID NOT NULL REFERENCES whatsapp_hub.pipelines(id),
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  is_won      BOOLEAN NOT NULL DEFAULT false,
  is_lost     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.tracking_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID,
  short_code    TEXT NOT NULL,
  utm_source    TEXT,
  raw_query     JSONB,
  deal_id       UUID,
  reconciled_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.deals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL,
  contact_id          UUID NOT NULL REFERENCES whatsapp_hub.contacts(id),
  pipeline_id         UUID,
  stage_id            UUID,
  title               TEXT NOT NULL,
  status              whatsapp_hub.crm_deal_status NOT NULL DEFAULT 'open',
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,
  utm_content         TEXT,
  utm_term            TEXT,
  traffic_type        TEXT,
  origin_channel      TEXT,
  attribution_method  TEXT,
  raw_tracking        JSONB,
  tracking_session_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dublê do trg_org_from_parent do banco instalado: a organizacao do negocio e a
-- do contato.
CREATE FUNCTION whatsapp_hub._org_from_contact() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT org_id INTO NEW.org_id FROM whatsapp_hub.contacts WHERE id = NEW.contact_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_org_from_parent BEFORE INSERT ON whatsapp_hub.deals
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_contact();
`;

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASSOU  ${name}`);
  } else {
    failed++;
    console.log(`FALHOU  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const db = new PGlite();
await db.exec(FIXTURE);
await db.exec(readFileSync(join(MIGRATIONS, BASE_MIGRATION), 'utf8'));

const fixPath = join(MIGRATIONS, FIX_MIGRATION);
const hasFix = existsSync(fixPath);
if (hasFix) {
  const sql = readFileSync(fixPath, 'utf8');
  await db.exec(sql);
  let twice = null;
  try {
    await db.exec(sql);
  } catch (err) {
    twice = err.message;
  }
  check('migration reaplicada sem erro (idempotente)', twice === null, twice ?? '');
} else {
  console.log(`(sem ${FIX_MIGRATION}: rodando contra o banco de hoje)\n`);
}

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

// A organizacao mais antiga ganha os funis primeiro, como numa instalacao em
// que ela e a principal. O Pos-venda tambem e "comercial" e vem antes na
// posicao, mas o funil padrao e o Vendas.
async function organization(name, { comercial = true } = {}) {
  const org = await one(`INSERT INTO whatsapp_hub.organizations (name) VALUES ($1) RETURNING id`, [name]);
  const pipe = async (pname, kind, position, isDefault) =>
    (await one(
      `INSERT INTO whatsapp_hub.pipelines (org_id, name, kind, position, is_default)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [org.id, pname, kind, position, isDefault],
    )).id;
  const stage = (pipelineId, sname, position, won = false, lost = false) =>
    db.query(
      `INSERT INTO whatsapp_hub.stages (org_id, pipeline_id, name, position, is_won, is_lost)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [org.id, pipelineId, sname, position, won, lost],
    );
  if (comercial) {
    const pos = await pipe('Pós-venda', 'comercial', 0, false);
    await stage(pos, 'Onboarding', 0);
    const vendas = await pipe('Vendas', 'comercial', 1, true);
    await stage(vendas, 'Ganho', 0, true, false);
    await stage(vendas, 'Lead', 1);
    await stage(vendas, 'Perdido', 9, false, true);
  }
  return org.id;
}

const contact = async (orgId, { name = null, phone = null, email = null } = {}) =>
  (await one(
    `INSERT INTO whatsapp_hub.contacts (org_id, name, phone, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, name, phone, email],
  )).id;

async function landing(contactId, utm = {}, shortCode = null) {
  try {
    const row = await one(
      `SELECT whatsapp_hub.ingest_landing_lead($1, $2::jsonb, $3::jsonb, $4) AS r`,
      [contactId, JSON.stringify(utm), JSON.stringify({ page_url: 'https://exemplo.com/lp' }), shortCode],
    );
    return { ok: true, result: row.r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const cardsOf = (contactId) =>
  all(
    `SELECT d.id, d.org_id, d.title, d.status::text AS status, d.attribution_method, d.utm_source,
            d.tracking_session_id, p.name AS funil, p.org_id AS funil_org, s.name AS etapa
       FROM whatsapp_hub.deals d
       LEFT JOIN whatsapp_hub.pipelines p ON p.id = d.pipeline_id
       LEFT JOIN whatsapp_hub.stages s ON s.id = d.stage_id
      WHERE d.contact_id = $1
      ORDER BY d.created_at`,
    [contactId],
  );

const orgA = await organization('Escola A');
const orgB = await organization('Clinica B');

// ---------------------------------------------------------------------------
// O card fica na organizacao do contato, no funil padrao dela.
// ---------------------------------------------------------------------------
const bia = await contact(orgB, { name: 'Bia Campos', phone: '+5511990000020' });
const biaRun = await landing(bia, { utm_source: 'instagram', utm_campaign: 'outubro' });
const biaCards = await cardsOf(bia);
check(
  'formulário de contato da organização B cria card no funil Vendas da organização B',
  biaRun.ok && biaCards.length === 1 && biaCards[0].org_id === orgB && biaCards[0].funil_org === orgB
    && biaCards[0].funil === 'Vendas' && biaCards[0].etapa === 'Lead',
  biaRun.error ?? JSON.stringify(biaCards),
);
check(
  'o card do formulário leva a origem utm_landing e as UTMs',
  biaCards[0]?.attribution_method === 'utm_landing' && biaCards[0]?.utm_source === 'instagram',
  JSON.stringify(biaCards[0] ?? null),
);

await landing(bia, { utm_source: 'google' });
const biaDepois = await cardsOf(bia);
check(
  'o segundo envio do formulário atualiza o card aberto e não cria outro',
  biaDepois.length === 1 && biaDepois[0].utm_source === 'google',
  JSON.stringify(biaDepois),
);

// ---------------------------------------------------------------------------
// Codigo do link de rastreio: so o da propria organizacao.
// ---------------------------------------------------------------------------
const sessaoA = await one(
  `INSERT INTO whatsapp_hub.tracking_sessions (org_id, short_code, utm_source) VALUES ($1, 'LINKA1', 'facebook') RETURNING id`,
  [orgA],
);
const caio = await contact(orgA, { name: 'Caio Brito', phone: '+5511990000021' });
await landing(caio, {}, 'linka1');
const caioCard = (await cardsOf(caio))[0];
const sessaoADepois = await one(`SELECT deal_id FROM whatsapp_hub.tracking_sessions WHERE id = $1`, [sessaoA.id]);
check(
  'código do link da mesma organização liga a sessão ao card',
  caioCard?.tracking_session_id === sessaoA.id && sessaoADepois?.deal_id === caioCard?.id,
  JSON.stringify({ card: caioCard ?? null, sessao: sessaoADepois }),
);

const sessaoB = await one(
  `INSERT INTO whatsapp_hub.tracking_sessions (org_id, short_code, utm_source) VALUES ($1, 'LINKB1', 'tiktok') RETURNING id`,
  [orgB],
);
const dani = await contact(orgA, { name: 'Dani Leite', phone: '+5511990000022' });
await landing(dani, {}, 'LINKB1');
const daniCard = (await cardsOf(dani))[0];
const sessaoBDepois = await one(`SELECT deal_id FROM whatsapp_hub.tracking_sessions WHERE id = $1`, [sessaoB.id]);
check(
  'código do link de outra organização não é usado',
  daniCard && daniCard.tracking_session_id === null && sessaoBDepois?.deal_id === null,
  JSON.stringify({ card: daniCard ?? null, sessao: sessaoBDepois }),
);

// ---------------------------------------------------------------------------
// Formulario e pedido explicito: quem volta depois de card fechado ganha card.
// ---------------------------------------------------------------------------
const edu = await contact(orgA, { name: 'Edu Vaz', phone: '+5511990000023' });
await db.query(
  `INSERT INTO whatsapp_hub.deals (org_id, contact_id, title, status) VALUES ($1, $2, 'Edu Vaz', 'lost')`,
  [orgA, edu],
);
await landing(edu, { utm_source: 'instagram' });
const eduCards = await cardsOf(edu);
check(
  'contato com card perdido que preenche o formulário de novo ganha card novo',
  eduCards.length === 2 && eduCards.filter((c) => c.status === 'open').length === 1,
  JSON.stringify(eduCards),
);

// ---------------------------------------------------------------------------
// Titulo e organizacao sem funil comercial.
// ---------------------------------------------------------------------------
const semNome = await contact(orgA, { email: 'lead@exemplo.com' });
await landing(semNome, {});
check(
  'sem nome nem telefone, o card usa o e-mail como título',
  (await cardsOf(semNome))[0]?.title === 'lead@exemplo.com',
);

const orgC = await organization('Consultoria C', { comercial: false });
const fabi = await contact(orgC, { name: 'Fabi Leme', phone: '+5511990000024' });
const semFunil = await landing(fabi, {});
check(
  'organização sem funil comercial não quebra o formulário e não cria card',
  semFunil.ok && (await cardsOf(fabi)).length === 0,
  semFunil.error ?? JSON.stringify(await cardsOf(fabi)),
);

// ---------------------------------------------------------------------------
// Quem pode chamar a funcao.
// ---------------------------------------------------------------------------
const gil = await contact(orgB, { name: 'Gil Prates', phone: '+5511990000025' });
let denied = null;
try {
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT whatsapp_hub.ingest_landing_lead($1, '{}'::jsonb, NULL, NULL)`, [gil]);
} catch (err) {
  denied = err.message;
} finally {
  await db.exec('RESET ROLE');
}
check(
  'usuário logado não consegue chamar a função do formulário',
  denied !== null && /permission denied/i.test(denied),
  denied ?? 'a chamada passou',
);

let serviceError = null;
try {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT whatsapp_hub.ingest_landing_lead($1, '{}'::jsonb, NULL, NULL)`, [gil]);
} catch (err) {
  serviceError = err.message;
} finally {
  await db.exec('RESET ROLE');
}
check('o backend (service_role) continua podendo chamar a função', serviceError === null, serviceError ?? '');

console.log(`\n${passed} passaram, ${failed} falharam${hasFix ? '' : ' (banco de hoje, sem a correção)'}`);
process.exit(failed ? 1 : 0);
