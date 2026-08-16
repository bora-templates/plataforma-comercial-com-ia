-- ============================================================================
-- Distribuição automática (sequencial) de leads no handoff
-- ============================================================================
-- Quando a IA é pausada (handoff, ai_paused false→true) e a atribuição
-- automática está ativa, o próximo membro de uma fila configurável vira o
-- responsável da conversa (assigned_to). Round-robin puro (ignora is_online).
-- Roda no banco (trigger) para pegar handoff manual ou futuro handoff da IA.
--
-- Regras (definidas com o usuário):
--   1. Só atribui se a conversa estiver SEM responsável (respeita manual).
--   2. Com responsável (auto ou manual), a notificação de handoff vai só para
--      ele; sem responsável, mantém o fanout à equipe (comportamento atual).
--   3. Sequência pura — sem filtro por presença.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Config global no singleton app_settings (id=1)
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS auto_assign_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_last_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN whatsapp_hub.app_settings.auto_assign_last_user_id IS
  'Cursor do round-robin: último usuário para quem um lead foi auto-atribuído.';

-- ----------------------------------------------------------------------------
-- 2. Fila de atribuição (presença = está na fila; position = ordem)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.lead_assignment_queue (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  position   INT  NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_queue_position ON whatsapp_hub.lead_assignment_queue(position);

DROP TRIGGER IF EXISTS trg_lead_queue_updated_at ON whatsapp_hub.lead_assignment_queue;
CREATE TRIGGER trg_lead_queue_updated_at
  BEFORE UPDATE ON whatsapp_hub.lead_assignment_queue
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. RLS — SELECT a authenticated; escrita admin-only
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.lead_assignment_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_assignment_queue_select ON whatsapp_hub.lead_assignment_queue;
CREATE POLICY lead_assignment_queue_select ON whatsapp_hub.lead_assignment_queue
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS lead_assignment_queue_write ON whatsapp_hub.lead_assignment_queue;
CREATE POLICY lead_assignment_queue_write ON whatsapp_hub.lead_assignment_queue
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.lead_assignment_queue TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Trigger de atribuição — BEFORE UPDATE (roda antes do on_handoff_notify)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_last    UUID;
  v_next    UUID;
BEGIN
  -- Mesma transição do _on_handoff_notify: ai_paused false/null → true.
  IF COALESCE(OLD.ai_paused, false) = true
     OR COALESCE(NEW.ai_paused, false) = false
  THEN
    RETURN NEW;
  END IF;

  -- Decisão 1: não sobrescreve responsável existente.
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT auto_assign_enabled, auto_assign_last_user_id
    INTO v_enabled, v_last
    FROM whatsapp_hub.app_settings WHERE id = 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Próximo da fila: primeiro com position > position(último atribuído).
  SELECT user_id INTO v_next
    FROM whatsapp_hub.lead_assignment_queue
   WHERE v_last IS NULL
      OR position > (SELECT position FROM whatsapp_hub.lead_assignment_queue WHERE user_id = v_last)
   ORDER BY position
   LIMIT 1;

  -- Wrap (ou último fora da fila / nulo): volta ao primeiro.
  IF v_next IS NULL THEN
    SELECT user_id INTO v_next
      FROM whatsapp_hub.lead_assignment_queue
     ORDER BY position
     LIMIT 1;
  END IF;

  IF v_next IS NOT NULL THEN
    NEW.assigned_to := v_next;
    NEW.assigned_at := now();
    UPDATE whatsapp_hub.app_settings
       SET auto_assign_last_user_id = v_next, updated_at = now()
     WHERE id = 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_handoff_assign ON whatsapp_hub.conversations;
CREATE TRIGGER on_handoff_assign
  BEFORE UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_handoff_assign();

-- ----------------------------------------------------------------------------
-- 5. Notificação de handoff direcionada (decisão 2)
--    Com responsável → notifica só ele; sem responsável → fanout à equipe.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
  title_txt TEXT;
BEGIN
  IF COALESCE(OLD.ai_paused, false) = true
     OR COALESCE(NEW.ai_paused, false) = false
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.contacts c
   WHERE c.id = NEW.contact_id;

  title_txt := 'Handoff para humano: ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato');

  IF NEW.assigned_to IS NOT NULL THEN
    -- Notifica apenas o responsável (auto-atribuído ou manual).
    INSERT INTO whatsapp_hub.notifications (
      user_id, type, conversation_id, message_id, title, body
    ) VALUES (
      NEW.assigned_to,
      'handoff'::whatsapp_hub.notification_type,
      NEW.id,
      NULL,
      title_txt,
      'Conversa atribuída a você — a IA foi pausada.'
    );
  ELSE
    -- Sem responsável: mantém o fanout à equipe (comportamento atual).
    PERFORM whatsapp_hub._fanout_notification(
      'handoff'::whatsapp_hub.notification_type,
      NEW.id,
      NULL,
      title_txt,
      'A IA foi pausada nessa conversa. Ela precisa de um atendente humano.'
    );
  END IF;

  RETURN NEW;
END;
$$;
