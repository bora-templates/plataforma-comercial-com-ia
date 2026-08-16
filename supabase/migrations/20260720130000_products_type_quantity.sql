-- ============================================================================
-- Produtos: tipo + quantidade (Configurações → Produtos)
-- ----------------------------------------------------------------------------
-- products ganha classificação por tipo (curso/mentoria/consultoria/ebook/app/
-- ia/fisico). Quantidade (estoque) só faz sentido para produto físico — o CHECK
-- garante isso no banco, não só na UI.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.products
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'curso',
  ADD COLUMN IF NOT EXISTS quantity INT;

-- Limpeza: o editor de aliases antigo gravava neste JSONB, que a trigger de
-- derivação não lê mais (a fonte é a tabela utm_channel_map desde a Fase 0 do
-- tracking). A UI agora edita a tabela — a coluna órfã sai.
ALTER TABLE whatsapp_hub.app_settings DROP COLUMN IF EXISTS utm_channel_map;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_type_chk') THEN
    ALTER TABLE whatsapp_hub.products
      ADD CONSTRAINT products_type_chk
      CHECK (product_type IN ('curso','mentoria','consultoria','ebook','app','ia','fisico'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_quantity_chk') THEN
    ALTER TABLE whatsapp_hub.products
      ADD CONSTRAINT products_quantity_chk
      CHECK (quantity IS NULL OR (product_type = 'fisico' AND quantity >= 0));
  END IF;
END $$;
