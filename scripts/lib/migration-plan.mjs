// ============================================================================
// Controle de migrations do npm run db:push e do npm run db:status.
// ----------------------------------------------------------------------------
// Este projeto tem DOIS controles de migration, e um não sabia do outro:
//
//   1. O wizard /setup (api/bootstrap.ts) anota em public._bootstrap_state,
//      com step = 'migration:<nome-do-arquivo.sql>'.
//   2. O db:push anota em supabase_migrations.schema_migrations, com
//      version = prefixo numérico do arquivo (o mesmo formato do Supabase CLI).
//
// Uma instalação feita pelo wizard tem o primeiro cheio e o segundo vazio. O
// db:push antigo olhava só para o segundo, concluía que nada tinha rodado e
// reaplicava todas as migrations desde a primeira, em cima de um banco em
// produção. Aqui uma migration conta como aplicada se estiver em QUALQUER uma
// das duas fontes, e cada migration nova é anotada nas duas.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STEP_PREFIX = 'migration:';

// 20260422120001_init.sql → { version: '20260422120001', name: 'init' }
// A regra é a mesma do script antigo de propósito: mudar a identidade do
// arquivo faria instalações existentes verem migrations antigas como pendentes.
export function parseMigrationFile(file) {
  const base = file.replace(/\.sql$/, '');
  const idx = base.indexOf('_');
  if (idx === -1) return { file, version: base, name: '' };
  return { file, version: base.slice(0, idx), name: base.slice(idx + 1) };
}

// Função pura: recebe o que existe no repositório e o que o banco diz, devolve
// o que fazer. Não lê arquivo, não fala com a rede.
//
//   files            nomes em supabase/migrations
//   versions         versions de supabase_migrations.schema_migrations
//   steps            steps de public._bootstrap_state, ou null se a tabela não
//                    existe (banco novo, antes da migration setup_infra)
//   hubSchemaExists  o schema whatsapp_hub já existe no banco?
export function planMigrations({ files, versions, steps, hubSchemaExists }) {
  const versionSet = new Set(versions ?? []);
  const stepSet = new Set(steps ?? []);
  const hasStepsTable = steps !== null && steps !== undefined;

  const migrations = [...files].sort().map(parseMigrationFile);
  const applied = [];
  const pending = [];
  for (const migration of migrations) {
    const byVersion = versionSet.has(migration.version);
    const byStep = stepSet.has(STEP_PREFIX + migration.file);
    if (byVersion || byStep) applied.push({ ...migration, byVersion, byStep });
    else pending.push(migration);
  }

  // Trava: o schema já existe, mas a primeira migration não aparece como
  // aplicada em nenhuma das duas fontes. O banco foi montado por um caminho que
  // não deixou registro, então "pendente" aqui significa reaplicar tudo desde o
  // começo. Conta só registro de migration DESTE repositório: _bootstrap_state
  // guarda outros checkpoints e schema_migrations pode ter versions de outro
  // produto no mesmo projeto.
  const first = migrations[0];
  const firstIsPending = first !== undefined && pending[0]?.file === first.file;
  const blocked =
    hubSchemaExists && firstIsPending
      ? { code: 'BANCO_SEM_REGISTRO', firstFile: first.file, replayCount: pending.length }
      : null;

  // O que falta para as duas fontes ficarem iguais. A chave de
  // schema_migrations é a version, então o par de prefixo repetido
  // (20260811120000_*) vira uma linha só.
  const missingVersions = [];
  const seenVersions = new Set();
  for (const migration of applied) {
    if (migration.byVersion || seenVersions.has(migration.version)) continue;
    seenVersions.add(migration.version);
    missingVersions.push({ version: migration.version, name: migration.name });
  }
  const missingSteps = hasStepsTable
    ? applied.filter((migration) => !migration.byStep).map((migration) => STEP_PREFIX + migration.file)
    : [];

  return { applied, pending, blocked, missingVersions, missingSteps };
}

// ----------------------------------------------------------------------------
// SQL de registro
// ----------------------------------------------------------------------------

const DO_TAG = '$db_push_track$';

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Registra nas duas fontes. O INSERT em _bootstrap_state fica dentro de um bloco
// DO com to_regclass porque a tabela pode não existir: num banco novo ela só
// nasce na migration setup_infra, no meio da fila. O PL/pgSQL só analisa o
// INSERT quando o IF passa, então a ausência da tabela não derruba a chamada.
export function trackingSql({ versions = [], steps = [] }) {
  const parts = [];
  if (versions.length) {
    const rows = versions
      .map(({ version, name }) => `(${literal(version)}, ${literal(name)}, ARRAY[]::text[])`)
      .join(',\n  ');
    parts.push(
      `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)\nVALUES\n  ${rows}\nON CONFLICT (version) DO NOTHING;`,
    );
  }
  if (steps.length) {
    if (steps.some((step) => step.includes(DO_TAG))) {
      throw new Error(`Nome de migration inválido: não pode conter ${DO_TAG}.`);
    }
    const rows = steps
      .map((step) => `(${literal(step)}, now(), '{"source":"db:push"}'::jsonb)`)
      .join(',\n      ');
    parts.push(
      [
        `DO ${DO_TAG}`,
        'BEGIN',
        "  IF to_regclass('public._bootstrap_state') IS NOT NULL THEN",
        '    INSERT INTO public._bootstrap_state (step, completed_at, metadata)',
        '    VALUES',
        `      ${rows}`,
        '    ON CONFLICT (step) DO NOTHING;',
        '  END IF;',
        'END',
        `${DO_TAG};`,
      ].join('\n'),
    );
  }
  return parts.join('\n');
}

// O Supabase só cria supabase_migrations.schema_migrations no primeiro
// `supabase db push` oficial. Projeto novo não tem a tabela, e o CLI antigo
// criava só a coluna version: os ADD COLUMN cobrem esse caso.
const ENSURE_TRACKING_TABLE_SQL = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT,
  statements TEXT[]
);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements TEXT[];`;

const PROBE_SQL = `SELECT
  to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_versions_table,
  to_regclass('public._bootstrap_state') IS NOT NULL AS has_steps_table,
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'whatsapp_hub') AS has_hub_schema;`;

// ----------------------------------------------------------------------------
// Placeholders de segredo
// ----------------------------------------------------------------------------
// A migration guarda o placeholder e o valor entra só na hora do envio, para o
// segredo nunca ir parar no git.

const PLACEHOLDERS = {
  __WHATSAPP_HUB_ENCRYPTION_KEY__: 'APP_ENCRYPTION_KEY',
  __SUPABASE_URL__: 'SUPABASE_URL',
  __SUPABASE_SERVICE_ROLE_KEY__: 'SUPABASE_SERVICE_ROLE_KEY',
};

function missingEnv(sql, env) {
  return Object.entries(PLACEHOLDERS)
    .filter(([placeholder, envVar]) => sql.includes(placeholder) && !env[envVar])
    .map(([placeholder, envVar]) => ({ placeholder, envVar }));
}

function substitute(sql, env) {
  let result = sql;
  for (const [placeholder, envVar] of Object.entries(PLACEHOLDERS)) {
    if (result.includes(placeholder)) result = result.replaceAll(placeholder, env[envVar]);
  }
  return result;
}

// ----------------------------------------------------------------------------
// Execução
// ----------------------------------------------------------------------------

class ReadError extends Error {}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const DEFAULT_PUSH_SCRIPT = new URL('../push-migrations.mjs', import.meta.url);

// O script antigo não importa esta lib. Se ele ainda estiver no clone, o
// db:status não pode dar sinal verde para o db:push.
function pushScriptIsOld(pushScriptPath) {
  let source;
  try {
    source = readFileSync(pushScriptPath, 'utf8');
  } catch {
    return false; // sem o arquivo, npm run db:push falha sozinho antes de tocar no banco
  }
  return !source.includes('lib/migration-plan.mjs');
}

// mode 'push' aplica; mode 'status' só lê. Devolve o código de saída em vez de
// encerrar o processo, para o teste conseguir chamar.
//   0 tudo certo · 1 falha · 3 trava de banco sem registro
export async function runMigrations({
  mode = 'push',
  token,
  ref,
  env = {},
  dir = 'supabase/migrations',
  fetchImpl = fetch,
  log = console.log,
  pushScriptPath = DEFAULT_PUSH_SCRIPT,
}) {
  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;

  async function runSql(query) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  }

  // Erro de leitura NUNCA vira "tabela vazia": concluir que não há registro por
  // causa de um 500 levaria ao replay completo. Só o 42P01 (tabela ausente) é
  // tratado como ausência, e devolve null.
  async function readColumn(query, column) {
    const result = await runSql(query);
    if (!result.ok) {
      if (result.body.includes('42P01')) return null;
      throw new ReadError(`Não consegui ler o controle de migrations (HTTP ${result.status}): ${result.body}`);
    }
    const rows = JSON.parse(result.body);
    if (!Array.isArray(rows)) throw new ReadError(`Resposta inesperada da Management API: ${result.body}`);
    return rows.map((row) => row[column]);
  }

  async function readState() {
    const probe = await runSql(PROBE_SQL);
    if (!probe.ok) throw new ReadError(`Não consegui consultar o banco (HTTP ${probe.status}): ${probe.body}`);
    const [flags] = JSON.parse(probe.body);
    const versions = flags.has_versions_table
      ? await readColumn('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;', 'version')
      : null;
    const steps = flags.has_steps_table
      ? await readColumn("SELECT step FROM public._bootstrap_state WHERE step LIKE 'migration:%' ORDER BY step;", 'step')
      : null;
    return { versions, steps, hubSchemaExists: Boolean(flags.has_hub_schema) };
  }

  try {
    const files = readdirSync(dir).filter((file) => file.endsWith('.sql'));
    const state = await readState();
    const plan = planMigrations({ files, ...state });
    const result = { exitCode: 0, applied: [], plan };

    log(
      `Projeto ${ref}: ${count(plan.applied.length, 'migration já aplicada', 'migrations já aplicadas')}, ` +
        `${count(plan.pending.length, 'pendente', 'pendentes')}.`,
    );
    log(
      `Registro encontrado: ${state.versions?.length ?? 0} em supabase_migrations.schema_migrations (db:push) e ` +
        (state.steps === null
          ? 'public._bootstrap_state ainda não existe neste banco.'
          : `${state.steps.length} em public._bootstrap_state (wizard /setup).`),
    );

    if (plan.blocked) {
      log('');
      log(
        mode === 'push'
          ? 'O db:push parou antes de executar qualquer coisa.'
          : 'O db:push pararia aqui, antes de executar qualquer coisa.',
      );
      log(
        `Este banco já tem o schema whatsapp_hub, mas a primeira migration (${plan.blocked.firstFile}) não aparece ` +
          'como aplicada em supabase_migrations.schema_migrations nem em public._bootstrap_state.',
      );
      log(
        `Sem esse registro, o db:push reaplicaria ${count(plan.blocked.replayCount, 'migration', 'migrations')} desde a primeira, ` +
          'e várias delas apagam dados ou desfazem mudanças mais novas.',
      );
      log(
        'Para aplicar uma migration nova neste banco, cole o conteúdo do arquivo .sql no SQL Editor do Supabase ' +
          '(INSTALL.md, seção 7).',
      );
      return { ...result, exitCode: 3 };
    }

    const sources = plan.pending.map((migration) => ({
      ...migration,
      sql: readFileSync(join(dir, migration.file), 'utf8'),
    }));
    const withoutEnv = sources
      .map((migration) => ({ file: migration.file, missing: missingEnv(migration.sql, env) }))
      .filter((entry) => entry.missing.length);
    const syncCount = plan.missingVersions.length + plan.missingSteps.length;
    const syncLine =
      `${count(plan.missingVersions.length, 'registro', 'registros')} em supabase_migrations.schema_migrations e ` +
      `${plan.missingSteps.length} em public._bootstrap_state`;

    if (mode === 'status') {
      if (plan.pending.length) {
        log('Pendentes, na ordem em que o npm run db:push aplica:');
        for (const migration of plan.pending) log(`  ${migration.file}`);
      } else {
        log('Nenhuma migration pendente.');
      }
      if (syncCount) log(`O db:push também vai igualar os dois controles: ${syncLine}.`);
      for (const entry of withoutEnv) {
        for (const { placeholder, envVar } of entry.missing) {
          log(`Antes do db:push, defina ${envVar}: ${entry.file} usa ${placeholder}.`);
        }
      }
      log('O db:status só lê. Nada foi alterado no banco.');
      if (pushScriptIsOld(pushScriptPath)) {
        log('');
        log(
          'ATENÇÃO: o scripts/push-migrations.mjs deste clone é a versão antiga, que ignora o registro do wizard ' +
            'e reaplica todas as migrations desde a primeira.',
        );
        log(
          'Não rode npm run db:push antes de trazer do template os arquivos scripts/push-migrations.mjs, ' +
            'scripts/migrations-status.mjs e scripts/lib/migration-plan.mjs.',
        );
        return { ...result, exitCode: 1 };
      }
      return result;
    }

    if (withoutEnv.length) {
      log('Faltam variáveis de ambiente para migrations pendentes. Nada foi executado.');
      for (const entry of withoutEnv) {
        for (const { placeholder, envVar } of entry.missing) {
          log(`  ${entry.file} usa ${placeholder} e precisa de ${envVar}.`);
        }
      }
      return { ...result, exitCode: 1 };
    }

    if (!plan.pending.length && !syncCount) {
      log('Nenhuma migration pendente e os dois controles já estão iguais.');
      return result;
    }

    // Uma chamada só: cria a tabela de controle se faltar e iguala as duas
    // fontes para o que JÁ estava aplicado. Depois disso o Supabase CLI oficial
    // e o wizard passam a enxergar o mesmo histórico que este script.
    if (syncCount) log(`Igualando os dois controles: ${syncLine}.`);
    const prepare = await runSql(
      [ENSURE_TRACKING_TABLE_SQL, trackingSql({ versions: plan.missingVersions, steps: plan.missingSteps })]
        .filter(Boolean)
        .join('\n'),
    );
    if (!prepare.ok) {
      log(`Falhou ao preparar o controle de migrations (HTTP ${prepare.status}).`);
      log(`  ${prepare.body}`);
      return { ...result, exitCode: 1 };
    }

    for (const migration of sources) {
      log(`APLICANDO ${migration.file}`);
      // Migration e registro na MESMA chamada: a Management API roda a chamada
      // inteira numa transação, então ou aplica e registra, ou não faz nada.
      const applied = await runSql(
        `${substitute(migration.sql, env)}\n${trackingSql({
          versions: [{ version: migration.version, name: migration.name }],
          steps: [STEP_PREFIX + migration.file],
        })}`,
      );
      if (!applied.ok) {
        log(`  FALHOU (HTTP ${applied.status})`);
        log(`  ${applied.body}`);
        log(
          'A chamada que falhou foi desfeita inteira pelo Postgres, e as migrations seguintes não foram enviadas.',
        );
        return { ...result, exitCode: 1 };
      }
      log('  Aplicada e registrada.');
      result.applied.push(migration.file);
    }

    // Banco novo: _bootstrap_state só passou a existir no meio da fila, então as
    // migrations anteriores a ela ficaram sem step. Completa no fim.
    if (state.steps === null && result.applied.length) {
      const complete = await runSql(
        trackingSql({ steps: [...plan.applied, ...plan.pending].map((migration) => STEP_PREFIX + migration.file) }),
      );
      if (!complete.ok) {
        log(`Falhou ao completar public._bootstrap_state (HTTP ${complete.status}).`);
        log(`  ${complete.body}`);
        return { ...result, exitCode: 1 };
      }
    }

    log(`O db:push aplicou ${count(result.applied.length, 'migration', 'migrations')}.`);
    return result;
  } catch (err) {
    log(err instanceof ReadError ? err.message : `Erro inesperado: ${err?.stack ?? err}`);
    if (err instanceof ReadError) log('Nada foi executado.');
    return { exitCode: 1, applied: [], plan: null };
  }
}

// Entrada dos dois scripts de linha de comando.
export async function runFromCli(mode) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.PROJECT_REF;
  if (!token || !ref) {
    console.error('Defina SUPABASE_ACCESS_TOKEN e PROJECT_REF antes de rodar (INSTALL.md, seção 2.1).');
    return 2;
  }
  const { exitCode } = await runMigrations({ mode, token, ref, env: process.env });
  return exitCode;
}
