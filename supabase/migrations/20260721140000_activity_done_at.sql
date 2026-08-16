-- ============================================================================
-- crm_activities.done_at — carimbo de conclusão das ações
-- ============================================================================
-- A linha do tempo do contato precisa posicionar as tarefas CONCLUÍDAS no
-- momento em que foram concluídas. A tabela só tinha o booleano `done`; sem um
-- timestamp não dá para colocar o evento no dia certo. `done_at` é preenchido
-- pela UI ao concluir; ações já concluídas (sem done_at) caem no created_at.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.crm_activities
  ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_hub.crm_activities.done_at IS
  'Quando a ação foi concluída (done=true). Preenchido pela UI; usado na timeline do contato.';
