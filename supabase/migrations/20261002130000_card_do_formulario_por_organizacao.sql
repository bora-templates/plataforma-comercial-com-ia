-- ============================================================================
-- Card do formulario da pagina na organizacao certa
-- ----------------------------------------------------------------------------
-- ingest_landing_lead (20260718150000) cria ou atualiza o card do lead que
-- chega pelo formulario da landing (ingest-lead + public/ah-tracker.js). Ela foi
-- escrita antes das organizacoes e:
--   1. escolhia o primeiro funil "comercial" de qualquer organizacao, pela
--      posicao, sem preferir o funil padrao. Com varias organizacoes, o card de
--      um cliente caia no funil de outro;
--   2. casava o codigo do link de rastreio de qualquer organizacao;
--   3. podia ser chamada por qualquer usuario logado: e SECURITY DEFINER, ignora
--      a RLS, e os default privileges davam EXECUTE para authenticated.
-- Agora tudo acontece dentro da organizacao do contato, com o funil padrao
-- (is_default) antes da posicao, e so o backend chama a funcao.
--
-- O formulario continua criando card novo para quem ja teve card ganho ou
-- perdido: preencher o formulario e um pedido explicito, diferente de uma
-- mensagem solta no WhatsApp (ver 20261002120000).
-- Idempotente: pode rodar de novo em instalacao que ja esta no ar.
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
  v_org        UUID;
  v_session_id UUID;
  v_deal       UUID;
  v_pipeline   UUID;
  v_stage      UUID;
  v_title      TEXT;
  v_code       TEXT := upper(NULLIF(btrim(p_short_code), ''));
  v_utm        JSONB := jsonb_strip_nulls(COALESCE(p_utm, '{}'::jsonb));
BEGIN
  SELECT org_id INTO v_org FROM whatsapp_hub.contacts WHERE id = p_contact_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('deal_id', NULL, 'skipped', 'contato_inexistente');
  END IF;

  -- Mesma trava da mensagem recebida (attribute_inbound_lead): o formulario e
  -- a primeira mensagem do mesmo contato chegando juntos nao criam dois cards.
  PERFORM pg_advisory_xact_lock(hashtext('attribute_inbound_lead'), hashtext(p_contact_id::text));

  IF v_code IS NOT NULL THEN
    SELECT id INTO v_session_id
      FROM whatsapp_hub.tracking_sessions
     WHERE short_code = v_code
       AND org_id = v_org
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  SELECT id INTO v_deal
    FROM whatsapp_hub.deals
   WHERE contact_id = p_contact_id
     AND org_id = v_org
     AND status = 'open'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_deal IS NULL THEN
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

    SELECT COALESCE(NULLIF(btrim(name), ''), NULLIF(btrim(phone), ''), NULLIF(btrim(email), ''), 'Lead')
      INTO v_title
      FROM whatsapp_hub.contacts
     WHERE id = p_contact_id;

    INSERT INTO whatsapp_hub.deals (
      org_id, contact_id, pipeline_id, stage_id, title, status,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      attribution_method, raw_tracking, tracking_session_id
    ) VALUES (
      v_org, p_contact_id, v_pipeline, v_stage, v_title, 'open',
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

REVOKE ALL ON FUNCTION whatsapp_hub.ingest_landing_lead(UUID, JSONB, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.ingest_landing_lead(UUID, JSONB, JSONB, TEXT)
  TO service_role;
