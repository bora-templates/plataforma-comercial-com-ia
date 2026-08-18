-- Os triggers de fechamento (_deal_won_to_sales e _deal_unwon_cleanup) ficaram
-- para tras na multi-tenancy. A chave de dedupe de sales_records e
-- repurchase_predictions passou a incluir org_id (sales_records_org_dedupe_key,
-- repurchase_predictions org unique), mas os ON CONFLICT dos triggers seguiam
-- sem org_id e apontavam para uma chave que ja nao tem indice unico:
--
--   ERROR: there is no unique or exclusion constraint matching the ON CONFLICT
--
-- Efeito: marcar qualquer oportunidade como "fechou" falhava. E o cleanup fazia
-- DELETE sem filtrar org, podendo apagar venda de outra organizacao com o mesmo
-- documento. Aqui os dois passam a carregar NEW.org_id / OLD.org_id em tudo.

CREATE OR REPLACE FUNCTION whatsapp_hub._deal_won_to_sales()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc  TEXT;
  v_name TEXT;
  v_phone TEXT;
  v_date DATE := COALESCE(NEW.won_at::date, now()::date);
  DEFAULT_CYCLE_DAYS CONSTANT INT := 30;
BEGIN
  IF NEW.status <> 'won' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'won' THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                  NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                  c.id::text),
         c.name, c.phone
  INTO v_doc, v_name, v_phone
  FROM whatsapp_hub.contacts c WHERE c.id = NEW.contact_id;

  INSERT INTO whatsapp_hub.sales_records
    (org_id, customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
  SELECT NEW.org_id, v_name, v_doc, v_phone, p.name, 1, NEW.value, v_date, 'crm:negocio_ganho'
  FROM whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id = NEW.id
  ON CONFLICT (org_id, customer_doc, product_name, purchase_date) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = NEW.id) THEN
    INSERT INTO whatsapp_hub.sales_records
      (org_id, customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
    VALUES (NEW.org_id, v_name, v_doc, v_phone, NEW.title, 1, NEW.value, v_date, 'crm:negocio_ganho')
    ON CONFLICT (org_id, customer_doc, product_name, purchase_date) DO NOTHING;
  END IF;

  INSERT INTO whatsapp_hub.repurchase_predictions
    (org_id, customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
     purchase_count, last_purchase, predicted_next, status, updated_at)
  SELECT NEW.org_id, v_doc, COALESCE(v_phone, ''), v_name, p.name, DEFAULT_CYCLE_DAYS,
         1, v_date, v_date + DEFAULT_CYCLE_DAYS, 'pending', now()
  FROM whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id = NEW.id
  ON CONFLICT (org_id, customer_doc, product_name) DO UPDATE SET
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
      (org_id, customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
       purchase_count, last_purchase, predicted_next, status, updated_at)
    VALUES (NEW.org_id, v_doc, COALESCE(v_phone, ''), v_name, NEW.title, DEFAULT_CYCLE_DAYS,
            1, v_date, v_date + DEFAULT_CYCLE_DAYS, 'pending', now())
    ON CONFLICT (org_id, customer_doc, product_name) DO UPDATE SET
      customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone, ''), whatsapp_hub.repurchase_predictions.customer_phone),
      customer_name  = COALESCE(EXCLUDED.customer_name, whatsapp_hub.repurchase_predictions.customer_name),
      last_purchase  = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase),
      predicted_next = GREATEST(EXCLUDED.last_purchase, whatsapp_hub.repurchase_predictions.last_purchase)
                       + whatsapp_hub.repurchase_predictions.avg_interval_days,
      status = CASE WHEN EXCLUDED.last_purchase > whatsapp_hub.repurchase_predictions.last_purchase
                    THEN 'pending' ELSE whatsapp_hub.repurchase_predictions.status END,
      updated_at = now();
  END IF;

  UPDATE whatsapp_hub.contacts SET kind = 'cliente'
  WHERE id = NEW.contact_id AND kind IS NULL;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION whatsapp_hub._deal_unwon_cleanup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc  TEXT;
  v_date DATE := OLD.won_at::date;
BEGIN
  IF NOT (OLD.status = 'won' AND NEW.status IS DISTINCT FROM 'won') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                  NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                  c.id::text)
    INTO v_doc
    FROM whatsapp_hub.contacts c WHERE c.id = OLD.contact_id;

  IF v_doc IS NULL OR v_date IS NULL THEN
    RETURN NEW;
  END IF;

  DELETE FROM whatsapp_hub.sales_records sr
  USING whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id      = OLD.id
    AND sr.org_id       = OLD.org_id
    AND sr.source_file  = 'crm:negocio_ganho'
    AND sr.customer_doc = v_doc
    AND sr.product_name = p.name
    AND sr.purchase_date = v_date;

  DELETE FROM whatsapp_hub.sales_records sr
  WHERE sr.org_id       = OLD.org_id
    AND sr.source_file  = 'crm:negocio_ganho'
    AND sr.customer_doc = v_doc
    AND sr.product_name = OLD.title
    AND sr.purchase_date = v_date
    AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = OLD.id);

  DELETE FROM whatsapp_hub.repurchase_predictions rp
  WHERE rp.org_id = OLD.org_id
    AND rp.customer_doc = v_doc
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.sales_records sr
      WHERE sr.org_id = rp.org_id
        AND sr.customer_doc = rp.customer_doc
        AND sr.product_name = rp.product_name
    );

  RETURN NEW;
END;
$function$;
