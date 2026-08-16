-- ============================================================================
-- Atribuição: canal correto para inbound de Instagram sem sinal de tracking
-- ----------------------------------------------------------------------------
-- attribute_inbound_lead passava a existir só para WhatsApp: sem CTWA e sem
-- código, caía em whatsapp_direto — errado para DMs do Instagram. Agora o
-- p_provider decide o fallback: 'instagram' → instagram_organico/organico;
-- demais → whatsapp_direto/manual. O resto da função é idêntico.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.attribute_inbound_lead(
  p_contact_id UUID,
  p_text       TEXT,
  p_referral   JSONB DEFAULT NULL,
  p_provider   TEXT  DEFAULT 'whatsapp'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_ctwa        TEXT := NULLIF(btrim(p_referral ->> 'ctwa_clid'), '');
  v_code        TEXT;
  v_session     whatsapp_hub.tracking_sessions%ROWTYPE;
  v_method      TEXT;
  v_origin      TEXT;
  v_traffic     TEXT;
  v_raw         JSONB;
  v_utm         JSONB := '{}'::jsonb;
  v_session_id  UUID;
  v_deal        UUID;
  v_pipeline    UUID;
  v_stage       UUID;
  v_title       TEXT;
BEGIN
  -- 1. CTWA nativo (só chega no caminho oficial/Zernio) --------------------
  IF v_ctwa IS NOT NULL THEN
    v_method  := 'ctwa';
    v_origin  := 'meta_ads';
    v_traffic := 'pago';
    v_raw     := jsonb_build_object('ctwa_clid', v_ctwa, 'referral', p_referral);
  ELSE
    -- 2. Código de rastreio [XXXX] na 1ª mensagem -------------------------
    v_code := upper((regexp_match(COALESCE(p_text, ''), '\[([0-9A-Za-z]{4,10})\]'))[1]);
    IF v_code IS NOT NULL THEN
      SELECT * INTO v_session
      FROM whatsapp_hub.tracking_sessions
      WHERE short_code = v_code
      ORDER BY created_at DESC
      LIMIT 1;
    END IF;

    IF v_session.id IS NOT NULL THEN
      v_method     := 'codigo_rastreio';
      v_session_id := v_session.id;
      v_raw        := v_session.raw_query;
      v_utm := jsonb_strip_nulls(jsonb_build_object(
        'utm_source',   v_session.utm_source,
        'utm_medium',   v_session.utm_medium,
        'utm_campaign', v_session.utm_campaign,
        'utm_content',  v_session.utm_content,
        'utm_term',     v_session.utm_term
      ));
    ELSE
      -- 3. Sem sinal → fallback por provedor -----------------------------
      v_method := 'manual';
      IF p_provider = 'instagram' THEN
        v_origin  := 'instagram_organico';
        v_traffic := 'organico';
      ELSE
        v_origin  := 'whatsapp_direto';
        v_traffic := 'manual';
      END IF;
    END IF;
  END IF;

  -- Find-or-create do deal do contato -------------------------------------
  SELECT id INTO v_deal
  FROM whatsapp_hub.deals
  WHERE contact_id = p_contact_id AND status = 'open'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_deal IS NULL THEN
    SELECT id INTO v_pipeline
    FROM whatsapp_hub.pipelines
    WHERE kind = 'comercial'
    ORDER BY position, created_at
    LIMIT 1;

    SELECT id INTO v_stage
    FROM whatsapp_hub.stages
    WHERE pipeline_id = v_pipeline AND NOT is_won AND NOT is_lost
    ORDER BY position
    LIMIT 1;

    SELECT COALESCE(NULLIF(btrim(name), ''), phone, 'Lead WhatsApp')
    INTO v_title
    FROM whatsapp_hub.contacts WHERE id = p_contact_id;

    INSERT INTO whatsapp_hub.deals (
      contact_id, pipeline_id, stage_id, title, status,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      attribution_method, origin_channel, traffic_type,
      raw_tracking, tracking_session_id
    ) VALUES (
      p_contact_id, v_pipeline, v_stage, v_title, 'open',
      v_utm ->> 'utm_source', v_utm ->> 'utm_medium', v_utm ->> 'utm_campaign',
      v_utm ->> 'utm_content', v_utm ->> 'utm_term',
      v_method, v_origin, v_traffic,
      v_raw, v_session_id
    )
    RETURNING id INTO v_deal;
  ELSE
    UPDATE whatsapp_hub.deals SET
      utm_source          = COALESCE(v_utm ->> 'utm_source',   utm_source),
      utm_medium          = COALESCE(v_utm ->> 'utm_medium',   utm_medium),
      utm_campaign        = COALESCE(v_utm ->> 'utm_campaign', utm_campaign),
      utm_content         = COALESCE(v_utm ->> 'utm_content',  utm_content),
      utm_term            = COALESCE(v_utm ->> 'utm_term',     utm_term),
      attribution_method  = v_method,
      origin_channel      = COALESCE(v_origin, origin_channel),
      traffic_type        = COALESCE(v_traffic, traffic_type),
      raw_tracking        = COALESCE(v_raw, raw_tracking),
      tracking_session_id = COALESCE(v_session_id, tracking_session_id)
    WHERE id = v_deal;
  END IF;

  IF v_session_id IS NOT NULL THEN
    UPDATE whatsapp_hub.tracking_sessions
    SET reconciled_at = now(), deal_id = v_deal
    WHERE id = v_session_id AND reconciled_at IS NULL;
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'deal_id', v_deal,
      'attribution_method', d.attribution_method,
      'origin_channel', d.origin_channel,
      'traffic_type', d.traffic_type,
      'tracking_session_id', v_session_id
    )
    FROM whatsapp_hub.deals d WHERE d.id = v_deal
  );
END;
$$;

REVOKE ALL ON FUNCTION whatsapp_hub.attribute_inbound_lead(UUID, TEXT, JSONB, TEXT) FROM PUBLIC;
