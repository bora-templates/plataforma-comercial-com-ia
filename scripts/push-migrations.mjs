// ============================================================================
// npm run db:push: aplica as migrations pendentes pela Management API.
// ----------------------------------------------------------------------------
// Alternativa ao `supabase db push` que não precisa da senha do banco: o PAT
// basta, porque /database/query roda como postgres.
//
// Serve para instalação feita pelo wizard /setup e para instalação manual: uma
// migration conta como aplicada se estiver em public._bootstrap_state (wizard)
// OU em supabase_migrations.schema_migrations (este script). A regra toda, a
// trava de segurança e os textos vivem em scripts/lib/migration-plan.mjs.
//
// Para ver o que seria aplicado, sem alterar nada: npm run db:status
//
// Uso:
//   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=abc node scripts/push-migrations.mjs
// ============================================================================

import { runFromCli } from './lib/migration-plan.mjs';

process.exitCode = await runFromCli('push');
