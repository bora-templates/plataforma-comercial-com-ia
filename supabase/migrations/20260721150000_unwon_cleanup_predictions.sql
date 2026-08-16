-- ============================================================================
-- Negócio que SAI de 'won' (reaberto/perdido) → sai da Predição de Recompra
-- ----------------------------------------------------------------------------
-- O trigger _deal_won_to_sales insere venda + predição quando o negócio é
-- ganho, mas nada removia essas linhas quando o negócio deixava de ser ganho.
-- Resultado: leads reabertos ou marcados como perdidos continuavam na lista de
-- "Clientes" (Vendas & Recompra). Este cleanup remove o lastro de venda gerado
-- POR AQUELE ganho e apaga a predição que ficou sem nenhuma venda por trás.
--
-- Correlação precisa: _sync_deal_outcome_ts (BEFORE UPDATE) zera won_at ao sair
-- de 'won', então no AFTER UPDATE o OLD.won_at ainda guarda a data original —
-- exatamente o purchase_date usado ao registrar a venda (crm:negocio_ganho).
-- Vendas de upload (source_file ≠ 'crm:negocio_ganho') nunca são tocadas.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub._deal_unwon_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_doc  TEXT;
  v_date DATE := OLD.won_at::date;
BEGIN
  -- Só age quando um negócio ganho deixa de ser ganho.
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

  -- Remove a venda CRM originada deste ganho, por produto do negócio.
  DELETE FROM whatsapp_hub.sales_records sr
  USING whatsapp_hub.deal_products dp
  JOIN whatsapp_hub.products p ON p.id = dp.product_id
  WHERE dp.deal_id      = OLD.id
    AND sr.source_file  = 'crm:negocio_ganho'
    AND sr.customer_doc = v_doc
    AND sr.product_name = p.name
    AND sr.purchase_date = v_date;

  -- Fallback: negócio sem produtos usou o título como product_name.
  DELETE FROM whatsapp_hub.sales_records sr
  WHERE sr.source_file  = 'crm:negocio_ganho'
    AND sr.customer_doc = v_doc
    AND sr.product_name = OLD.title
    AND sr.purchase_date = v_date
    AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = OLD.id);

  -- Predições sem NENHUMA venda por trás (CRM ou upload) somem da lista.
  DELETE FROM whatsapp_hub.repurchase_predictions rp
  WHERE rp.customer_doc = v_doc
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.sales_records sr
      WHERE sr.customer_doc = rp.customer_doc
        AND sr.product_name = rp.product_name
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_unwon_cleanup ON whatsapp_hub.deals;
CREATE TRIGGER trg_deal_unwon_cleanup
  AFTER UPDATE OF status ON whatsapp_hub.deals
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._deal_unwon_cleanup();

-- ----------------------------------------------------------------------------
-- Backfill: limpa o que já vazou (predições/vendas CRM sem negócio ganho atual).
-- ----------------------------------------------------------------------------

-- 1. Remove vendas CRM que não têm um negócio ganho vigente por trás.
DELETE FROM whatsapp_hub.sales_records sr
WHERE sr.source_file = 'crm:negocio_ganho'
  AND NOT EXISTS (
    SELECT 1
    FROM whatsapp_hub.deals d
    JOIN whatsapp_hub.contacts c ON c.id = d.contact_id
    LEFT JOIN whatsapp_hub.deal_products dp ON dp.deal_id = d.id
    LEFT JOIN whatsapp_hub.products p ON p.id = dp.product_id
    WHERE d.status = 'won'
      AND d.won_at::date = sr.purchase_date
      AND COALESCE(NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
                   NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
                   c.id::text) = sr.customer_doc
      AND (p.name = sr.product_name
           OR (dp.deal_id IS NULL AND d.title = sr.product_name))
  );

-- 2. Remove predições órfãs (sem nenhuma venda por trás).
DELETE FROM whatsapp_hub.repurchase_predictions rp
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_hub.sales_records sr
  WHERE sr.customer_doc = rp.customer_doc
    AND sr.product_name = rp.product_name
);
