-- Convite so nasce pelo backend.
--
-- O handle_new_user aceitava como "convite" qualquer usuario novo cujo
-- raw_user_meta_data trouxesse invited_role + invited_org_id, conferindo apenas
-- se a organizacao existia. Esse metadata e escrito pelo CLIENTE no cadastro
-- (signUp com options.data) e a anon key e publica, entao quem soubesse o id de
-- uma organizacao nascia como admin dela sem convite nenhum. O id aparece em
-- URL publica de Storage (avatar, midia do agente), logo nao e segredo.
--
-- Agora o convite depende de um registro gravado pelo backend (service role):
--   1. register_pending_invite() grava e-mail + organizacao + papel e devolve
--      um token de uso unico. So o hash do token fica no banco.
--   2. O token viaja no metadata do inviteUserByEmail / generateLink.
--   3. handle_new_user so aceita o usuario novo se houver registro valido para
--      AQUELE e-mail com AQUELE token. Papel e organizacao saem do registro,
--      nunca do metadata.
--
-- Retrocompativel e idempotente: nao mexe em org_id, em policy nem em quem ja
-- existe. Convite pendente criado antes continua valendo, porque o aceite e um
-- UPDATE em auth.users e este gatilho so roda no INSERT.
--
-- Ordem ao atualizar instalacao no ar: publicar as Edge Functions ANTES desta
-- migration. A funcao nova funciona com o banco antigo (segue sem token) e com
-- o novo. A funcao antiga contra o banco novo falha fechado: nenhum convite
-- novo e criado ate a funcao ser publicada.

-- ----------------------------------------------------------------------------
-- 1. Registro de convite pendente
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.pending_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  org_id      UUID NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  role        whatsapp_hub.tenant_role NOT NULL,
  token_hash  TEXT NOT NULL,
  invited_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by UUID
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_open
  ON whatsapp_hub.pending_invites (lower(email))
  WHERE consumed_at IS NULL;

-- RLS ligado e nenhuma policy: anon e authenticated nao enxergam nada. Os
-- default privileges do schema dariam SELECT/INSERT/UPDATE/DELETE a
-- authenticated, por isso o REVOKE explicito.
ALTER TABLE whatsapp_hub.pending_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE whatsapp_hub.pending_invites FROM PUBLIC;
REVOKE ALL ON TABLE whatsapp_hub.pending_invites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE whatsapp_hub.pending_invites TO service_role;

-- ----------------------------------------------------------------------------
-- 2. register_pending_invite: unica porta de entrada de um convite
-- ----------------------------------------------------------------------------
-- Chamada so por codigo de backend, com service role e DEPOIS de conferir que
-- quem pede e admin: a Edge Function invite-team-member e, onde ele existir, o
-- convite do admin inicial no console /admin. Devolve o token em claro uma
-- unica vez; o banco guarda so o sha256 dele.
--
-- O registro vive 15 minutos: o usuario e criado em auth.users na mesma
-- requisicao que registra o convite, entao o registro e consumido em segundos.
-- O link que a pessoa recebe tem validade propria, controlada pelo Supabase Auth.

CREATE OR REPLACE FUNCTION whatsapp_hub.register_pending_invite(
  p_email      TEXT,
  p_org_id     UUID,
  p_role       TEXT,
  p_invited_by UUID DEFAULT NULL
)
 RETURNS TEXT
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT := lower(trim(COALESCE(p_email, '')));
  v_token TEXT;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'E-mail do convite vazio.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'operator') THEN
    RAISE EXCEPTION 'Papel do convite invalido.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM whatsapp_hub.organizations
     WHERE id = p_org_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Organização do convite inexistente ou arquivada.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Convite refeito para o mesmo e-mail invalida o token anterior, e registro
  -- vencido que ninguem usou sai da tabela. Registro usado fica: e o historico
  -- de quem convidou quem.
  DELETE FROM whatsapp_hub.pending_invites
   WHERE consumed_at IS NULL
     AND (lower(email) = v_email OR expires_at < now() - interval '1 day');

  -- 2 UUIDs v4 = 244 bits aleatorios, sem depender de pgcrypto.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  INSERT INTO whatsapp_hub.pending_invites (email, org_id, role, token_hash, invited_by, expires_at)
  VALUES (
    v_email,
    p_org_id,
    p_role::whatsapp_hub.tenant_role,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    p_invited_by,
    now() + interval '15 minutes'
  );

  RETURN v_token;
END;
$function$;

-- Os default privileges do schema dao EXECUTE a authenticated em toda funcao
-- nova. Sem este REVOKE, qualquer usuario logado registraria um convite de
-- admin para o proprio e-mail.
REVOKE ALL ON FUNCTION whatsapp_hub.register_pending_invite(TEXT, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_hub.register_pending_invite(TEXT, UUID, TEXT, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.register_pending_invite(TEXT, UUID, TEXT, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. handle_new_user: convite so com registro do backend
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_count INT;
  v_role       whatsapp_hub.tenant_role;
  v_org        UUID;
  v_super      BOOLEAN := false;
  v_accepted   TIMESTAMPTZ;
  v_token      TEXT;
  v_invite_id  UUID;
BEGIN
  SELECT COUNT(*) INTO v_user_count FROM whatsapp_hub.app_users;

  IF v_user_count = 0 THEN
    -- Caso 0: owner da instância (bootstrap). Admin + super admin na org padrão.
    -- Criado direto com senha, ja confirmado: conta como aceito.
    v_role  := 'admin';
    v_super := true;
    v_accepted := now();
    SELECT id INTO v_org FROM whatsapp_hub.organizations
     WHERE status = 'active' ORDER BY created_at LIMIT 1;
    IF v_org IS NULL THEN
      INSERT INTO whatsapp_hub.organizations (name, slug)
      VALUES ('Organização Principal', 'principal')
      RETURNING id INTO v_org;
    END IF;

  ELSE
    -- Caso 1: convite registrado pelo backend. O metadata so carrega o token;
    -- invited_role e invited_org_id nao sao lidos, porque o cliente os escreve.
    v_token := NULLIF(NEW.raw_user_meta_data->>'invite_token', '');
    IF v_token IS NOT NULL AND NEW.email IS NOT NULL THEN
      SELECT pi.id, pi.role, pi.org_id
        INTO v_invite_id, v_role, v_org
        FROM whatsapp_hub.pending_invites pi
       WHERE lower(pi.email) = lower(NEW.email)
         AND pi.token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
         AND pi.consumed_at IS NULL
         AND pi.expires_at > now()
       ORDER BY pi.created_at DESC
       LIMIT 1
         FOR UPDATE;
    END IF;

    IF v_invite_id IS NULL THEN
      -- Caso 2: sem convite válido, recusar self-signup.
      RAISE EXCEPTION 'Self-signup desabilitado. Solicite um convite ao administrador.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.organizations
       WHERE id = v_org AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Organização do convite inexistente ou arquivada.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Uso unico. Se o GoTrue desfizer a transacao (falha no envio do e-mail),
    -- esta marca volta junto e o generateLink seguinte ainda encontra o registro.
    UPDATE whatsapp_hub.pending_invites
       SET consumed_at = now(), consumed_by = NEW.id
     WHERE id = v_invite_id;

    -- Convite (por e-mail ou por link) fica pendente ate o aceite.
    v_accepted := CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN now() ELSE NULL END;
  END IF;

  INSERT INTO whatsapp_hub.app_users (user_id, org_id, role, is_super_admin, accepted_at)
  VALUES (NEW.id, v_org, v_role, v_super, v_accepted)
  ON CONFLICT (user_id) DO NOTHING;

  -- O token ja foi usado: sai do metadata para nao viajar em todo JWT da pessoa.
  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'role',           v_role::text,
                                'org_id',         v_org::text,
                                'home_org_id',    v_org::text,
                                'is_super_admin', v_super
                              ),
         raw_user_meta_data = CASE
                                WHEN raw_user_meta_data ? 'invite_token'
                                  THEN raw_user_meta_data - 'invite_token'
                                ELSE raw_user_meta_data
                              END
   WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- A Edge Function chama register_pending_invite pelo PostgREST: sem recarregar
-- o cache de schema ela nao enxerga a funcao nova.
NOTIFY pgrst, 'reload schema';
