// ============================================================================
// Guardas da pasta supabase/migrations (as migrations de verdade deste repo).
// ----------------------------------------------------------------------------
// Duas regras que o wizard /setup e o npm run db:push pressupõem e que nenhum
// build confere.
//
// Como rodar:
//   node --test tests/scripts/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseMigrationFile } from '../../scripts/lib/migration-plan.mjs';

const DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
const files = readdirSync(DIR).filter((file) => file.endsWith('.sql')).sort();

// Par histórico, já aplicado em toda instalação. Não renomear: o nome do
// arquivo é a identidade que o wizard gravou em _bootstrap_state.
const KNOWN_DUPLICATES = ['20260811120000'];

test('migration nova não reutiliza prefixo numérico de outra', () => {
  // supabase_migrations.schema_migrations tem chave em version. Um arquivo novo
  // com prefixo já registrado é tratado como aplicado e nunca roda, no db:push e
  // no Supabase CLI oficial, sem erro nenhum.
  const count = new Map();
  for (const file of files) {
    const { version } = parseMigrationFile(file);
    count.set(version, (count.get(version) ?? 0) + 1);
  }
  const duplicated = [...count].filter(([, n]) => n > 1).map(([version]) => version);

  assert.deepEqual(duplicated, KNOWN_DUPLICATES);
});

test('toda migration termina em ponto e vírgula', () => {
  // O wizard e o db:push colam o SQL de registro logo depois do arquivo, na
  // mesma chamada. Sem o ponto e vírgula final, os dois viram um comando só e a
  // migration falha com erro de sintaxe.
  const withoutSemicolon = files.filter((file) => {
    const sql = readFileSync(join(DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .trimEnd();
    return !sql.endsWith(';');
  });

  assert.deepEqual(withoutSemicolon, []);
});
