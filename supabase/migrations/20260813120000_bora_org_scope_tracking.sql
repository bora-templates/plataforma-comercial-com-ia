-- ============================================================================
-- Reconciliação · org_id nas tabelas de tracking desta instalação
-- ----------------------------------------------------------------------------
-- As migrations de multi-tenancy (20260810120000..20260811120000) aplicam
-- org_id + RLS a partir de LISTAS FIXAS de tabelas. Esta instalação tem duas
-- tabelas de tracking que não constam nessas listas:
--
--   · whatsapp_hub.utm_channel_map   (20260718120000) — mapa de aliases UTM,
--     editável na UI e consultado pela trigger _derive_deal_traffic.
--   · whatsapp_hub.tracking_sessions (20260718130000) — sessões de clique,
--     gravadas pela Edge Function redirect-tracker.
--
-- Sem esta migration, o efeito colateral é imediato: 20260810120002 dropa
-- TODAS as policies do schema num loop (pg_policies) e recria apenas as das
-- tabelas conhecidas. As duas acima ficariam com RLS habilitada e ZERO
-- policies, ou seja, inacessíveis — e como _derive_deal_traffic é plpgsql
-- SECURITY INVOKER, a atribuição de origem do lead passaria a falhar em
-- runtime a cada deal criado por usuário autenticado.
--
-- Padrão seguido, idêntico ao das migrations mt_*:
--   · org_id UUID REFERENCES organizations(id) ON DELETE CASCADE
--   · backfill na org ativa mais antiga (default_org_id())
--   · predicado de RLS: org_id = current_org_id() AND current_org_active()
--   · escrita de configuração gated por current_user_role() = 'admin'
--
-- utm_channel_map é configuração: org_id NOT NULL.
-- tracking_sessions é evento de tráfego anônimo (o clique chega antes de
-- existir sessão autenticada): org_id NULLABLE, herdado do utm_links pai via
-- _org_from_parent quando o link é conhecido. Linha sem link continua
-- acessível somente por service role, igual ao tratamento de webhook_events.
-- ============================================================================

SET search_path TO whatsapp_hub;

-- 1. utm_channel_map ---------------------------------------------------------

ALTER TABLE whatsapp_hub.utm_channel_map
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE;

UPDATE whatsapp_hub.utm_channel_map
   SET org_id = whatsapp_hub.default_org_id()
 WHERE org_id IS NULL;

ALTER TABLE whatsapp_hub.utm_channel_map
  ALTER COLUMN org_id SET NOT NULL;

-- O lookup da trigger filtra por org: o índice acompanha.
DROP INDEX IF EXISTS whatsapp_hub.idx_utm_channel_map_lookup;
CREATE INDEX IF NOT EXISTS idx_utm_channel_map_lookup
  ON whatsapp_hub.utm_channel_map (org_id, match_type, match_value, priority DESC);

ALTER TABLE whatsapp_hub.utm_channel_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utm_channel_map_read  ON whatsapp_hub.utm_channel_map;
DROP POLICY IF EXISTS utm_channel_map_write ON whatsapp_hub.utm_channel_map;

-- Leitura: qualquer membro da org (a trigger de atribuição depende disto).
CREATE POLICY utm_channel_map_org_select ON whatsapp_hub.utm_channel_map
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

-- Escrita: admin da org.
CREATE POLICY utm_channel_map_org_write ON whatsapp_hub.utm_channel_map
  FOR ALL TO authenticated
  USING (
    org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

-- Novas linhas criadas na UI herdam a org do usuário quando omitida.
ALTER TABLE whatsapp_hub.utm_channel_map
  ALTER COLUMN org_id SET DEFAULT whatsapp_hub.current_org_id();

-- 2. tracking_sessions -------------------------------------------------------

ALTER TABLE whatsapp_hub.tracking_sessions
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE;

UPDATE whatsapp_hub.tracking_sessions
   SET org_id = whatsapp_hub.default_org_id()
 WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_org
  ON whatsapp_hub.tracking_sessions (org_id);

-- Clique novo herda a org do link de campanha (utm_links já tem org_id NOT
-- NULL desde 20260810120001). Sem link, permanece NULL e só o service role lê.
DROP TRIGGER IF EXISTS trg_tracking_sessions_org ON whatsapp_hub.tracking_sessions;
CREATE TRIGGER trg_tracking_sessions_org
  BEFORE INSERT ON whatsapp_hub.tracking_sessions
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._org_from_parent('utm_links', 'campaign_link_id');

ALTER TABLE whatsapp_hub.tracking_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_sessions_read ON whatsapp_hub.tracking_sessions;

CREATE POLICY tracking_sessions_org_select ON whatsapp_hub.tracking_sessions
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

-- 3. _derive_deal_traffic: isolamento explícito do mapa ----------------------
-- A função é SECURITY INVOKER, então para usuário autenticado a RLS já limita
-- o mapa à org dele. Mas whatsapp-inbound, zernio-webhook e ingest-lead criam
-- deals com service role, que ignora RLS: sem o predicado abaixo, um lead de
-- uma org poderia ser classificado pelo mapa de outra. O filtro é por
-- NEW.org_id (deals ganhou org_id NOT NULL em 20260810120001).
-- Corpo idêntico ao de 20260718120000, exceto o AND m.org_id = NEW.org_id.

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

  SELECT m.traffic_type, m.origin_channel
    INTO hit_traffic, hit_channel
  FROM whatsapp_hub.utm_channel_map m
  WHERE m.org_id = NEW.org_id
    AND (
       (m.match_type = 'source_medium'    AND src IS NOT NULL AND med IS NOT NULL
                                          AND m.match_value = src || '|' || med)
    OR (m.match_type = 'source'           AND src IS NOT NULL AND m.match_value = src)
    OR (m.match_type = 'medium'           AND med IS NOT NULL AND m.match_value = med)
    OR (m.match_type = 'campaign_pattern' AND camp IS NOT NULL AND camp LIKE m.match_value)
    )
  ORDER BY m.priority DESC, m.created_at ASC
  LIMIT 1;

  IF hit_channel IS NOT NULL THEN
    NEW.traffic_type   := hit_traffic;
    NEW.origin_channel := hit_channel;
  ELSIF utm_present THEN
    NEW.traffic_type := CASE
      WHEN med IS NOT NULL AND (med IN ('cpc','ppc','cpm','paid','paid_social','display') OR med LIKE '%paid%')
        THEN 'pago' ELSE 'organico' END;
    NEW.origin_channel := 'outro';
  ELSE
    NEW.traffic_type   := COALESCE(NULLIF(btrim(lower(NEW.traffic_type)), ''), 'manual');
    NEW.origin_channel := COALESCE(NULLIF(btrim(NEW.origin_channel), ''), 'outro');
  END IF;

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

-- 4. Seed do mapa por organização -------------------------------------------
-- O seed de 20260718120000 rodou sem org (linhas foram para a org padrão no
-- backfill acima). Toda org nova precisa nascer com o mesmo mapa, senão o
-- lead dela cai em 'outro'. Espelha o seed original, por org, idempotente.

CREATE OR REPLACE FUNCTION whatsapp_hub.seed_utm_channel_map(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.utm_channel_map
    (org_id, match_type, match_value, traffic_type, origin_channel, priority)
  SELECT p_org, s.match_type, s.match_value, s.traffic_type, s.origin_channel, s.priority
    FROM whatsapp_hub.utm_channel_map s
   WHERE s.org_id = whatsapp_hub.default_org_id()
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_hub.utm_channel_map t
        WHERE t.org_id = p_org
          AND t.match_type = s.match_type
          AND t.match_value = s.match_value
     );
END;
$$;

REVOKE ALL ON FUNCTION whatsapp_hub.seed_utm_channel_map(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_hub.seed_utm_channel_map(UUID) TO service_role;

-- Pendura o seed no gancho oficial de criação de org (api/admin/orgs.ts chama
-- seed_org_defaults). Corpo idêntico ao de 20260810120000, mais a linha do
-- mapa UTM: assim uma org nova nasce classificando lead corretamente.

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
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) TO service_role;

-- 5. Round-robin: uma linha só, a org-aware --------------------------------
-- Esta instalação tem duas implementações paralelas de atribuição automática:
--
--   · 20260721120100 (versão de referência): função _on_handoff_autoassign,
--     trigger on_handoff_autoassign. É a que 20260810120002 reescreve
--     org-aware (filtra q.org_id = NEW.org_id, faz JOIN em app_users da org e
--     exige au.is_online = true).
--   · 20260721130000 (desta instalação): função _on_handoff_assign, trigger
--     on_handoff_assign. Não conhece org_id — zero referências.
--
-- Como os nomes de trigger diferem, as duas disparariam no mesmo UPDATE de
-- conversations: atribuição dupla e, pior, a nossa escolheria operador sem
-- filtrar organização, furando o isolamento que o multi-tenancy acabou de
-- estabelecer. Fica a linha org-aware; a nossa sai de circulação.
--
-- A migration 20260721130000 permanece intocada no histórico (já aplicada).

DROP TRIGGER IF EXISTS on_handoff_assign ON whatsapp_hub.conversations;
DROP FUNCTION IF EXISTS whatsapp_hub._on_handoff_assign();

-- Garante que a trigger org-aware está no ar, apontando para a função que
-- 20260810120002 deixou como versão final. Definição idêntica à de
-- 20260721120100: precisa ser BEFORE, porque a função atribui NEW.assigned_to
-- e NEW.assigned_at (em AFTER a escrita em NEW não teria efeito), e o gate do
-- handoff é feito dentro da própria função, não numa cláusula WHEN.
DROP TRIGGER IF EXISTS on_handoff_autoassign ON whatsapp_hub.conversations;
CREATE TRIGGER on_handoff_autoassign
  BEFORE UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_handoff_autoassign();
