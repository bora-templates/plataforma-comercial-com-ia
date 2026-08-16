-- ============================================================================
-- Contatos: tipo (lead|cliente) · Vendas: importar negócios ganhos
-- ----------------------------------------------------------------------------
-- 1. contacts.kind — classificação escolhida na importação (e editável):
--    'lead' (entra no funil) | 'cliente' (aparece em Vendas & Recompra).
-- 2. RPC import_won_deals_to_sales() — transforma negócios GANHOS em registros
--    da base de vendas (sales_records), um por produto do negócio (ou um único
--    com o título do negócio, se não houver produtos). Dedup pela unique
--    (customer_doc, product_name, purchase_date); doc = CNPJ do custom_fields,
--    senão o telefone, senão o id do contato.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_kind_chk') THEN
    ALTER TABLE whatsapp_hub.contacts
      ADD CONSTRAINT contacts_kind_chk CHECK (kind IS NULL OR kind IN ('lead','cliente'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_kind ON whatsapp_hub.contacts(kind);

-- Negócios ganhos → base de vendas. SECURITY DEFINER com gate explícito de
-- admin/operator (RLS de sales_records é admin-write; o gate mantém a regra).
CREATE OR REPLACE FUNCTION whatsapp_hub.import_won_deals_to_sales()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_inserted INT := 0;
BEGIN
  IF whatsapp_hub.current_user_role() NOT IN ('admin','operator') THEN
    RAISE EXCEPTION 'Apenas admin/operator podem importar negócios ganhos.';
  END IF;

  WITH won AS (
    SELECT d.id, d.title, d.value, d.won_at::date AS won_date, d.contact_id,
           c.name AS contact_name, c.phone,
           COALESCE(
             NULLIF(btrim(c.custom_fields ->> 'cnpj'), ''),
             NULLIF(regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g'), ''),
             d.contact_id::text
           ) AS doc
    FROM whatsapp_hub.deals d
    JOIN whatsapp_hub.contacts c ON c.id = d.contact_id
    WHERE d.status = 'won' AND d.won_at IS NOT NULL
  ),
  rows_to_insert AS (
    -- Um registro por produto atrelado ao negócio…
    SELECT w.doc, w.contact_name, w.phone, p.name AS product_name,
           1 AS quantity, w.value AS amount, w.won_date
    FROM won w
    JOIN whatsapp_hub.deal_products dp ON dp.deal_id = w.id
    JOIN whatsapp_hub.products p ON p.id = dp.product_id
    UNION ALL
    -- …ou o título do negócio quando não há produtos.
    SELECT w.doc, w.contact_name, w.phone, w.title,
           1, w.value, w.won_date
    FROM won w
    WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.deal_products dp WHERE dp.deal_id = w.id)
  ),
  ins AS (
    INSERT INTO whatsapp_hub.sales_records
      (customer_name, customer_doc, customer_phone, product_name, quantity, amount, purchase_date, source_file)
    SELECT r.contact_name, r.doc, r.phone, r.product_name, r.quantity, r.amount, r.won_date, 'crm:negocios_ganhos'
    FROM rows_to_insert r
    ON CONFLICT (customer_doc, product_name, purchase_date) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  -- Contatos desses negócios viram clientes (sem sobrescrever escolha manual).
  UPDATE whatsapp_hub.contacts c
  SET kind = 'cliente'
  WHERE c.kind IS NULL
    AND EXISTS (SELECT 1 FROM whatsapp_hub.deals d WHERE d.contact_id = c.id AND d.status = 'won');

  RETURN v_inserted;
END;
$$;
