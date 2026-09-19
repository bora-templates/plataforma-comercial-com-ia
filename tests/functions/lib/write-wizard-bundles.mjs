// ============================================================================
// Grava em tests/.artifacts/edge-bundles/ o bundle de cada Edge Function do jeito
// que o wizard /setup sobe (api/bootstrap.ts cola os _shared no index.ts). O teste
// wizard-bundle.deno.test.ts roda o handler a partir desses arquivos, para conferir
// o que o comprador recebe de verdade, e não só o código-fonte.
//
// Uso (já embutido em npm run test:functions:e2e):
//   node tests/functions/lib/write-wizard-bundles.mjs
// ============================================================================

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'tests/.artifacts/edge-bundles';
const SLUGS = ['check-follow-ups', 'funnel-automation'];

const { bundleEdgeFunction } = await import('../../../api/bootstrap.ts');

rmSync(OUT, { recursive: true, force: true });
for (const slug of SLUGS) {
  mkdirSync(join(OUT, slug), { recursive: true });
  writeFileSync(join(OUT, slug, 'index.ts'), bundleEdgeFunction(slug));
}
console.log(`bundles do wizard gravados em ${OUT}: ${SLUGS.join(', ')}`);
