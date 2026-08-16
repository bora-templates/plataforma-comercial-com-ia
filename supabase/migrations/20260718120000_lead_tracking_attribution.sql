-- ============================================================================
-- Tracking Inteligente de Origem de Leads · Fase 0
-- ----------------------------------------------------------------------------
-- Evolui o Módulo 4 (20260713130000_utm_tracking.sql). Naquele módulo a
-- normalização vivia num JSONB app_settings.utm_channel_map e a derivação
-- colapsava fb/ig em 'meta_ads'. Aqui a atribuição vira multi-camada:
--
--   1. Novas colunas em deals: attribution_method, raw_tracking, tracking_session_id.
--      (utm_*, traffic_type, origin_channel já existem do Módulo 4.)
--   2. Tabela whatsapp_hub.utm_channel_map — mapa de aliases EDITÁVEL por linha
--      (match_type/match_value/priority), consultado pela trigger. Substitui o
--      JSONB do Módulo 4 como fonte de verdade da normalização.
--   3. Trigger _derive_deal_traffic() reescrita: consulta a tabela por
--      prioridade, separa instagram_ads vs facebook_ads (não colapsa em
--      meta_ads), e reconcilia attribution_method sem rebaixar um método mais
--      forte já gravado (ctwa > codigo_rastreio > utm_landing > manual).
--   4. RLS padrão whatsapp_hub (leitura autenticado; escrita admin).
--
-- NB: tracking_session_id é adicionada como uuid nullable SEM a FK — a tabela
--     whatsapp_hub.tracking_sessions nasce na Fase 1, que adiciona a constraint.
-- NB: o JSONB app_settings.utm_channel_map e a UI UtmMappingSettings.tsx ficam
--     órfãos (débito técnico registrado); a trigger deixa de consultá-los.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Novas colunas de atribuição em deals -----------------------------------
ALTER TABLE whatsapp_hub.deals
  ADD COLUMN IF NOT EXISTS attribution_method  TEXT,   -- utm_landing | ctwa | codigo_rastreio | manual
  ADD COLUMN IF NOT EXISTS raw_tracking        JSONB,  -- query string crua (utm_id/adset_id/ad_id/placement/fbclid)
  ADD COLUMN IF NOT EXISTS tracking_session_id UUID;   -- FK p/ tracking_sessions adicionada na Fase 1

CREATE INDEX IF NOT EXISTS idx_deals_attribution_method ON whatsapp_hub.deals(attribution_method);

-- 2. Mapa de canal editável (uma linha por regra) ---------------------------
-- match_type:
--   'source'          → casa por utm_source (qualquer medium)
--   'medium'          → casa por utm_medium (qualquer source)
--   'source_medium'   → casa por "<source>|<medium>" (match_value já no formato)
--   'campaign_pattern'→ casa por utm_campaign ILIKE match_value (usar % você mesmo)
-- match_value é sempre armazenado em lowercase; a trigger compara em lowercase.
CREATE TABLE IF NOT EXISTS whatsapp_hub.utm_channel_map (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type     TEXT NOT NULL CHECK (match_type IN ('source','medium','source_medium','campaign_pattern')),
  match_value    TEXT NOT NULL,
  traffic_type   TEXT NOT NULL,   -- organico | pago | manual
  origin_channel TEXT NOT NULL,   -- instagram_ads | facebook_ads | meta_ads | ...
  priority       INT  NOT NULL DEFAULT 100,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utm_channel_map_lookup
  ON whatsapp_hub.utm_channel_map(match_type, match_value, priority DESC);

-- Seed idempotente cobrindo os casos reais de produção.
INSERT INTO whatsapp_hub.utm_channel_map (match_type, match_value, traffic_type, origin_channel, priority)
SELECT * FROM (VALUES
  -- Meta Ads — source já resolvido pela plataforma
  ('source_medium', 'ig|paid_social',                  'pago',     'instagram_ads',      100),
  ('source_medium', 'fb|paid_social',                  'pago',     'facebook_ads',       100),
  ('source_medium', 'an|paid_social',                  'pago',     'meta_ads',           100),  -- Audience Network
  ('source_medium', 'msg|paid_social',                 'pago',     'meta_ads',           100),  -- Messenger
  -- literal não substituído pela Meta → NÃO cair em "outro"
  ('source_medium', '{{site_source_name}}|paid_social','pago',     'meta_ads',           100),
  -- fallback de medium: qualquer paid_social sem source conhecido → Meta Ads
  ('medium',        'paid_social',                     'pago',     'meta_ads',            20),
  -- Instagram / Facebook orgânico
  ('source_medium', 'instagram|organic',               'organico', 'instagram_organico',  90),
  ('source_medium', 'instagram|social',                'organico', 'instagram_organico',  90),
  ('source_medium', 'facebook|organic',                'organico', 'facebook_organico',   90),
  ('source_medium', 'facebook|social',                 'organico', 'facebook_organico',   90),
  -- Google
  ('source_medium', 'google|cpc',                      'pago',     'google_ads',          90),
  ('source_medium', 'google|paid',                     'pago',     'google_ads',          90),
  ('source_medium', 'google|ppc',                      'pago',     'google_ads',          90),
  ('source_medium', 'google|organic',                  'organico', 'google_organico',     90),
  -- TikTok
  ('source_medium', 'tiktok|paid_social',              'pago',     'tiktok_ads',          90),
  ('source_medium', 'tiktok|cpc',                      'pago',     'tiktok_ads',          90),
  ('source_medium', 'tiktok|organic',                  'organico', 'tiktok_organico',     90),
  ('source_medium', 'tiktok|social',                   'organico', 'tiktok_organico',     90),
  -- LinkedIn
  ('source_medium', 'linkedin|paid',                   'pago',     'linkedin_ads',        90),
  ('source_medium', 'linkedin|cpc',                    'pago',     'linkedin_ads',        90),
  ('source_medium', 'linkedin|organic',                'organico', 'linkedin_organico',   90),
  ('source_medium', 'linkedin|social',                 'organico', 'linkedin_organico',   90),
  -- YouTube (ads; orgânico cai em 'outro' pois não há youtube_organico no enum)
  ('source_medium', 'youtube|cpc',                     'pago',     'youtube_ads',         90),
  ('source_medium', 'youtube|paid',                    'pago',     'youtube_ads',         90),
  -- Fallbacks a nível de source (qualquer medium) — prioridade baixa
  ('source',        'instagram',                       'organico', 'instagram_organico',  10),
  ('source',        'facebook',                        'organico', 'facebook_organico',   10),
  ('source',        'google',                          'organico', 'google_organico',     10),
  ('source',        'tiktok',                          'organico', 'tiktok_organico',     10),
  ('source',        'linkedin',                        'organico', 'linkedin_organico',   10),
  -- WhatsApp como origem direta
  ('source',        'whatsapp',                        'manual',   'whatsapp_direto',     10)
) AS seed(match_type, match_value, traffic_type, origin_channel, priority)
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_hub.utm_channel_map m
  WHERE m.match_type = seed.match_type AND m.match_value = seed.match_value
);

-- 3. Trigger de derivação (consulta a tabela) --------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._derive_deal_traffic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  src         TEXT := NULLIF(btrim(lower(NEW.utm_source)), '');
  med         TEXT := NULLIF(btrim(lower(NEW.utm_medium)), '');
  camp        TEXT := NULLIF(btrim(lower(NEW.utm_campaign)), '');
  utm_present BOOLEAN;
  hit_traffic TEXT;
  hit_channel TEXT;
  inferred    TEXT;
BEGIN
  utm_present := (src IS NOT NULL OR med IS NOT NULL OR camp IS NOT NULL
                  OR NULLIF(btrim(NEW.utm_content), '') IS NOT NULL
                  OR NULLIF(btrim(NEW.utm_term), '')    IS NOT NULL);

  -- 3a. Deriva traffic_type + origin_channel pelo mapa (maior prioridade vence).
  SELECT m.traffic_type, m.origin_channel
    INTO hit_traffic, hit_channel
  FROM whatsapp_hub.utm_channel_map m
  WHERE
       (m.match_type = 'source_medium'    AND src IS NOT NULL AND med IS NOT NULL
                                          AND m.match_value = src || '|' || med)
    OR (m.match_type = 'source'           AND src IS NOT NULL AND m.match_value = src)
    OR (m.match_type = 'medium'           AND med IS NOT NULL AND m.match_value = med)
    OR (m.match_type = 'campaign_pattern' AND camp IS NOT NULL AND camp LIKE m.match_value)
  ORDER BY m.priority DESC, m.created_at ASC
  LIMIT 1;

  IF hit_channel IS NOT NULL THEN
    NEW.traffic_type   := hit_traffic;
    NEW.origin_channel := hit_channel;
  ELSIF utm_present THEN
    -- UTM presente mas não mapeada → heurística leve de pago + canal 'outro'.
    NEW.traffic_type := CASE
      WHEN med IS NOT NULL AND (med IN ('cpc','ppc','cpm','paid','paid_social','display') OR med LIKE '%paid%')
        THEN 'pago' ELSE 'organico' END;
    NEW.origin_channel := 'outro';
  ELSE
    -- Sem nenhuma UTM: preserva o que o caller informou (ex.: whatsapp_direto
    -- setado pela reconciliação de inbound), senão manual/outro.
    NEW.traffic_type   := COALESCE(NULLIF(btrim(lower(NEW.traffic_type)), ''), 'manual');
    NEW.origin_channel := COALESCE(NULLIF(btrim(NEW.origin_channel), ''), 'outro');
  END IF;

  -- 3b. attribution_method: infere só quando não informado; nunca rebaixa um
  --     método mais forte já gravado. Força: ctwa > codigo_rastreio > utm_landing > manual.
  inferred := CASE WHEN utm_present THEN 'utm_landing' ELSE 'manual' END;
  IF NULLIF(btrim(NEW.attribution_method), '') IS NULL THEN
    NEW.attribution_method := inferred;
  END IF;
  IF TG_OP = 'UPDATE'
     AND whatsapp_hub._attribution_strength(NEW.attribution_method)
       < whatsapp_hub._attribution_strength(OLD.attribution_method) THEN
    NEW.attribution_method := OLD.attribution_method;
  END IF;

  RETURN NEW;
END;
$$;

-- Força relativa dos métodos de atribuição (para nunca rebaixar).
CREATE OR REPLACE FUNCTION whatsapp_hub._attribution_strength(p_method TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE
SET search_path = whatsapp_hub, public, pg_temp
AS $$
  SELECT CASE lower(coalesce(p_method, ''))
    WHEN 'ctwa'            THEN 4
    WHEN 'codigo_rastreio' THEN 3
    WHEN 'utm_landing'     THEN 2
    WHEN 'manual'          THEN 1
    ELSE 0
  END;
$$;

DROP TRIGGER IF EXISTS trg_deals_derive_traffic ON whatsapp_hub.deals;
CREATE TRIGGER trg_deals_derive_traffic
  BEFORE INSERT OR UPDATE OF utm_source, utm_medium, utm_campaign, utm_content, utm_term, traffic_type, attribution_method
  ON whatsapp_hub.deals
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._derive_deal_traffic();

-- 4. RLS ---------------------------------------------------------------------
ALTER TABLE whatsapp_hub.utm_channel_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utm_channel_map_read ON whatsapp_hub.utm_channel_map;
CREATE POLICY utm_channel_map_read ON whatsapp_hub.utm_channel_map
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS utm_channel_map_write ON whatsapp_hub.utm_channel_map;
CREATE POLICY utm_channel_map_write ON whatsapp_hub.utm_channel_map
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');
