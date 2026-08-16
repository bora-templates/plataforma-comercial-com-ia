-- ============================================================================
-- Tracking Inteligente de Origem de Leads · Fase 1
-- ----------------------------------------------------------------------------
-- O redirecionador /r/:linkId (Edge Function redirect-tracker) captura o clique
-- ANTES de qualquer destino — blinda WhatsApp/Instagram onde não há código nosso.
--
--   1. gen_short_code() — códigos curtos Crockford-base32 (sem I/L/O/U).
--   2. tracking_sessions — uma linha por clique no /r/.
--   3. FK deals.tracking_session_id → tracking_sessions (coluna criada na Fase 0).
--   4. utm_links ganha slug (o :linkId do /r/) + config de destino
--      (destination_type + wa_number + wa_message). base_url continua sendo o
--      destino para landing/instagram/other.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Gerador de código curto legível (Crockford base32) ----------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.gen_short_code(p_len INT DEFAULT 6)
RETURNS TEXT
LANGUAGE sql VOLATILE
SET search_path = whatsapp_hub, public, pg_temp
AS $$
  SELECT string_agg(
           substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                  1 + floor(random() * 32)::int, 1), '')
  FROM generate_series(1, GREATEST(p_len, 1));
$$;

-- 2. Sessões de rastreio (uma por clique no /r/) -----------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.tracking_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code       TEXT NOT NULL UNIQUE DEFAULT whatsapp_hub.gen_short_code(6),
  campaign_link_id UUID REFERENCES whatsapp_hub.utm_links(id) ON DELETE SET NULL,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_content      TEXT,
  utm_term         TEXT,
  raw_query        JSONB,
  fbclid           TEXT,
  destination_type TEXT,                          -- landing | whatsapp | instagram | other
  destination_url  TEXT,
  ip               TEXT,
  user_agent       TEXT,
  referer          TEXT,
  deal_id          UUID REFERENCES whatsapp_hub.deals(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_link    ON whatsapp_hub.tracking_sessions(campaign_link_id);
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_deal    ON whatsapp_hub.tracking_sessions(deal_id);
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_created ON whatsapp_hub.tracking_sessions(created_at DESC);

-- 3. FK de deals.tracking_session_id (coluna nasceu sem FK na Fase 0) ---------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_tracking_session_fk'
  ) THEN
    ALTER TABLE whatsapp_hub.deals
      ADD CONSTRAINT deals_tracking_session_fk
      FOREIGN KEY (tracking_session_id)
      REFERENCES whatsapp_hub.tracking_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. utm_links: slug do /r/ + config de destino ------------------------------
ALTER TABLE whatsapp_hub.utm_links
  ADD COLUMN IF NOT EXISTS slug             TEXT UNIQUE DEFAULT whatsapp_hub.gen_short_code(6),
  ADD COLUMN IF NOT EXISTS destination_type TEXT NOT NULL DEFAULT 'landing',
  ADD COLUMN IF NOT EXISTS wa_number        TEXT,
  ADD COLUMN IF NOT EXISTS wa_message       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'utm_links_destination_type_chk'
  ) THEN
    ALTER TABLE whatsapp_hub.utm_links
      ADD CONSTRAINT utm_links_destination_type_chk
      CHECK (destination_type IN ('landing','whatsapp','instagram','other'));
  END IF;
END $$;

-- Backfill de slug para eventuais linhas legadas sem slug.
UPDATE whatsapp_hub.utm_links SET slug = whatsapp_hub.gen_short_code(6) WHERE slug IS NULL;

-- 5. RLS ---------------------------------------------------------------------
-- Escrita só via service role (Edge Function redirect-tracker / reconciliação).
-- Leitura liberada a usuários do CRM para telas de auditoria de origem.
ALTER TABLE whatsapp_hub.tracking_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_sessions_read ON whatsapp_hub.tracking_sessions;
CREATE POLICY tracking_sessions_read ON whatsapp_hub.tracking_sessions
  FOR SELECT TO authenticated USING (true);
