-- ============================================================================
-- Conversas · vínculo explícito com o negócio "ativo"
-- ============================================================================
-- Um contato tem UMA conversa (UNIQUE tenant_id, contact_id) mas pode ter N
-- negócios abertos. Sem um elo direto, a conversa não sabe com qual negócio
-- está trabalhando. `active_deal_id` é esse vínculo, fixado manualmente pelo
-- operador na inbox. Responsáveis (assigned_to vs. deals.owner_id) seguem
-- independentes — este vínculo não os sincroniza.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS active_deal_id UUID
    REFERENCES whatsapp_hub.deals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_active_deal
  ON whatsapp_hub.conversations(active_deal_id);

COMMENT ON COLUMN whatsapp_hub.conversations.active_deal_id IS
  'Negócio (deal) que esta conversa está tratando quando o contato tem vários negócios abertos. Fixado manualmente pelo operador na inbox. ON DELETE SET NULL.';
