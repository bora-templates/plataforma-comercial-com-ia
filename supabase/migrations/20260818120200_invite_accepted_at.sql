-- Convite pendente de verdade. handle_new_user gravava accepted_at = now()
-- para todo usuario novo, inclusive quem acabou de ser convidado, e a tela de
-- Equipe nunca mostrava "Convite pendente". Agora o convidado nasce sem
-- accepted_at, e o aceite e marcado quando ele confirma o e-mail / entra pela
-- primeira vez (trigger em auth.users).

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
    v_role  := 'admin';
    v_super := true;
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
    -- Caso 1: convite nativo com org + role.
    v_role := (NEW.raw_user_meta_data->>'invited_role')::whatsapp_hub.tenant_role;
    v_org  := (NEW.raw_user_meta_data->>'invited_org_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.organizations
       WHERE id = v_org AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Organização do convite inexistente ou arquivada.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

  ELSE
    -- Caso 2: sem convite válido — recusar self-signup.
    RAISE EXCEPTION 'Self-signup desabilitado. Solicite um convite ao administrador.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Convite (invited_at preenchido pelo GoTrue) fica pendente ate o aceite;
  -- criacao direta (owner do bootstrap, usuario ja confirmado) conta como aceito.
  v_accepted := CASE
    WHEN NEW.invited_at IS NOT NULL AND NEW.email_confirmed_at IS NULL THEN NULL
    ELSE now()
  END;

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

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_user_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.email_confirmed_at IS NOT NULL OR NEW.last_sign_in_at IS NOT NULL) THEN
    UPDATE whatsapp_hub.app_users
       SET accepted_at = COALESCE(accepted_at, now())
     WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_accepted ON auth.users;
CREATE TRIGGER on_auth_user_accepted
  AFTER UPDATE OF email_confirmed_at, last_sign_in_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.handle_user_accepted();

-- Convidados que ainda nao confirmaram voltam a aparecer como pendentes.
UPDATE whatsapp_hub.app_users au
   SET accepted_at = NULL
  FROM auth.users u
 WHERE u.id = au.user_id
   AND u.invited_at IS NOT NULL
   AND u.email_confirmed_at IS NULL
   AND u.last_sign_in_at IS NULL;
