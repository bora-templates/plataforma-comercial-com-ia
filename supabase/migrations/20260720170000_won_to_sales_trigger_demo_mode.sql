-- ============================================================================
-- Vendas automáticas a partir de negócios ganhos + modo demonstração
-- ----------------------------------------------------------------------------
-- 1. Trigger em deals: ao marcar como ganho, o negócio entra AUTOMATICAMENTE
--    na base de Vendas & Recompra (sales_records) — um registro por produto
--    atrelado, ou um único com o título do negócio. O contato vira 'cliente'.
--    (Substitui o botão manual "Incluir negócios ganhos".)
-- 2. Backfill dos ganhos existentes.
-- 3. app_settings.demo_mode — exibe dados fictícios no dashboard (demonstração).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub._deal_won_to_sales()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_doc  TEXT;
  v_name TEXT;
  v_phone TEXT;
  v_date DATE := COALESCE(NEW.won_at::date, now()::date);
BEGIN
  IF NEW.status <> 'won' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'won' THEN RETURN NEW; END IF; -- já processado

  SELECT COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                  NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                  c.id::text),
         c.name, c.phone
  INTO v_doc, v_name, v_phone
  FROM whatsapp_hub.contacts c WHERE c.id = NEW.contact_id;

  -- Um registro por produto do negócio; sem produtos → um registro pelo título.
  INSERT INTO whatsapp_hub.sales_records
    (customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
  SELECT v_name, v_doc, v_phone, p.name, 1, NEW.value, v_date, 'crm:negocio_ganho'
  FROM whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id = NEW.id
  ON CONFLICT (customer_doc, product_name, purchase_date) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = NEW.id) THEN
    INSERT INTO whatsapp_hub.sales_records
      (customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
    VALUES (v_name, v_doc, v_phone, NEW.title, 1, NEW.value, v_date, 'crm:negocio_ganho')
    ON CONFLICT (customer_doc, product_name, purchase_date) DO NOTHING;
  END IF;

  -- Quem compra é cliente (não sobrescreve escolha manual).
  UPDATE whatsapp_hub.contacts SET kind = 'cliente'
  WHERE id = NEW.contact_id AND kind IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_won_to_sales ON whatsapp_hub.deals;
CREATE TRIGGER trg_deal_won_to_sales
  AFTER INSERT OR UPDATE OF status ON whatsapp_hub.deals
  FOR EACH ROW
  WHEN (NEW.status = 'won')
  EXECUTE FUNCTION whatsapp_hub._deal_won_to_sales();

-- Backfill: ganhos existentes entram na base (mesma lógica, dedupe idempotente).
INSERT INTO whatsapp_hub.sales_records
  (customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
SELECT c.name,
       COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                c.id::text),
       c.phone, p.name, 1, d.value, COALESCE(d.won_at::date, now()::date), 'crm:negocio_ganho'
FROM whatsapp_hub.deals d
JOIN whatsapp_hub.contacts c ON c.id = d.contact_id
JOIN whatsapp_hub.deal_products dp ON dp.deal_id = d.id
JOIN whatsapp_hub.products p ON p.id = dp.product_id
WHERE d.status = 'won'
ON CONFLICT (customer_doc, product_name, purchase_date) DO NOTHING;

INSERT INTO whatsapp_hub.sales_records
  (customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
SELECT c.name,
       COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                c.id::text),
       c.phone, d.title, 1, d.value, COALESCE(d.won_at::date, now()::date), 'crm:negocio_ganho'
FROM whatsapp_hub.deals d
JOIN whatsapp_hub.contacts c ON c.id = d.contact_id
WHERE d.status = 'won'
  AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = d.id)
ON CONFLICT (customer_doc, product_name, purchase_date) DO NOTHING;

UPDATE whatsapp_hub.contacts c SET kind = 'cliente'
WHERE c.kind IS NULL
  AND EXISTS (SELECT 1 FROM whatsapp_hub.deals d WHERE d.contact_id = c.id AND d.status = 'won');

-- 3. Modo demonstração (dashboard com dados fictícios) -----------------------
ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS demo_mode BOOLEAN NOT NULL DEFAULT false;
