-- ============================================================================
-- Lead perdido que volta a falar volta como lead
-- ----------------------------------------------------------------------------
-- Regra decidida pelo Luis em 02/10/2026 (opcao 2), sobre 20261002120000:
--   - lead com card perdido ha mais de 7 dias que manda mensagem de novo
--     ganha card novo no funil padrao, e a IA trabalha esse lead outra vez;
--   - perdido ha menos de 7 dias nao ganha: e a mesma conversa que terminou em
--     perdido ("ok, obrigado") e viraria card falso;
--   - quem ja comprou alguma vez (card ganho) continua sem card automatico,
--     porque costuma voltar para suporte.
-- A data do perdido vem de lost_at (gatilho trg_deals_outcome_ts), com
-- updated_at e created_at para cards antigos sem lost_at.
-- So a funcao muda: o gatilho on_inbound_card e as permissoes seguem iguais.
-- Idempotente: pode rodar de novo em instalacao que ja esta no ar.
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
  v_org         UUID;
  v_ctwa        TEXT := NULLIF(btrim(p_referral ->> 'ctwa_clid'), '');
  v_code        TEXT;
  v_session     whatsapp_hub.tracking_sessions%ROWTYPE;
  v_signal      BOOLEAN := false;
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
  SELECT org_id INTO v_org FROM whatsapp_hub.contacts WHERE id = p_contact_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('deal_id', NULL, 'skipped', 'contato_inexistente');
  END IF;

  -- Duas mensagens do mesmo contato novo chegando juntas (webhooks em paralelo)
  -- criariam dois cards. A trava vale ate o fim da transacao de cada mensagem.
  PERFORM pg_advisory_xact_lock(hashtext('attribute_inbound_lead'), hashtext(p_contact_id::text));

  -- 1. CTWA nativo (so chega no caminho oficial) ------------------------------
  IF v_ctwa IS NOT NULL THEN
    v_signal  := true;
    v_method  := 'ctwa';
    v_origin  := 'meta_ads';
    v_traffic := 'pago';
    v_raw     := jsonb_build_object('ctwa_clid', v_ctwa, 'referral', p_referral);
  ELSE
    -- 2. Codigo de rastreio [XXXX] da propria organizacao --------------------
    v_code := upper((regexp_match(COALESCE(p_text, ''), '\[([0-9A-Za-z]{4,10})\]'))[1]);
    IF v_code IS NOT NULL THEN
      SELECT * INTO v_session
        FROM whatsapp_hub.tracking_sessions
       WHERE short_code = v_code
         AND org_id = v_org
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;

    IF v_session.id IS NOT NULL THEN
      v_signal     := true;
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
      -- 3. Sem sinal: a origem vem do canal ----------------------------------
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

  -- Card aberto do contato, sempre dentro da organizacao dele ----------------
  SELECT id INTO v_deal
    FROM whatsapp_hub.deals
   WHERE contact_id = p_contact_id
     AND org_id = v_org
     AND status = 'open'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_deal IS NULL THEN
    -- Quem ja comprou alguma vez (card ganho) nao ganha card novo sozinho.
    IF EXISTS (
      SELECT 1 FROM whatsapp_hub.deals
       WHERE contact_id = p_contact_id AND org_id = v_org AND status = 'won'
    ) THEN
      RETURN jsonb_build_object('deal_id', NULL, 'skipped', 'contato_cliente');
    END IF;

    -- Lead perdido ha menos de 7 dias: a conversa que terminou em perdido
    -- continua ("ok, obrigado") e nao vira card. Depois disso, volta como lead.
    IF EXISTS (
      SELECT 1 FROM whatsapp_hub.deals
       WHERE contact_id = p_contact_id AND org_id = v_org AND status = 'lost'
         AND COALESCE(lost_at, updated_at, created_at) > now() - interval '7 days'
    ) THEN
      RETURN jsonb_build_object('deal_id', NULL, 'skipped', 'perdido_recente');
    END IF;

    SELECT id INTO v_pipeline
      FROM whatsapp_hub.pipelines
     WHERE org_id = v_org
       AND kind = 'comercial'
     ORDER BY is_default DESC, position, created_at
     LIMIT 1;

    IF v_pipeline IS NULL THEN
      RETURN jsonb_build_object('deal_id', NULL, 'skipped', 'sem_funil_comercial');
    END IF;

    SELECT id INTO v_stage
      FROM whatsapp_hub.stages
     WHERE pipeline_id = v_pipeline
       AND NOT is_won
       AND NOT is_lost
     ORDER BY position
     LIMIT 1;

    SELECT COALESCE(
             NULLIF(btrim(name), ''),
             NULLIF(btrim(phone), ''),
             CASE WHEN p_provider = 'instagram' THEN 'Lead Instagram' ELSE 'Lead WhatsApp' END
           )
      INTO v_title
      FROM whatsapp_hub.contacts
     WHERE id = p_contact_id;

    INSERT INTO whatsapp_hub.deals (
      org_id, contact_id, pipeline_id, stage_id, title, status,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      attribution_method, origin_channel, traffic_type,
      raw_tracking, tracking_session_id
    ) VALUES (
      v_org, p_contact_id, v_pipeline, v_stage, v_title, 'open',
      v_utm ->> 'utm_source', v_utm ->> 'utm_medium', v_utm ->> 'utm_campaign',
      v_utm ->> 'utm_content', v_utm ->> 'utm_term',
      v_method, v_origin, v_traffic,
      v_raw, v_session_id
    )
    RETURNING id INTO v_deal;
  ELSIF v_signal THEN
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

REVOKE ALL ON FUNCTION whatsapp_hub.attribute_inbound_lead(UUID, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.attribute_inbound_lead(UUID, TEXT, JSONB, TEXT)
  TO service_role;
