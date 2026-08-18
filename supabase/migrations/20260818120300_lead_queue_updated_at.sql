-- lead_assignment_queue tem o trigger set_updated_at mas nunca ganhou a coluna:
-- todo UPDATE (reordenar a fila do rodizio) falhava com
--   record "new" has no field "updated_at"
-- e a ordem nunca era salva. A coluna resolve; o trigger passa a fazer sentido.
ALTER TABLE whatsapp_hub.lead_assignment_queue
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
