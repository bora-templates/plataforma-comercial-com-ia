-- ============================================================================
-- Negócio ganho → entra DIRETO na lista de Predição de Recompra
-- ----------------------------------------------------------------------------
-- O card "Clientes" separado sai da UI; o cliente ganho vira linha em
-- repurchase_predictions com ciclo padrão de 30 dias (1 compra ainda não tem
-- intervalo real). Quando o histórico acumular (>= min_purchases), o
-- compute_repurchase_predictions sobrescreve com o ciclo verdadeiro — ele faz
-- upsert por (customer_doc, product_name) e nunca apaga linhas.
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
  DEFAULT_CYCLE_DAYS CONSTANT INT := 30;
BEGIN
  IF NEW.status <> 'won' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'won' THEN RETURN NEW; END IF; -- já processado

  SELECT COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                  NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                  c.id::text),
         c.name, c.phone
  INTO v_doc, v_name, v_phone
  FROM whatsapp_hub.contacts c WHERE c.id = NEW.contact_id;

  -- Base de vendas: um registro por produto do negócio; sem produtos → título.
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

  -- Predição de recompra: o cliente ganho entra na LISTA com ciclo padrão.
  -- Linha já existente (calculada pelo compute) mantém o ciclo real; só a
  -- última compra/próxima prevista avançam quando a venda é mais recente.
  INSERT INTO whatsapp_hub.repurchase_predictions
    (customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
     purchase_count, last_purchase, predicted_next, status, updated_at)
  SELECT v_doc, COALESCE(v_phone, ''), v_name, p.name, DEFAULT_CYCLE_DAYS,
         1, v_date, v_date + DEFAULT_CYCLE_DAYS, 'pending', now()
  FROM whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id = NEW.id
  ON CONFLICT (customer_doc, product_name) DO UPDATE SET
    customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone, ''), whatsapp_hub.repurchase_predictions.customer_phone),
    customer_name  = COALESCE(EXCLUDED.customer_name, whatsapp_hub.repurchase_predictions.customer_name),
    last_purchase  = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase),
    predicted_next = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase)
                     + whatsapp_hub.repurchase_predictions.avg_interval_days,
    status = CASE WHEN EXCLUDED.last_purchase > whatsapp_hub.repurchase_predictions.last_purchase
                  THEN 'pending' ELSE whatsapp_hub.repurchase_predictions.status END,
    updated_at = now();

  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = NEW.id) THEN
    INSERT INTO whatsapp_hub.repurchase_predictions
      (customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
       purchase_count, last_purchase, predicted_next, status, updated_at)
    VALUES (v_doc, COALESCE(v_phone, ''), v_name, NEW.title, DEFAULT_CYCLE_DAYS,
            1, v_date, v_date + DEFAULT_CYCLE_DAYS, 'pending', now())
    ON CONFLICT (customer_doc, product_name) DO UPDATE SET
      customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone, ''), whatsapp_hub.repurchase_predictions.customer_phone),
      customer_name  = COALESCE(EXCLUDED.customer_name, whatsapp_hub.repurchase_predictions.customer_name),
      last_purchase  = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase),
      predicted_next = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase)
                       + whatsapp_hub.repurchase_predictions.avg_interval_days,
      status = CASE WHEN EXCLUDED.last_purchase > whatsapp_hub.repurchase_predictions.last_purchase
                    THEN 'pending' ELSE whatsapp_hub.repurchase_predictions.status END,
      updated_at = now();
  END IF;

  -- Quem compra é cliente (não sobrescreve escolha manual).
  UPDATE whatsapp_hub.contacts SET kind = 'cliente'
  WHERE id = NEW.contact_id AND kind IS NULL;

  RETURN NEW;
END;
$$;

-- Backfill: vendas de ganhos já registradas (crm:negocio_ganho) sem predição.
INSERT INTO whatsapp_hub.repurchase_predictions
  (customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
   purchase_count, last_purchase, predicted_next, status, updated_at)
SELECT sr.customer_doc, COALESCE(sr.customer_phone, ''), sr.customer_name, sr.product_name,
       30, 1, sr.purchase_date, sr.purchase_date + 30, 'pending', now()
FROM whatsapp_hub.sales_records sr
WHERE sr.source_file = 'crm:negocio_ganho' AND sr.customer_doc IS NOT NULL
ON CONFLICT (customer_doc, product_name) DO NOTHING;
