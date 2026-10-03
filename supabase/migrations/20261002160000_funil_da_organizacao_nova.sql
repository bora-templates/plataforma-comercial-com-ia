-- ============================================================================
-- Funil da organização nova (v1, várias organizações)
-- ----------------------------------------------------------------------------
-- O super-admin cria a organização em api/admin/orgs.ts, que chama
-- seed_org_defaults. A função semeava as configurações e o mapa de UTM e não
-- criava funil. A organização nascia sem funil, a mensagem recebida não virava
-- card (attribute_inbound_lead devolve sem_funil_comercial) e a IA não tinha
-- card para mover.
--
-- seed_org_pipelines cria os funis da instalação para a organização que ainda
-- não tem nenhum: "Vendas" (o padrão) e "Pós-venda", com as etapas de
-- 20260630120000_crm_layer.sql, as porcentagens que
-- 20260720120000_stage_probability_defaults.sql calcula para elas e os
-- critérios da IA de 20261002150000_criterios_padrao_da_ia_no_funil.sql (os
-- mesmos textos de src/lib/criterios-padrao.ts). seed_org_defaults passa a
-- chamá-la, e as organizações ativas que já existiam sem funil ganham os funis
-- no fim desta migration. Organização que já tem funil não ganha outro.
--
-- As três funções de semente ficam só para o servidor. seed_utm_channel_map
-- tinha revogado só de PUBLIC, e o default privilege do schema dá EXECUTE a
-- authenticated, então um usuário logado conseguia gravar o mapa de UTM de
-- outra organização.
-- ============================================================================

CREATE OR REPLACE FUNCTION whatsapp_hub.seed_org_pipelines(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_vendas    UUID;
  v_pos_venda UUID;
BEGIN
  -- Uma semente por organização de cada vez, para duas chamadas juntas não
  -- criarem funil em dobro.
  PERFORM pg_advisory_xact_lock(hashtext('seed_org_pipelines:' || p_org::text));

  IF EXISTS (SELECT 1 FROM whatsapp_hub.pipelines WHERE org_id = p_org) THEN
    RETURN;
  END IF;

  INSERT INTO whatsapp_hub.pipelines (org_id, name, kind, position, is_default)
  VALUES (p_org, 'Vendas', 'comercial', 0, true)
  RETURNING id INTO v_vendas;

  INSERT INTO whatsapp_hub.stages
    (org_id, pipeline_id, name, position, is_won, is_lost, probability, ai_criteria)
  VALUES
    (p_org, v_vendas, 'Chegou agora',   0, false, false, 23,  NULL),
    (p_org, v_vendas, 'Em conversa',    1, false, false, 45,
     'O cliente já disse o que precisa ou fez uma pergunta sobre o produto ou o serviço, e ainda não recebeu preço nem proposta. Cumprimento sozinho, como oi ou bom dia, não conta.'),
    (p_org, v_vendas, 'Recebeu oferta', 2, false, false, 68,
     'O atendimento já informou o preço, as condições de pagamento ou enviou a proposta.'),
    (p_org, v_vendas, 'Decidindo',      3, false, false, 90,
     'O cliente já conhece o preço e está decidindo: pediu desconto, perguntou como pagar, disse que vai pensar ou que vai conversar com alguém.'),
    (p_org, v_vendas, 'Fechou',         4, true,  false, 100,
     'O cliente confirmou a compra, mandou o comprovante ou disse que já pagou.'),
    (p_org, v_vendas, 'Não fechou',     5, false, true,  0,
     'O cliente disse com clareza que não quer, que desistiu ou que comprou em outro lugar.');

  INSERT INTO whatsapp_hub.pipelines (org_id, name, kind, position, is_default)
  VALUES (p_org, 'Pós-venda', 'comercial', 1, false)
  RETURNING id INTO v_pos_venda;

  INSERT INTO whatsapp_hub.stages
    (org_id, pipeline_id, name, position, is_won, is_lost, probability)
  VALUES
    (p_org, v_pos_venda, 'Onboarding',     0, false, false, 30),
    (p_org, v_pos_venda, 'Em andamento',   1, false, false, 60),
    (p_org, v_pos_venda, 'Acompanhamento', 2, false, false, 90),
    (p_org, v_pos_venda, 'Concluído',      3, true,  false, 100);
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_org_pipelines(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_org_pipelines(UUID) TO service_role;

-- Corpo idêntico ao de 20260813120000, mais a linha dos funis.
CREATE OR REPLACE FUNCTION whatsapp_hub.seed_org_defaults(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.app_settings (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_settings WHERE org_id = p_org);

  INSERT INTO whatsapp_hub.repurchase_config (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.repurchase_config WHERE org_id = p_org);

  PERFORM whatsapp_hub.seed_utm_channel_map(p_org);
  PERFORM whatsapp_hub.seed_org_pipelines(p_org);
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_utm_channel_map(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_utm_channel_map(UUID) TO service_role;

-- Organizações ativas que já existiam sem funil ganham os funis agora.
DO $$
DECLARE
  v_org UUID;
BEGIN
  FOR v_org IN
    SELECT o.id
      FROM whatsapp_hub.organizations o
     WHERE o.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pipelines p WHERE p.org_id = o.id)
     ORDER BY o.created_at
  LOOP
    PERFORM whatsapp_hub.seed_org_pipelines(v_org);
  END LOOP;
END $$;
