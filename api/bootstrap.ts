import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type BootstrapBody = {
  supabase_url?: string;
  supabase_anon_key?: string;
  supabase_service_role_key?: string;
  supabase_pat?: string;
  vercel_token?: string;
  owner_email?: string;
  owner_password?: string;
  vercel_project_id?: string;
};

type ApiRequest = {
  method?: string;
  body?: BootstrapBody;
  headers: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

const BOOTSTRAP_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public._bootstrap_state (
  step text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);
ALTER TABLE public._bootstrap_state ENABLE ROW LEVEL SECURITY;
`;

function jsonString(value: unknown) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function projectRef(url: string) {
  const match = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)$/i);
  if (!match) throw new Error('SUPABASE_URL invalida.');
  return match[1];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A Management API tem rate limit (~60 req/min). Um 429 no meio das migrations
// derrubava o bootstrap com o banco meio migrado — a origem da cascata de
// "already exists"/"does not exist" nas retentativas. Retry com backoff
// progressivo: espera a janela do throttler abrir em vez de falhar.
async function supabaseQuery(ref: string, pat: string, query: string) {
  const BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < BACKOFF_MS.length) {
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Supabase database/query ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
}

async function mark(ref: string, pat: string, step: string, metadata: unknown = {}) {
  await supabaseQuery(
    ref,
    pat,
    `INSERT INTO public._bootstrap_state (step, completed_at, metadata)
     VALUES ('${step.replaceAll("'", "''")}', now(), '${jsonString(metadata)}'::jsonb)
     ON CONFLICT (step) DO NOTHING;`,
  );
}

async function hasStep(ref: string, pat: string, step: string) {
  const rows = await supabaseQuery(
    ref,
    pat,
    `SELECT step FROM public._bootstrap_state WHERE step = '${step.replaceAll("'", "''")}';`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getStepMetadata(ref: string, pat: string, step: string) {
  const rows = await supabaseQuery(
    ref,
    pat,
    `SELECT metadata FROM public._bootstrap_state WHERE step = '${step.replaceAll("'", "''")}';`,
  );
  return Array.isArray(rows) && rows[0]?.metadata
    ? (rows[0].metadata as Record<string, unknown>)
    : null;
}

function substitute(sql: string, body: Required<BootstrapBody>, cryptoKey: string) {
  return sql
    .replaceAll('__SUPABASE_URL__', body.supabase_url)
    .replaceAll('__SUPABASE_SERVICE_ROLE_KEY__', body.supabase_service_role_key)
    .replaceAll('__WHATSAPP_HUB_ENCRYPTION_KEY__', cryptoKey);
}

// Bootstrap re-executado sobre um banco que JÁ está migrado (checkpoint em
// _bootstrap_state perdido/resetado, mas o schema intacto) replaya as migrations
// do zero. Cada migration roda atômica via a Management API (uma transação
// implícita por chamada), então dois tipos de erro significam apenas "esta
// migration já foi conciliada num run anterior":
//   1. Objeto JÁ EXISTE (duplicate_*)      — a migration já criou tudo antes.
//   2. Objeto NÃO EXISTE (undefined_*)      — uma migration POSTERIOR já removeu
//      o alvo (ex.: drop_multitenant tirou contacts.tenant_id), então o replay
//      de uma migration antiga que referencia esse alvo não tem o que fazer.
// Num banco NOVO nenhum desses dispara (as migrations rodam em ordem correta),
// então tolerar aqui só age no cenário de replay — mantém o bootstrap
// re-executável sem depender de cada migration antiga ser idempotente.
const RECONCILED_SQLSTATES = [
  // já existe
  '42710', // duplicate_object (type/enum, trigger, policy...)
  '42P07', // duplicate_table
  '42P06', // duplicate_schema
  '42701', // duplicate_column
  '42723', // duplicate_function
  '42P16', // invalid_table_definition (ex.: constraint já existe)
  '42711', // duplicate_object (constraint)
  // não existe (removido por migration posterior no run anterior)
  '42703', // undefined_column
  '42P01', // undefined_table
  '42704', // undefined_object
  '42883', // undefined_function
];

function isAlreadyAppliedError(message: string): boolean {
  return (
    RECONCILED_SQLSTATES.some((code) => message.includes(code)) ||
    /already exists|does not exist/i.test(message)
  );
}

// Antes: 3 chamadas por migration (hasStep + migration + mark) × 58 arquivos
// ≈ 174 requests — estourava o rate limit da Management API (429) no meio do
// run, deixando o banco meio migrado. Agora: 1 SELECT único dos checkpoints +
// 1 chamada por migration pendente, com o INSERT do checkpoint embutido na
// MESMA chamada (atômico: ou aplica-e-marca, ou nada).
async function runMigrations(ref: string, pat: string, body: Required<BootstrapBody>, cryptoKey: string) {
  const files = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort();

  const rows = await supabaseQuery(
    ref,
    pat,
    `SELECT step FROM public._bootstrap_state WHERE step LIKE 'migration:%';`,
  );
  const applied = new Set(
    (Array.isArray(rows) ? rows : []).map((row: { step: string }) => row.step),
  );

  for (const file of files) {
    const step = `migration:${file}`;
    if (applied.has(step)) continue;
    const raw = readFileSync(join('supabase/migrations', file), 'utf8');
    const markSql = `INSERT INTO public._bootstrap_state (step, completed_at, metadata)
      VALUES ('${step.replaceAll("'", "''")}', now(), '{}'::jsonb)
      ON CONFLICT (step) DO NOTHING;`;
    try {
      await supabaseQuery(ref, pat, `${substitute(raw, body, cryptoKey)}\n${markSql}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Erros de "já existe"/"não existe" = replay sobre banco já migrado num
      // run anterior (ver RECONCILED_SQLSTATES). Marca e segue; o resto propaga.
      if (!isAlreadyAppliedError(message)) throw err;
      console.log(JSON.stringify({ event: 'migration_already_applied', file, detail: message.slice(0, 120) }));
      await mark(ref, pat, step);
    }
  }
}

// Aponta os e-mails do Supabase Auth (convite, reset de senha, magic link)
// para o domínio real do app. Sem isso o Site URL fica no default
// http://localhost:3000 e o botão do e-mail de convite leva para localhost —
// o redirectTo do inviteUserByEmail só é honrado se a URL estiver na
// allow-list, então configuramos site_url + uri_allow_list de uma vez.
async function configureAuthUrls(ref: string, pat: string, appUrl: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      site_url: appUrl,
      uri_allow_list: `${appUrl}/**`,
    }),
  });
  if (!res.ok) throw new Error(`Falha ao configurar URLs do Auth: ${await res.text()}`);
}

// URL pública do app = domínio onde o wizard está rodando (o deploy da Vercel).
function requestAppUrl(req: ApiRequest): string | null {
  const forwarded = req.headers['x-forwarded-host'] ?? req.headers.host;
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!host || /localhost|127\.0\.0\.1/.test(host)) return null;
  return `https://${host}`;
}

async function setSupabaseSecrets(ref: string, pat: string, cryptoKey: string) {
  // SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetadas automaticamente nas
  // Edge Functions pelo runtime do Supabase — não podem ser setadas como secret
  // (a Management API rejeita o prefixo reservado SUPABASE_). Só a CRYPTO_KEY,
  // que é custom (decifra public.app_settings), precisa ser setada aqui.
  const secrets = [
    { name: 'CRYPTO_KEY', value: cryptoKey },
  ];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(secrets),
  });
  if (!res.ok) throw new Error(`Falha ao setar secrets Supabase: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Edge Function bundler: resolve ../_shared/* imports inline
// ---------------------------------------------------------------------------
// The Management API deploys raw source without bundling _shared/
// dependencies, so relative imports to _shared/ resolve to nowhere at
// runtime. We read the _shared/ files and inline them into the function
// source before sending it to the API.
// ---------------------------------------------------------------------------

const SHARED_DIR = 'supabase/functions/_shared';
const IMPORT_RE = /import\s+([^;'"]*?)\s+from\s+['"]\.\.\/_shared\/([^'"]+)['"]\s*;?\s*\n?/g;
// Dentro de _shared/: cobre `import ... from './x'`, `import type ...`,
// `export * from './x'` e `export { X } from './x'` — inclusive em subpastas
// (ex.: uma subpasta de _shared/). A clause exclui aspas/; para não engolir código.
const SHARED_RELATIVE_RE = /(?:import|export)\s+([^;'"]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]\s*;?\s*\n?/g;
const EXPORT_RE = /^export\s+(default\s+)?/gm;

// Arquivos já inlinados no bundle corrente. Cada arquivo entra UMA vez — o 2º
// import do mesmo módulo vira string vazia (as declarações já estão no escopo).
// Sem isso, três arquivos importando './types.ts' duplicariam as declarações e
// o Deno rejeitaria o bundle com "identifier already declared".
const sharedInlined = new Set<string>();

// Normaliza "whatsapp/../cors.ts" → "cors.ts", "./x" → "x" (paths relativos ao
// diretório _shared/).
function normalizeSharedPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function loadSharedFile(name: string): string {
  const norm = normalizeSharedPath(name);
  if (sharedInlined.has(norm)) return '';
  sharedInlined.add(norm);
  const path = join(SHARED_DIR, norm);
  if (!existsSync(path)) {
    throw new Error(`_shared/${norm} not found`);
  }
  let source = readFileSync(path, 'utf8');
  // Imports/re-exports relativos resolvem contra o diretório DESTE arquivo
  // (ex.: dentro de _shared/sub/index.ts, './types.ts' → sub/types.ts).
  const dir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
  source = source.replace(SHARED_RELATIVE_RE, (_match, _clause, modulePath: string) => {
    const target = dir ? `${dir}/${modulePath}` : modulePath;
    return loadSharedFile(target);
  });
  // Remove `export` para as declarações não vazarem como exports do bundle.
  return source.replace(EXPORT_RE, '');
}

// Hoista e deduplica imports externos (https:/npm:/jsr:/node:) para o topo do
// bundle. Ao inlinar vários _shared no mesmo escopo, dois arquivos que importam
// o MESMO símbolo externo (ex.: `createClient` em supabase-admin.ts E em
// credentials.ts) geram duas declarações → Deno rejeita o worker com
// "Identifier 'createClient' has already been declared" (BOOT_ERROR). Aqui
// coletamos todos os imports externos, unimos os specifiers por módulo e
// emitimos uma única linha por módulo no topo.
const EXTERNAL_MODULE_RE = /^(https?:|npm:|jsr:|node:)/;
const IMPORT_LINE_RE = /^[ \t]*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/;
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?[ \t]*$/;

function hoistExternalImports(bundle: string): string {
  // _shared/ pode vir com CRLF; sem normalizar, o `\r` residual quebra as
  // regexes ancoradas em fim-de-linha e imports externos escapam do hoisting.
  bundle = bundle.replace(/\r\n/g, '\n');
  // module → { defaults, namespaces, named } (Sets preservam a forma textual do
  // specifier, ex.: "createClient", "type SupabaseClient", "* as ns").
  const byModule = new Map<
    string,
    { defaults: Set<string>; namespaces: Set<string>; named: Set<string> }
  >();
  const sideEffects = new Set<string>();
  const store = (mod: string) => {
    let s = byModule.get(mod);
    if (!s) {
      s = { defaults: new Set(), namespaces: new Set(), named: new Set() };
      byModule.set(mod, s);
    }
    return s;
  };

  const kept: string[] = [];
  for (const line of bundle.split('\n')) {
    const se = line.match(SIDE_EFFECT_IMPORT_RE);
    if (se && EXTERNAL_MODULE_RE.test(se[1])) {
      sideEffects.add(se[1]);
      continue;
    }
    const m = line.match(IMPORT_LINE_RE);
    if (m && EXTERNAL_MODULE_RE.test(m[2])) {
      const s = store(m[2]);
      let clause = m[1].trim();
      const brace = clause.match(/\{([^}]*)\}/);
      if (brace) {
        for (const raw of brace[1].split(',')) {
          const spec = raw.trim();
          if (spec) s.named.add(spec);
        }
        clause = clause.replace(brace[0], '').trim();
      }
      for (const raw of clause.split(',')) {
        const part = raw.trim();
        if (!part) continue;
        if (part.startsWith('*')) s.namespaces.add(part);
        else s.defaults.add(part);
      }
      continue;
    }
    kept.push(line);
  }

  const header: string[] = [];
  for (const mod of sideEffects) header.push(`import '${mod}';`);
  for (const [mod, s] of byModule) {
    const parts: string[] = [];
    if (s.defaults.size) parts.push([...s.defaults][0]);
    if (s.namespaces.size) parts.push([...s.namespaces][0]);
    if (s.named.size) parts.push(`{ ${[...s.named].join(', ')} }`);
    header.push(`import ${parts.join(', ')} from '${mod}';`);
  }
  return `${header.join('\n')}\n${kept.join('\n')}`;
}

// Exportadas para teste (scripts locais validam o bundle de todas as functions).
export function bundleEdgeFunction(slug: string): string {
  const index = join('supabase/functions', slug, 'index.ts');
  let source = readFileSync(index, 'utf8');
  sharedInlined.clear();
  source = source.replace(IMPORT_RE, (_match, _imports, modulePath: string) => {
    return loadSharedFile(modulePath);
  });
  return hoistExternalImports(source);
}

export function edgeFunctions() {
  return readdirSync('supabase/functions')
    .filter((name) => {
      const path = join('supabase/functions', name);
      return statSync(path).isDirectory() && !name.startsWith('_');
    })
    .sort();
}

// Deploy via POST /functions/deploy (multipart). O endpoint antigo
// (POST/PATCH /functions com `body` no JSON) passou a IGNORAR o campo body na
// Management API atual — as functions subiam VAZIAS e morriam com BOOT_ERROR.
// verify_jwt: false em todas, igual ao deploy canônico (deploy-functions.mjs):
// cada function valida o JWT internamente via _shared/auth.ts, e o verificador
// legado do gateway rejeita os projetos novos com signing keys ES256.
async function deployEdgeFunctions(ref: string, pat: string) {
  const functions = edgeFunctions();
  for (const slug of functions) {
    const source = bundleEdgeFunction(slug);
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        name: slug,
        entrypoint_path: 'index.ts',
        verify_jwt: false,
      }),
    );
    form.append('file', new Blob([source], { type: 'application/typescript' }), 'index.ts');
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}` },
        body: form,
      },
    );
    if (!res.ok) throw new Error(`Falha ao deployar ${slug}: ${await res.text()}`);
  }
  return functions.length;
}

type AuthUser = { id: string; email?: string };

async function findUser(body: Required<BootstrapBody>): Promise<AuthUser | null> {
  const res = await fetch(
    `${body.supabase_url}/auth/v1/admin/users?email=${encodeURIComponent(body.owner_email)}`,
    {
      headers: {
        apikey: body.supabase_service_role_key,
        Authorization: `Bearer ${body.supabase_service_role_key}`,
      },
    },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { users?: AuthUser[] } | AuthUser[];
  const users = Array.isArray(json) ? json : (json?.users ?? []);
  return users.find((user) => user.email?.toLowerCase() === body.owner_email.toLowerCase()) ?? null;
}

async function createOwner(ref: string, pat: string, body: Required<BootstrapBody>) {
  let user = await findUser(body);
  if (!user) {
    const res = await fetch(`${body.supabase_url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: body.supabase_service_role_key,
        Authorization: `Bearer ${body.supabase_service_role_key}`,
        'Content-Type': 'application/json',
      },
      // Sem `app_metadata` no corpo de propósito: quando ele vem preenchido, o
      // GoTrue reescreve raw_app_meta_data DEPOIS do trigger
      // on_auth_user_created e apaga o org_id que o handle_new_user gravou. O
      // owner entrava sem enxergar nada, porque current_org_id() lê do JWT e
      // toda policy negava. O role vem do trigger e é reconciliado abaixo.
      body: JSON.stringify({
        email: body.owner_email,
        password: body.owner_password,
        email_confirm: true,
        user_metadata: { created_via: 'setup_wizard' },
      }),
    });
    if (!res.ok) throw new Error(`Falha ao criar owner: ${await res.text()}`);
    user = (await res.json()) as AuthUser;
  }
  const id = user.id;
  await supabaseQuery(
    ref,
    pat,
    `INSERT INTO whatsapp_hub.app_users (user_id, org_id, role, is_super_admin, accepted_at)
     VALUES ('${id}', whatsapp_hub.default_org_id(), 'admin', true, now())
     ON CONFLICT (user_id) DO UPDATE SET role = 'admin', is_super_admin = true, accepted_at = COALESCE(whatsapp_hub.app_users.accepted_at, now());
     UPDATE auth.users u
        SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                              || jsonb_build_object(
                                   'role',           a.role::text,
                                   'org_id',         a.org_id::text,
                                   'home_org_id',    a.org_id::text,
                                   'is_super_admin', a.is_super_admin
                                 )
       FROM whatsapp_hub.app_users a
      WHERE a.user_id = u.id AND u.id = '${id}';`,
  );
  return id as string;
}

// Projetos que vivem num TEAM da Vercel exigem `?teamId=` em toda chamada da
// API — sem ele a request roda no escopo pessoal do token e devolve
// "forbidden: Trying to access resource under scope ...". Descobre onde o
// projeto vive: primeiro tenta o escopo pessoal, depois cada team do token.
async function resolveVercelTeamId(projectId: string, token: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${token}` };
  const personal = await fetch(`https://api.vercel.com/v9/projects/${projectId}`, { headers });
  if (personal.ok) return null; // projeto no escopo pessoal — sem teamId

  const teamsRes = await fetch('https://api.vercel.com/v2/teams', { headers });
  if (teamsRes.ok) {
    const { teams } = (await teamsRes.json()) as { teams?: Array<{ id: string }> };
    for (const team of teams ?? []) {
      const probe = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}?teamId=${team.id}`,
        { headers },
      );
      if (probe.ok) return team.id;
    }
  }
  throw new Error(
    'O token da Vercel não acessa o projeto. Crie um token com escopo "Full Account" ' +
    '(ou do time dono do projeto) em vercel.com/account/settings/tokens e tente de novo.',
  );
}

function withTeam(url: string, teamId: string | null): string {
  if (!teamId) return url;
  return url + (url.includes('?') ? '&' : '?') + `teamId=${teamId}`;
}

async function setVercelEnv(projectId: string, token: string, teamId: string | null, key: string, value: string) {
  const res = await fetch(withTeam(`https://api.vercel.com/v10/projects/${projectId}/env?upsert=true`, teamId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, type: 'encrypted', target: ['production', 'preview', 'development'] }),
  });
  if (!res.ok) throw new Error(`Falha ao setar env ${key} na Vercel: ${await res.text()}`);
}

async function redeploy(projectId: string, token: string, teamId: string | null) {
  // Procura o último deployment de produção pronto para servir de base ao
  // redeploy. Sem o filtro target=production poderíamos pegar um preview.
  const deployments = await fetch(
    withTeam(`https://api.vercel.com/v6/deployments?projectId=${projectId}&target=production&limit=1`, teamId),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!deployments.ok) throw new Error(`Falha ao buscar deployment Vercel: ${await deployments.text()}`);
  const json = (await deployments.json()) as {
    deployments?: Array<{ uid?: string; name?: string; url?: string }>;
  };
  const latest = json.deployments?.[0];
  if (!latest?.uid) {
    throw new Error('Projeto Vercel sem deployment de produção anterior — não há base para redeploy');
  }
  // A Vercel não expõe um endpoint /redeploy. Redeploy = criar um novo
  // deployment referenciando o `deploymentId` anterior (reusa o mesmo commit
  // git, mas com o build novo que captura as envs core recém-setadas).
  // `name` é obrigatório; `forceNew=1` garante um build fresco em vez de
  // devolver o deployment idêntico já existente.
  const res = await fetch(withTeam(`https://api.vercel.com/v13/deployments?forceNew=1`, teamId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: latest.name, deploymentId: latest.uid, target: 'production' }),
  });
  if (!res.ok) throw new Error(`Falha ao disparar redeploy: ${await res.text()}`);
  const redeployed = (await res.json()) as { id?: string; uid?: string; url?: string };
  return { id: redeployed.id ?? redeployed.uid ?? latest.uid, url: redeployed.url ?? latest.url ?? '' };
}

function requireBody(body: BootstrapBody | undefined): Required<BootstrapBody> {
  const required = [
    'supabase_url',
    'supabase_anon_key',
    'supabase_service_role_key',
    'supabase_pat',
    'vercel_token',
    'owner_email',
    'owner_password',
  ] as const;
  if (!body) throw new Error('Corpo da requisicao ausente.');
  for (const key of required) {
    if (!body[key]) throw new Error(`Campo ${key} ausente.`);
  }
  return {
    ...body,
    vercel_project_id: body.vercel_project_id ?? process.env.VERCEL_PROJECT_ID ?? '',
  } as Required<BootstrapBody>;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  let stepFailed = 'unknown';
  try {
    const body = requireBody(req.body);
    const ref = projectRef(body.supabase_url);
    const cryptoKey = /^[a-f0-9]{64}$/i.test(process.env.CRYPTO_KEY ?? '')
      ? process.env.CRYPTO_KEY as string
      : randomBytes(32).toString('hex');
    const steps: string[] = [];

    stepFailed = 'bootstrap_state';
    await supabaseQuery(ref, body.supabase_pat, BOOTSTRAP_TABLE_SQL);
    await mark(ref, body.supabase_pat, 'connection_ok');
    steps.push('connection_ok');

    stepFailed = 'migrations';
    await runMigrations(ref, body.supabase_pat, body, cryptoKey);
    await mark(ref, body.supabase_pat, 'migrations_done');
    steps.push('migrations');

    stepFailed = 'edge_functions';
    await setSupabaseSecrets(ref, body.supabase_pat, cryptoKey);
    const count = await deployEdgeFunctions(ref, body.supabase_pat);
    await mark(ref, body.supabase_pat, 'edge_functions_deployed', { count });
    steps.push('edge_functions_deployed');

    stepFailed = 'owner_created';
    const ownerId = await createOwner(ref, body.supabase_pat, body);
    await mark(ref, body.supabase_pat, 'owner_created', { user_id: ownerId, email: body.owner_email });
    steps.push('owner_created');

    stepFailed = 'auth_urls_set';
    // E-mails do Auth (convite/reset) apontando para o domínio real do app em
    // vez do default localhost:3000. Idempotente — PATCH re-executável.
    const appUrl = requestAppUrl(req);
    if (appUrl) {
      await configureAuthUrls(ref, body.supabase_pat, appUrl);
      await mark(ref, body.supabase_pat, 'auth_urls_set', { site_url: appUrl });
      steps.push('auth_urls_set');
    }

    stepFailed = 'vercel_envs_set';
    if (!body.vercel_project_id) {
      throw new Error('VERCEL_PROJECT_ID ausente no runtime (esperado como system env var injetada pela Vercel).');
    }
    // Projeto pode viver num team — descobre o teamId exigido pela API Vercel.
    const vercelTeamId = await resolveVercelTeamId(body.vercel_project_id, body.vercel_token);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, vercelTeamId, 'SUPABASE_URL', body.supabase_url);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, vercelTeamId, 'SUPABASE_ANON_KEY', body.supabase_anon_key);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, vercelTeamId, 'SUPABASE_SERVICE_ROLE_KEY', body.supabase_service_role_key);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, vercelTeamId, 'CRYPTO_KEY', cryptoKey);
    await mark(ref, body.supabase_pat, 'vercel_envs_set');
    steps.push('vercel_envs_set');

    stepFailed = 'redeploy';
    // Idempotente: um re-run não dispara um novo deployment. Se já marcamos
    // redeploy_triggered, reaproveitamos o deployment do checkpoint.
    let deployment: { id: string; url: string };
    if (await hasStep(ref, body.supabase_pat, 'redeploy_triggered')) {
      const meta = await getStepMetadata(ref, body.supabase_pat, 'redeploy_triggered');
      deployment = {
        id: typeof meta?.deployment_id === 'string' ? meta.deployment_id : '',
        url: typeof meta?.deployment_url === 'string' ? meta.deployment_url : '',
      };
    } else {
      deployment = await redeploy(body.vercel_project_id, body.vercel_token, vercelTeamId);
      await mark(ref, body.supabase_pat, 'redeploy_triggered', {
        deployment_id: deployment.id,
        deployment_url: deployment.url,
        triggered_at: new Date().toISOString(),
      });
    }
    steps.push('redeploy_triggered');

    return res.status(200).json({
      success: true,
      steps_completed: steps,
      deployment_id: deployment.id,
      deployment_url: deployment.url,
      owner_user_id: ownerId,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      step_failed: stepFailed,
      error_code: 'BOOTSTRAP_FAILED',
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
