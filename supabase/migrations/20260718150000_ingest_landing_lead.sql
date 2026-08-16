-- ============================================================================
-- Tracking Inteligente de Origem de Leads · Fase 5
-- ----------------------------------------------------------------------------
-- RPC de ingestão do lead vindo da landing (form + snippet). Atribuição
-- attribution_method = utm_landing. Snapshot das UTMs congelado no deal; a
-- trigger deriva traffic_type/origin_channel. Vincula a tracking_session quando
-- o short_code (utm_ref) chega pelo redirecionador.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.ingest_landing_lead(
  p_contact_id UUID,
  p_utm        JSONB DEFAULT '{}'::jsonb,
  p_raw        JSONB DEFAULT NULL,
  p_short_code TEXT  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_session_id UUID;
  v_deal       UUID;
  v_pipeline   UUID;
  v_stage      UUID;
  v_title      TEXT;
  v_code       TEXT := upper(NULLIF(btrim(p_short_code), ''));
  v_utm        JSONB := jsonb_strip_nulls(COALESCE(p_utm, '{}'::jsonb));
BEGIN
  IF v_code IS NOT NULL THEN
    SELECT id INTO v_session_id
    FROM whatsapp_hub.tracking_sessions
    WHERE short_code = v_code
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  SELECT id INTO v_deal
  FROM whatsapp_hub.deals
  WHERE contact_id = p_contact_id AND status = 'open'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_deal IS NULL THEN
    SELECT id INTO v_pipeline
    FROM whatsapp_hub.pipelines WHERE kind = 'comercial'
    ORDER BY position, created_at LIMIT 1;
    SELECT id INTO v_stage
    FROM whatsapp_hub.stages
    WHERE pipeline_id = v_pipeline AND NOT is_won AND NOT is_lost
    ORDER BY position LIMIT 1;
    SELECT COALESCE(NULLIF(btrim(name), ''), phone, email, 'Lead')
    INTO v_title FROM whatsapp_hub.contacts WHERE id = p_contact_id;

    INSERT INTO whatsapp_hub.deals (
      contact_id, pipeline_id, stage_id, title, status,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      attribution_method, raw_tracking, tracking_session_id
    ) VALUES (
      p_contact_id, v_pipeline, v_stage, v_title, 'open',
      v_utm ->> 'utm_source', v_utm ->> 'utm_medium', v_utm ->> 'utm_campaign',
      v_utm ->> 'utm_content', v_utm ->> 'utm_term',
      'utm_landing', p_raw, v_session_id
    )
    RETURNING id INTO v_deal;
  ELSE
    UPDATE whatsapp_hub.deals SET
      utm_source          = COALESCE(v_utm ->> 'utm_source',   utm_source),
      utm_medium          = COALESCE(v_utm ->> 'utm_medium',   utm_medium),
      utm_campaign        = COALESCE(v_utm ->> 'utm_campaign', utm_campaign),
      utm_content         = COALESCE(v_utm ->> 'utm_content',  utm_content),
      utm_term            = COALESCE(v_utm ->> 'utm_term',     utm_term),
      attribution_method  = 'utm_landing',
      raw_tracking        = COALESCE(p_raw, raw_tracking),
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

REVOKE ALL ON FUNCTION whatsapp_hub.ingest_landing_lead(UUID, JSONB, JSONB, TEXT) FROM PUBLIC;
