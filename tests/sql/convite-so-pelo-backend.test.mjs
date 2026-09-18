// ============================================================================
// Teste de regressao do gatilho de cadastro (whatsapp_hub.handle_new_user).
// ----------------------------------------------------------------------------
// Sobe um Postgres embutido (PGlite, WASM, nada hospedado), monta o minimo que
// o Supabase e as migrations antigas fornecem, aplica as migrations de convite
// DESTE repo e confere a regra: convite so nasce pelo backend.
//
// O gatilho antigo aceitava como convite qualquer usuario novo cujo
// raw_user_meta_data trouxesse invited_role + invited_org_id. Esse metadata e
// escrito pelo cliente no cadastro, entao o teste cria usuarios do jeito que o
// GoTrue cria (INSERT em auth.users) e confere quem entra e quem e recusado.
//
// Como rodar (nao adiciona dependencia ao projeto):
//   npm i --no-save @electric-sql/pglite
//   node tests/sql/convite-so-pelo-backend.test.mjs
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const MIGRATIONS = 'supabase/migrations';
const BASE_MIGRATION = '20260819120000_convite_por_link.sql';
const FIX_MIGRATION = '20260918120000_convite_so_pelo_backend.sql';

// O que o Supabase e as migrations anteriores ja entregam, reduzido ao que o
// gatilho toca. Os default privileges sao os de 20260422120001_init.sql: toda
// funcao nova do schema nasce com EXECUTE para authenticated, entao a migration
// precisa revogar de forma explicita.
const FIXTURE = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT,
  encrypted_password TEXT,
  raw_user_meta_data JSONB,
  raw_app_meta_data  JSONB,
  email_confirmed_at TIMESTAMPTZ,
  invited_at         TIMESTAMPTZ,
  last_sign_in_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SCHEMA whatsapp_hub;
GRANT USAGE ON SCHEMA whatsapp_hub TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

CREATE TYPE whatsapp_hub.tenant_role AS ENUM ('admin', 'operator');

CREATE TABLE whatsapp_hub.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_hub.app_users (
  user_id        UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id         UUID REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  role           whatsapp_hub.tenant_role NOT NULL,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  accepted_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const TRIGGER = `
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.handle_new_user();
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
await db.exec(TRIGGER);

const fixPath = join(MIGRATIONS, FIX_MIGRATION);
const hasFix = existsSync(fixPath);
if (hasFix) {
  const sql = readFileSync(fixPath, 'utf8');
  await db.exec(sql);
  // Idempotencia: a turma ja esta no ar, reaplicar nao pode quebrar nada.
  let twice = null;
  try {
    await db.exec(sql);
  } catch (err) {
    twice = err.message;
  }
  check('migration reaplicada sem erro (idempotente)', twice === null, twice ?? '');
} else {
  console.log(`(sem ${FIX_MIGRATION}: rodando contra o gatilho antigo)\n`);
}

// Cria um usuario do jeito que o GoTrue cria: INSERT em auth.users. O gatilho
// roda dentro do mesmo comando, entao excecao dele desfaz o insert.
async function createUser(email, meta, extra = {}) {
  try {
    const res = await db.query(
      `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
      [email, extra.password ?? null, JSON.stringify(meta ?? {}), extra.confirmedAt ?? null],
    );
    return { ok: true, id: res.rows[0].id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function membership(userId) {
  const res = await db.query(
    `SELECT au.role::text AS role, au.org_id, au.is_super_admin, au.accepted_at,
            u.raw_app_meta_data AS app_meta, u.raw_user_meta_data AS user_meta
       FROM whatsapp_hub.app_users au JOIN auth.users u ON u.id = au.user_id
      WHERE au.user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

async function registerInvite(email, orgId, role, invitedBy = null) {
  const res = await db.query(
    'SELECT whatsapp_hub.register_pending_invite($1, $2, $3, $4) AS token',
    [email, orgId, role, invitedBy],
  );
  return res.rows[0].token;
}

// ---------------------------------------------------------------------------
// Cenario: instalacao com owner e duas organizacoes ativas.
// ---------------------------------------------------------------------------
const owner = await createUser('owner@exemplo.com', { created_via: 'setup_wizard' }, {
  password: 'hash', confirmedAt: new Date().toISOString(),
});
const ownerRow = owner.ok ? await membership(owner.id) : null;
check(
  'primeiro usuario vira admin e super admin da organizacao padrao',
  owner.ok && ownerRow?.role === 'admin' && ownerRow?.is_super_admin === true && ownerRow?.accepted_at !== null,
  owner.error ?? JSON.stringify(ownerRow),
);

const orgA = ownerRow?.org_id;
const orgB = (await db.query(
  `INSERT INTO whatsapp_hub.organizations (name, slug) VALUES ('Cliente B', 'cliente-b') RETURNING id`,
)).rows[0].id;

// ---------------------------------------------------------------------------
// A regra central: metadata escrito pelo cliente nao vale como convite.
// ---------------------------------------------------------------------------
const forged = await createUser(
  'intruso@exemplo.com',
  { invited_role: 'admin', invited_org_id: orgA },
  { password: 'hash' },
);
check(
  'cadastro com invited_role + invited_org_id no metadata, sem convite do backend, e recusado',
  forged.ok === false,
  forged.ok ? `entrou como ${JSON.stringify(await membership(forged.id))}` : '',
);

const orphans = await db.query(
  `SELECT count(*)::int AS n FROM auth.users WHERE email = 'intruso@exemplo.com'`,
);
check('cadastro recusado nao deixa usuario para tras', orphans.rows[0].n === 0);

const plain = await createUser('curioso@exemplo.com', {}, { password: 'hash' });
check('cadastro sem metadata nenhum continua recusado', plain.ok === false);

if (!hasFix) {
  console.log(`\n${passed} passaram, ${failed} falharam (gatilho antigo)`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Daqui para baixo: comportamento do convite registrado pelo backend.
// ---------------------------------------------------------------------------
const guessed = await createUser(
  'intruso2@exemplo.com',
  { invited_role: 'admin', invited_org_id: orgA, invite_token: 'a'.repeat(64) },
  { password: 'hash' },
);
check('token inventado e recusado', guessed.ok === false);

const tokenOp = await registerInvite('Vendedora@Exemplo.com', orgA, 'operator', owner.id);
check('register_pending_invite devolve token de 64 caracteres', /^[0-9a-f]{64}$/.test(tokenOp ?? ''));

const stored = await db.query(
  `SELECT token_hash, email, invited_by FROM whatsapp_hub.pending_invites WHERE lower(email) = 'vendedora@exemplo.com'`,
);
check(
  'banco guarda so o hash do token, com e-mail normalizado e quem convidou',
  stored.rows.length === 1 &&
    stored.rows[0].token_hash !== tokenOp &&
    stored.rows[0].email === 'vendedora@exemplo.com' &&
    stored.rows[0].invited_by === owner.id,
  JSON.stringify(stored.rows),
);

const wrongEmail = await createUser(
  'outra@exemplo.com',
  { invited_role: 'operator', invited_org_id: orgA, invite_token: tokenOp },
);
check('token valido com e-mail diferente do convidado e recusado', wrongEmail.ok === false);

// Papel e organizacao saem do registro: o metadata pede admin da org B, o
// convite registrado era operator da org A.
const invited = await createUser(
  'vendedora@exemplo.com',
  { invited_role: 'admin', invited_org_id: orgB, invite_token: tokenOp },
);
const invitedRow = invited.ok ? await membership(invited.id) : null;
check(
  'convite registrado entra, com papel e organizacao do REGISTRO e nao do metadata',
  invited.ok && invitedRow?.role === 'operator' && invitedRow?.org_id === orgA && invitedRow?.is_super_admin === false,
  invited.error ?? JSON.stringify(invitedRow),
);
check(
  'claims do JWT (raw_app_meta_data) seguem o registro',
  invitedRow?.app_meta?.role === 'operator' &&
    invitedRow?.app_meta?.org_id === orgA &&
    invitedRow?.app_meta?.is_super_admin === false,
  JSON.stringify(invitedRow?.app_meta),
);
check('convidado nasce pendente ate confirmar o e-mail', invitedRow?.accepted_at === null);
check(
  'token sai do metadata do usuario depois de usado',
  invitedRow !== null && !('invite_token' in (invitedRow.user_meta ?? {})),
  JSON.stringify(invitedRow?.user_meta),
);

const consumed = await db.query(
  `SELECT consumed_at, consumed_by FROM whatsapp_hub.pending_invites WHERE lower(email) = 'vendedora@exemplo.com'`,
);
check(
  'registro fica marcado como usado, apontando para o usuario criado',
  consumed.rows[0]?.consumed_at !== null && consumed.rows[0]?.consumed_by === invited.id,
);

await db.query(`DELETE FROM auth.users WHERE id = $1`, [invited.id]);
const reuse = await createUser(
  'vendedora@exemplo.com',
  { invited_role: 'operator', invited_org_id: orgA, invite_token: tokenOp },
);
check('token ja usado nao vale de novo (uso unico)', reuse.ok === false);

const tokenExp = await registerInvite('atrasado@exemplo.com', orgA, 'operator', owner.id);
await db.query(
  `UPDATE whatsapp_hub.pending_invites SET expires_at = now() - interval '1 minute' WHERE lower(email) = 'atrasado@exemplo.com'`,
);
const expired = await createUser('atrasado@exemplo.com', { invite_token: tokenExp });
check('registro vencido e recusado', expired.ok === false);

const tokenArch = await registerInvite('cliente@exemplo.com', orgB, 'admin', owner.id);
await db.query(`UPDATE whatsapp_hub.organizations SET status = 'archived' WHERE id = $1`, [orgB]);
const archived = await createUser('cliente@exemplo.com', { invite_token: tokenArch });
check('organizacao arquivada depois do registro recusa o convite', archived.ok === false);
await db.query(`UPDATE whatsapp_hub.organizations SET status = 'active' WHERE id = $1`, [orgB]);

const tokenOld = await registerInvite('gerente@exemplo.com', orgA, 'operator', owner.id);
const tokenNew = await registerInvite('gerente@exemplo.com', orgA, 'admin', owner.id);
const stale = await createUser('gerente@exemplo.com', { invite_token: tokenOld });
const fresh = await createUser('gerente@exemplo.com', { invite_token: tokenNew });
const freshRow = fresh.ok ? await membership(fresh.id) : null;
check(
  'convite refeito invalida o token anterior e vale o mais novo',
  stale.ok === false && fresh.ok && freshRow?.role === 'admin' && freshRow?.org_id === orgA,
  JSON.stringify({ stale: stale.ok, fresh: fresh.ok, freshRow }),
);

async function registerFails(email, orgId, role) {
  try {
    await registerInvite(email, orgId, role);
    return false;
  } catch {
    return true;
  }
}
check('registro recusa papel fora de admin/operator', await registerFails('x@exemplo.com', orgA, 'owner'));
check('registro recusa e-mail vazio', await registerFails('   ', orgA, 'operator'));
check(
  'registro recusa organizacao inexistente',
  await registerFails('x@exemplo.com', '00000000-0000-0000-0000-000000000000', 'operator'),
);

// ---------------------------------------------------------------------------
// Privilegios: so a service_role registra convite e enxerga a tabela. Sem o
// REVOKE explicito, os default privileges do schema dariam EXECUTE a qualquer
// usuario logado, que registraria um convite de admin para si mesmo.
// ---------------------------------------------------------------------------
const FN = 'whatsapp_hub.register_pending_invite(text, uuid, text, uuid)';
const priv = (await db.query(
  `SELECT has_function_privilege('anon', $1, 'EXECUTE')          AS fn_anon,
          has_function_privilege('authenticated', $1, 'EXECUTE') AS fn_auth,
          has_function_privilege('service_role', $1, 'EXECUTE')  AS fn_service,
          has_table_privilege('anon', 'whatsapp_hub.pending_invites', 'SELECT')          AS tb_anon,
          has_table_privilege('authenticated', 'whatsapp_hub.pending_invites', 'SELECT') AS tb_auth,
          has_table_privilege('authenticated', 'whatsapp_hub.pending_invites', 'INSERT') AS tb_auth_ins,
          has_table_privilege('service_role', 'whatsapp_hub.pending_invites', 'SELECT')  AS tb_service`,
  [FN],
)).rows[0];
check('anon e authenticated nao executam register_pending_invite', !priv.fn_anon && !priv.fn_auth, JSON.stringify(priv));
check('service_role executa register_pending_invite', priv.fn_service === true);
check(
  'anon e authenticated nao leem nem escrevem em pending_invites',
  !priv.tb_anon && !priv.tb_auth && !priv.tb_auth_ins,
  JSON.stringify(priv),
);
check('service_role le pending_invites', priv.tb_service === true);

const rls = (await db.query(
  `SELECT relrowsecurity FROM pg_class WHERE oid = 'whatsapp_hub.pending_invites'::regclass`,
)).rows[0];
check('pending_invites tem RLS ligado e nenhuma policy', rls.relrowsecurity === true && (await db.query(
  `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'whatsapp_hub' AND tablename = 'pending_invites'`,
)).rows[0].n === 0);

let asAuthenticated = 'executou';
try {
  await db.exec('SET ROLE authenticated');
  await db.query('SELECT whatsapp_hub.register_pending_invite($1, $2, $3, $4)', ['eu@exemplo.com', orgA, 'admin', null]);
} catch (err) {
  asAuthenticated = err.message;
} finally {
  await db.exec('RESET ROLE');
}
check(
  'usuario logado tentando registrar convite para si recebe permissao negada',
  /permission denied/i.test(asAuthenticated),
  asAuthenticated,
);

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
