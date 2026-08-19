-- Convite por link copiavel.
--
-- 1. handle_new_user decidia "convite pendente" olhando NEW.invited_at, que o
--    GoTrue so preenche DEPOIS do insert quando o convite nasce de
--    generateLink (link copiavel, sem e-mail). O convidado entrava na lista
--    como se já tivesse aceito. Agora quem cai no caso "convite" nasce
--    pendente por definicao, e o aceite continua vindo do trigger
--    on_auth_user_accepted (confirmou e-mail ou entrou pela primeira vez).
--
-- 2. invite_target_state: antes de gerar um link de convite, a Edge Function
--    precisa saber o que existe naquele e-mail. generateLink(type=invite) num
--    e-mail JA cadastrado devolve um link que da sessao naquela conta, o que
--    permitiria a um admin assumir a conta de outra organizacao ou do super
--    admin. Esta funcao e o portao: so 'none' (criar) e 'pending' (recopiar)
--    liberam link.

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

  ELSIF NEW.raw_user_meta_data ? 'invited_role'
        AND (NEW.raw_user_meta_data->>'invited_role') IN ('admin', 'operator')
        AND NULLIF(NEW.raw_user_meta_data->>'invited_org_id', '') IS NOT NULL THEN
    -- Caso 1: convite (por e-mail ou por link). Fica pendente ate o aceite.
    v_role := (NEW.raw_user_meta_data->>'invited_role')::whatsapp_hub.tenant_role;
    v_org  := (NEW.raw_user_meta_data->>'invited_org_id')::uuid;
    v_accepted := CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN now() ELSE NULL END;
    IF NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.organizations
       WHERE id = v_org AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Organização do convite inexistente ou arquivada.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

  ELSE
    -- Caso 2: sem convite válido, recusar self-signup.
    RAISE EXCEPTION 'Self-signup desabilitado. Solicite um convite ao administrador.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO whatsapp_hub.app_users (user_id, org_id, role, is_super_admin, accepted_at)
  VALUES (NEW.id, v_org, v_role, v_super, v_accepted)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'role',           v_role::text,
                                'org_id',         v_org::text,
                                'home_org_id',    v_org::text,
                                'is_super_admin', v_super
                              )
   WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- Estado do e-mail alvo de um convite, na visao da organizacao que convida.
--   none        e-mail livre, pode criar convite
--   pending     convite desta org ainda nao aceito, pode recopiar o link
--   member      ja faz parte desta org (e ja aceitou)
--   other_org   pertence a outra organizacao
--   super_admin conta de super admin
--   orphan      existe no auth mas sem registro em app_users
CREATE OR REPLACE FUNCTION whatsapp_hub.invite_target_state(p_email TEXT, p_org_id UUID)
 RETURNS TEXT
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id  UUID;
  v_org      UUID;
  v_super    BOOLEAN;
  v_accepted TIMESTAMPTZ;
BEGIN
  SELECT id INTO v_user_id FROM auth.users
   WHERE lower(email) = lower(trim(p_email)) LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN 'none';
  END IF;

  SELECT org_id, is_super_admin, accepted_at
    INTO v_org, v_super, v_accepted
    FROM whatsapp_hub.app_users WHERE user_id = v_user_id;
  IF v_org IS NULL THEN
    RETURN 'orphan';
  END IF;
  IF v_super THEN
    RETURN 'super_admin';
  END IF;
  IF v_org <> p_org_id THEN
    RETURN 'other_org';
  END IF;
  IF v_accepted IS NULL THEN
    RETURN 'pending';
  END IF;
  RETURN 'member';
END;
$function$;

-- So a service_role (Edge Function) pode consultar: a resposta revela se um
-- e-mail existe na instancia.
REVOKE ALL ON FUNCTION whatsapp_hub.invite_target_state(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_hub.invite_target_state(TEXT, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.invite_target_state(TEXT, UUID) TO service_role;

-- Quem nunca confirmou o e-mail nem entrou uma vez nao aceitou convite algum:
-- volta para pendente (pega os convites por link criados antes desta correcao).
UPDATE whatsapp_hub.app_users au
   SET accepted_at = NULL
  FROM auth.users u
 WHERE u.id = au.user_id
   AND au.accepted_at IS NOT NULL
   AND au.is_super_admin = false
   AND u.email_confirmed_at IS NULL
   AND u.last_sign_in_at IS NULL;
