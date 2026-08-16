-- O GoTrue reescreve raw_app_meta_data DEPOIS do on_auth_user_created quando o
-- usuário é criado pela admin API com app_metadata no corpo (que é o que o
-- wizard de bootstrap faz). O org_id que o handle_new_user tinha gravado se
-- perde, e o usuário entra sem enxergar nada: current_org_id() lê do JWT, não
-- da tabela, então toda policy nega.
--
-- Em vez de confiar num único write no momento da criação, app_users passa a
-- ser a fonte da verdade: qualquer inserção ou mudança de org/role/super admin
-- se reflete no metadata. Se o GoTrue sobrescrever, a próxima escrita em
-- app_users reconcilia.

CREATE OR REPLACE FUNCTION whatsapp_hub.sync_user_app_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'whatsapp_hub', 'pg_temp'
AS $$
BEGIN
  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'role',           NEW.role::text,
                                'org_id',         NEW.org_id::text,
                                'home_org_id',    NEW.org_id::text,
                                'is_super_admin', COALESCE(NEW.is_super_admin, false)
                              )
   WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_users_sync_metadata ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_sync_metadata
  AFTER INSERT OR UPDATE OF org_id, role, is_super_admin ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.sync_user_app_metadata();

-- Reconcilia quem já existe (o owner criado antes desta migration).
UPDATE auth.users u
   SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object(
                              'role',           a.role::text,
                              'org_id',         a.org_id::text,
                              'home_org_id',    a.org_id::text,
                              'is_super_admin', COALESCE(a.is_super_admin, false)
                            )
  FROM whatsapp_hub.app_users a
 WHERE a.user_id = u.id;
