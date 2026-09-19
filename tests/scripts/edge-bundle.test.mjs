// ============================================================================
// Bundle das Edge Functions montado pelo wizard /setup (api/bootstrap.ts).
// ----------------------------------------------------------------------------
// O wizard não sobe a pasta _shared/. Ele cola cada arquivo de _shared/ dentro
// do index.ts da função, tudo no MESMO escopo, e sobe o resultado. Dois nomes de
// topo iguais (uma função declarada no index.ts e também num _shared, por
// exemplo) viram "Identifier has already been declared", e a função morre com
// BOOT_ERROR só depois de instalada, na conta do comprador.
//
// Este teste monta o bundle de TODAS as funções com o código de verdade do
// wizard, tira os tipos e pede para o Node conferir a sintaxe do módulo. Não
// executa nada e não usa rede.
//
// Como rodar (Node 22.18+, que importa o TypeScript direto):
//   npm run test:migrations      (roda tudo de tests/scripts)
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bootstrap = await import('../../api/bootstrap.ts').catch(() => null);
const ts = await import('typescript').then((m) => m.default ?? m).catch(() => null);
const skip = !bootstrap
  ? 'este Node não importa TypeScript direto (precisa de 22.18+)'
  : !ts
    ? 'pacote typescript ausente: npm install'
    : false;

function syntaxErrorOf(slug) {
  const bundle = bootstrap.bundleEdgeFunction(slug);
  const { outputText } = ts.transpileModule(bundle, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const dir = mkdtempSync(join(tmpdir(), 'edge-bundle-'));
  try {
    const file = join(dir, `${slug}.mjs`);
    writeFileSync(file, outputText);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return check.status === 0 ? null : check.stderr.split('\n').filter((l) => /Error/.test(l)).join(' ') || check.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('todo bundle montado pelo wizard é um módulo válido, sem nome declarado duas vezes', { skip }, () => {
  const slugs = bootstrap.edgeFunctions();
  assert.ok(slugs.length > 0, 'nenhuma Edge Function encontrada (rode da raiz do repositório)');
  const broken = slugs
    .map((slug) => ({ slug, error: syntaxErrorOf(slug) }))
    .filter((r) => r.error);
  assert.deepEqual(broken, []);
});
