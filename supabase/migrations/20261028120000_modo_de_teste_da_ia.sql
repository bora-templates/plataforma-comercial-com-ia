-- ============================================================================
-- Modo de teste da IA
-- ----------------------------------------------------------------------------
-- Antes de ligar a IA para os clientes, o dono testa com os números dele. Com
-- test_mode ligado, process-ai-message só deixa a IA responder os contatos cujo
-- número está em test_allowlist. Os outros vão para o atendimento humano, como
-- se a IA estivesse desligada para eles. A regra de comparação mora em
-- supabase/functions/_shared/ai-test-mode.ts.
--
-- Por organização, na configuração do agente (uma linha por organização). O
-- default é desligado, então nada muda em quem já está no ar, e a organização
-- nova (seed_org_defaults) nasce com o modo desligado pelo próprio default.
-- A lista guarda os números como foram digitados, no máximo 20.
-- ============================================================================

ALTER TABLE whatsapp_hub.ai_agent_config
  ADD COLUMN IF NOT EXISTS test_mode      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_allowlist TEXT[]  NOT NULL DEFAULT '{}';

ALTER TABLE whatsapp_hub.ai_agent_config
  DROP CONSTRAINT IF EXISTS ai_agent_config_test_allowlist_max;
ALTER TABLE whatsapp_hub.ai_agent_config
  ADD CONSTRAINT ai_agent_config_test_allowlist_max
  CHECK (coalesce(array_length(test_allowlist, 1), 0) <= 20);
