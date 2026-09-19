// ============================================================================
// npm run db:status: mostra o que o npm run db:push aplicaria, sem alterar nada.
// ----------------------------------------------------------------------------
// Só lê: três consultas ao banco e nenhuma escrita. Rode antes do db:push numa
// instalação que já está no ar.
//
// Este arquivo tem nome próprio de propósito. O scripts/push-migrations.mjs de
// clones anteriores a 18/09/2026 ignora qualquer argumento e aplica tudo, então
// um "modo leitura" dentro dele seria perigoso justamente em quem ainda não
// atualizou. Num clone antigo este comando não existe e falha sem tocar no banco.
//
// Uso:
//   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=abc node scripts/migrations-status.mjs
// ============================================================================

import { runFromCli } from './lib/migration-plan.mjs';

process.exitCode = await runFromCli('status');
