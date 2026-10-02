// ============================================================================
// Teste do card que nasce no funil quando chega mensagem de contato novo.
// ----------------------------------------------------------------------------
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado), monta as tabelas
// que o card toca com as colunas do banco que o assistente instala, aplica a
// funcao de atribuicao atual (20260720140000) e depois a correcao deste repo.
//
// O defeito: a mensagem que chega pelo WhatsApp vira contato, conversa e
// mensagem, mas nenhum card nasce no funil. A IA so move negocio aberto, entao
// o contato novo fica parado. A funcao attribute_inbound_lead existia, nao era
// chamada por ninguem e escolhia o funil sem olhar a organizacao.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/card-nasce-no-funil.test.mjs
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATIONS = 'supabase/migrations';
const BASE_MIGRATION = '20260720140000_attribute_instagram_provider.sql';
const FIX_MIGRATION = '20261002120000_card_nasce_na_mensagem_recebida.sql';

// Colunas e tipos copiados do banco instalado pelo assistente (02/10/2026),
// reduzidos ao que o card toca. Os default privileges sao os de
// 20260422120001_init.sql: toda funcao nova do schema nasce com EXECUTE para
// authenticated, entao a migration precisa revogar de forma explicita.
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

CREATE TYPE whatsapp_hub.message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE whatsapp_hub.sender_type AS ENUM ('contact', 'ai', 'operator', 'system', 'owner');
CREATE TYPE whatsapp_hub.content_type AS ENUM ('text', 'image', 'audio', 'video', 'document', 'template', 'note');
CREATE TYPE whatsapp_hub.crm_deal_status AS ENUM ('open', 'won', 'lost');
CREATE TYPE whatsapp_hub.crm_pipeline_kind AS ENUM ('comercial', 'projeto', 'educacao');

CREATE TABLE whatsapp_hub.organizations (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE whatsapp_hub.contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  phone        TEXT,
  name         TEXT,
  instagram_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES whatsapp_hub.organizations(id),
  contact_id     UUID NOT NULL REFERENCES whatsapp_hub.contacts(id),
  channel        TEXT NOT NULL DEFAULT 'whatsapp',
  provider       TEXT NOT NULL DEFAULT 'uazapi',
  active_deal_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES whatsapp_hub.conversations(id),
  direction       whatsapp_hub.message_direction NOT NULL,
  sender_type     whatsapp_hub.sender_type NOT NULL,
  content_type    whatsapp_hub.content_type NOT NULL DEFAULT 'text',
  content         TEXT,
  is_private_note BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  utm_term      TEXT,
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
-- do contato, e a da mensagem e a da conversa.
CREATE FUNCTION whatsapp_hub._org_from_contact() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT org_id INTO NEW.org_id FROM whatsapp_hub.contacts WHERE id = NEW.contact_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_org_from_parent BEFORE INSERT ON whatsapp_hub.deals
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_contact();

CREATE FUNCTION whatsapp_hub._org_from_conversation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT org_id INTO NEW.org_id FROM whatsapp_hub.conversations WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_org_from_parent BEFORE INSERT ON whatsapp_hub.messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_conversation();

-- Dublê do gatilho da IA (20260422120020): mesmo nome e mesmas condicoes. Em
-- vez de chamar a Edge Function, anota se o card ja existia quando ele rodou.
CREATE TABLE public.ia_viu (message_id UUID, tinha_card BOOLEAN);
CREATE FUNCTION whatsapp_hub._on_inbound_message() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.sender_type = 'contact'
     AND COALESCE(NEW.is_private_note, false) = false THEN
    INSERT INTO public.ia_viu VALUES (NEW.id, EXISTS (
      SELECT 1 FROM whatsapp_hub.deals d
        JOIN whatsapp_hub.conversations c ON c.contact_id = d.contact_id
       WHERE c.id = NEW.conversation_id AND d.status = 'open'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_inbound_message AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._on_inbound_message();
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
  // A turma ja tem instalacoes no ar: reaplicar nao pode quebrar nada.
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

// Organizacao como o assistente cria, com uma armadilha: o Pos-venda tambem e
// "comercial" e vem antes na posicao, mas o funil padrao e o Vendas.
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
    await stage(vendas, 'Qualificado', 2);
    await stage(vendas, 'Perdido', 9, false, true);
  }
  const entrega = await pipe('Entrega', 'projeto', 2, false);
  await stage(entrega, 'Kickoff', 0);
  return org.id;
}

async function contact(orgId, { name = null, phone = null, channel = 'whatsapp' } = {}) {
  const c = await one(
    `INSERT INTO whatsapp_hub.contacts (org_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, name, phone],
  );
  const conv = await one(
    `INSERT INTO whatsapp_hub.conversations (org_id, contact_id, channel, provider)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, c.id, channel, channel === 'instagram' ? 'zernio' : 'uazapi'],
  );
  return { id: c.id, conversation: conv.id };
}

async function message(conversationId, { content = 'Oi', direction = 'inbound', sender = 'contact', note = false } = {}) {
  try {
    const row = await one(
      `INSERT INTO whatsapp_hub.messages (conversation_id, direction, sender_type, content, is_private_note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [conversationId, direction, sender, content, note],
    );
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const cardsOf = (contactId) =>
  all(
    `SELECT d.id, d.org_id, d.title, d.status::text AS status, d.attribution_method,
            d.origin_channel, d.traffic_type, d.utm_source, d.tracking_session_id,
            p.name AS funil, p.org_id AS funil_org, s.name AS etapa
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
// A regra central: a primeira mensagem de um contato novo cria o card.
// ---------------------------------------------------------------------------
const ana = await contact(orgA, { name: 'Ana Souza', phone: '5511990000001' });
const first = await message(ana.conversation, { content: 'Oi, quero saber da matrícula' });
const anaCards = await cardsOf(ana.id);
check(
  'primeira mensagem de contato novo cria um card aberto',
  first.ok && anaCards.length === 1 && anaCards[0].status === 'open',
  first.error ?? JSON.stringify(anaCards),
);
check(
  'o card nasce no funil padrão da organização (Vendas), na primeira etapa aberta (Lead)',
  anaCards[0]?.funil === 'Vendas' && anaCards[0]?.etapa === 'Lead' && anaCards[0]?.funil_org === orgA,
  JSON.stringify(anaCards[0] ?? null),
);
check(
  'o card leva o nome do contato e a origem WhatsApp direto',
  anaCards[0]?.title === 'Ana Souza' && anaCards[0]?.attribution_method === 'manual'
    && anaCards[0]?.origin_channel === 'whatsapp_direto',
  JSON.stringify(anaCards[0] ?? null),
);
const iaViu = await one(`SELECT tinha_card FROM public.ia_viu WHERE message_id = $1`, [first.id ?? null]);
check('o card já existe quando o gatilho da IA roda', iaViu?.tinha_card === true, JSON.stringify(iaViu ?? null));

await message(ana.conversation, { content: 'Vocês têm horário à noite?' });
check('a segunda mensagem não cria outro card', (await cardsOf(ana.id)).length === 1);

// ---------------------------------------------------------------------------
// O que nao pode virar card.
// ---------------------------------------------------------------------------
const bruno = await contact(orgA, { name: 'Bruno Lima', phone: '5511990000002' });
await message(bruno.conversation, { direction: 'outbound', sender: 'operator', content: 'Olá, tudo bem?' });
await message(bruno.conversation, { direction: 'outbound', sender: 'ai', content: 'Posso ajudar?' });
check('mensagem enviada pela equipe ou pela IA não cria card', (await cardsOf(bruno.id)).length === 0);

const carla = await contact(orgA, { name: 'Carla Dias', phone: '5511990000003' });
await message(carla.conversation, { content: 'anotação interna', note: true });
check('nota interna não cria card', (await cardsOf(carla.id)).length === 0);

// ---------------------------------------------------------------------------
// Varias organizacoes: o card fica sempre na organizacao do contato.
// ---------------------------------------------------------------------------
const davi = await contact(orgB, { name: 'Davi Rocha', phone: '5511990000004' });
await message(davi.conversation, { content: 'Bom dia' });
const daviCards = await cardsOf(davi.id);
check(
  'contato da organização B ganha card no funil da organização B',
  daviCards.length === 1 && daviCards[0].org_id === orgB && daviCards[0].funil_org === orgB
    && daviCards[0].funil === 'Vendas',
  JSON.stringify(daviCards),
);

// ---------------------------------------------------------------------------
// Contato que ja teve card fechado nao ganha card novo sozinho.
// ---------------------------------------------------------------------------
const elisa = await contact(orgA, { name: 'Elisa Prado', phone: '5511990000005' });
await db.query(
  `INSERT INTO whatsapp_hub.deals (org_id, contact_id, title, status) VALUES ($1, $2, 'Elisa Prado', 'lost')`,
  [orgA, elisa.id],
);
await message(elisa.conversation, { content: 'Oi de novo' });
const elisaCards = await cardsOf(elisa.id);
check(
  'contato com card perdido não ganha card novo automático',
  elisaCards.length === 1 && elisaCards[0].status === 'lost',
  JSON.stringify(elisaCards),
);

// ---------------------------------------------------------------------------
// Atribuicao: codigo de rastreio da propria organizacao, sem apagar origem boa.
// ---------------------------------------------------------------------------
const sessaoA = await one(
  `INSERT INTO whatsapp_hub.tracking_sessions (org_id, short_code, utm_source, utm_campaign)
   VALUES ($1, 'ABC123', 'instagram', 'outubro') RETURNING id`,
  [orgA],
);
const fabio = await contact(orgA, { name: 'Fábio Nunes', phone: '5511990000006' });
await message(fabio.conversation, { content: 'Oi, vim pelo anúncio [ABC123]' });
const fabioCards = await cardsOf(fabio.id);
const sessaoDepois = await one(
  `SELECT deal_id, reconciled_at FROM whatsapp_hub.tracking_sessions WHERE id = $1`,
  [sessaoA.id],
);
check(
  'código de rastreio da organização entra no card e fecha a sessão',
  fabioCards.length === 1 && fabioCards[0].attribution_method === 'codigo_rastreio'
    && fabioCards[0].utm_source === 'instagram' && sessaoDepois?.deal_id === fabioCards[0].id
    && sessaoDepois?.reconciled_at !== null,
  JSON.stringify({ card: fabioCards[0] ?? null, sessao: sessaoDepois }),
);

const sessaoB = await one(
  `INSERT INTO whatsapp_hub.tracking_sessions (org_id, short_code, utm_source)
   VALUES ($1, 'XYZ999', 'google') RETURNING id`,
  [orgB],
);
const gabi = await contact(orgA, { name: 'Gabi Torres', phone: '5511990000007' });
await message(gabi.conversation, { content: 'Oi [XYZ999]' });
const gabiCards = await cardsOf(gabi.id);
const sessaoBDepois = await one(
  `SELECT deal_id FROM whatsapp_hub.tracking_sessions WHERE id = $1`,
  [sessaoB.id],
);
check(
  'código de rastreio de outra organização não é usado',
  gabiCards.length === 1 && gabiCards[0].attribution_method === 'manual' && sessaoBDepois?.deal_id === null,
  JSON.stringify({ card: gabiCards[0] ?? null, sessao: sessaoBDepois }),
);

await db.query(
  `UPDATE whatsapp_hub.deals SET attribution_method = 'ctwa', origin_channel = 'meta_ads', traffic_type = 'pago'
    WHERE contact_id = $1`,
  [ana.id],
);
await message(ana.conversation, { content: 'Mais uma dúvida' });
const anaDepois = (await cardsOf(ana.id))[0];
check(
  'mensagem sem sinal de rastreio não apaga a origem que o card já tinha',
  anaDepois?.attribution_method === 'ctwa' && anaDepois?.origin_channel === 'meta_ads',
  JSON.stringify(anaDepois ?? null),
);

// ---------------------------------------------------------------------------
// Instagram e organizacao sem funil comercial.
// ---------------------------------------------------------------------------
const insta = await contact(orgA, { channel: 'instagram' });
await message(insta.conversation, { content: 'Oi, vi o post' });
const instaCards = await cardsOf(insta.id);
check(
  'mensagem do Instagram cria card com origem orgânica e título de lead do Instagram',
  instaCards.length === 1 && instaCards[0].origin_channel === 'instagram_organico'
    && instaCards[0].title === 'Lead Instagram',
  JSON.stringify(instaCards),
);

const orgC = await organization('Consultoria C', { comercial: false });
const hugo = await contact(orgC, { name: 'Hugo Melo', phone: '5511990000008' });
const semFunil = await message(hugo.conversation, { content: 'Olá' });
check(
  'sem funil comercial a mensagem entra normalmente e nenhum card nasce',
  semFunil.ok && (await cardsOf(hugo.id)).length === 0,
  semFunil.error ?? '',
);

// ---------------------------------------------------------------------------
// Quem pode chamar a funcao de atribuicao.
// ---------------------------------------------------------------------------
const ivo = await contact(orgB, { name: 'Ivo Reis', phone: '5511990000009' });
let denied = null;
try {
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT whatsapp_hub.attribute_inbound_lead($1, 'oi', NULL, 'whatsapp')`, [ivo.id]);
} catch (err) {
  denied = err.message;
} finally {
  await db.exec('RESET ROLE');
}
check(
  'usuário logado não consegue chamar a função de atribuição',
  denied !== null && /permission denied/i.test(denied),
  denied ?? 'a chamada passou',
);

let serviceError = null;
try {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT whatsapp_hub.attribute_inbound_lead($1, 'oi', NULL, 'whatsapp')`, [ivo.id]);
} catch (err) {
  serviceError = err.message;
} finally {
  await db.exec('RESET ROLE');
}
check('o backend (service_role) continua podendo chamar a função', serviceError === null, serviceError ?? '');

console.log(`\n${passed} passaram, ${failed} falharam${hasFix ? '' : ' (banco de hoje, sem a correção)'}`);
process.exit(failed ? 1 : 0);
