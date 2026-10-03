-- 002: Users, roles, permissions, project assignments, sessions and row-level security.
-- Requirements: M07-SEC-001, M07-SEC-002, M07-AUD-001, SG-004.
--
-- `app.user_id` carries the acting username for the transaction. Application
-- requests run as role `coni_app` (SET LOCAL ROLE), which is subject to RLS.

-- ---------------------------------------------------------------- identity
CREATE TABLE app_user (
  username        text PRIMARY KEY CHECK (username ~ '^[a-z][a-z0-9._-]{2,40}$'),
  full_name       text NOT NULL,
  email           text,
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  all_projects    boolean NOT NULL DEFAULT false,
  mfa_required    boolean NOT NULL DEFAULT false,
  totp_secret_enc text,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz
);

CREATE TABLE permission (code text PRIMARY KEY, description text NOT NULL, privileged boolean NOT NULL DEFAULT false);
CREATE TABLE role (code text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'PROPUESTA'
  CHECK (status IN ('PROPUESTA', 'APROBADO')));
CREATE TABLE role_permission (role_code text REFERENCES role, permission_code text REFERENCES permission,
  PRIMARY KEY (role_code, permission_code));
CREATE TABLE user_role (username text REFERENCES app_user, role_code text REFERENCES role,
  PRIMARY KEY (username, role_code));
CREATE TABLE user_project (username text REFERENCES app_user, project_id int REFERENCES project,
  PRIMARY KEY (username, project_id));

CREATE TABLE app_session (
  token_hash    bytea PRIMARY KEY,
  username      text NOT NULL REFERENCES app_user,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  mfa_verified  boolean NOT NULL DEFAULT false,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX app_session_user ON app_session (username) WHERE revoked_at IS NULL;

-- Usernames are the audit identity and must never be renamed.
CREATE FUNCTION app_user_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.username <> OLD.username THEN
    RAISE EXCEPTION 'username cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_user_guard BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION app_user_guard();
CREATE TRIGGER app_user_no_delete BEFORE DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION reject_change();

-- ---------------------------------------------------------------- audit redaction
-- Secrets never reach the audit trail.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_rec jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' - 'totp_secret_enc' END;
  new_rec jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' - 'totp_secret_enc' END;
  rec jsonb := coalesce(new_rec, old_rec);
BEGIN
  INSERT INTO audit_event (actor, action, entity_type, entity_id, data, hash)
  VALUES (
    coalesce(nullif(current_setting('app.user_id', true), ''), 'system:' || session_user),
    TG_OP, TG_TABLE_NAME, coalesce(rec->>'id', rec->>'username', rec->>'code'),
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('old', old_rec, 'new', new_rec) ELSE rec END,
    ''::bytea);
  RETURN NULL;
END $$;

CREATE TRIGGER app_user_audit AFTER INSERT OR UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER user_role_audit AFTER INSERT OR DELETE ON user_role FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER user_project_audit AFTER INSERT OR DELETE ON user_project FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER role_permission_audit AFTER INSERT OR DELETE ON role_permission FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER project_audit AFTER INSERT OR UPDATE ON project FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Ledger guards must see every line regardless of the caller's project scope.
ALTER FUNCTION journal_entry_guard() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION journal_line_guard()  SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION audit_event_chain()   SECURITY DEFINER SET search_path = public, pg_temp;

-- ---------------------------------------------------------------- scope helpers
CREATE FUNCTION app_username() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;

CREATE FUNCTION app_has_permission(p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user u
      JOIN user_role ur ON ur.username = u.username
      JOIN role_permission rp ON rp.role_code = ur.role_code
     WHERE u.username = app_username() AND u.status = 'ACTIVE' AND rp.permission_code = p)
$$;

CREATE FUNCTION app_all_projects() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT all_projects FROM app_user WHERE username = app_username() AND status = 'ACTIVE'), false)
$$;

-- NULL project = institutional (non-project) line: visible only with ledger.institutional.
CREATE FUNCTION app_can_see_project(pid int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_all_projects()
      OR (pid IS NULL AND app_has_permission('ledger.institutional'))
      OR (pid IS NOT NULL AND EXISTS (
            SELECT 1 FROM user_project WHERE username = app_username() AND project_id = pid))
$$;

-- ---------------------------------------------------------------- RLS
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON project FOR SELECT TO coni_app USING (app_can_see_project(id));
CREATE POLICY project_admin ON project FOR ALL TO coni_app
  USING (app_has_permission('admin.projects')) WITH CHECK (app_has_permission('admin.projects'));

ALTER TABLE agreement ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_scope ON agreement FOR ALL TO coni_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));

ALTER TABLE journal_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_line_scope ON journal_line FOR ALL TO coni_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));

-- True line count of an entry irrespective of RLS (NULL if the entry does not exist).
CREATE FUNCTION entry_line_count(eid bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM journal_entry WHERE id = eid)
              THEN (SELECT count(*) FROM journal_line WHERE entry_id = eid) END
$$;

-- An entry is visible only if every one of its lines is visible: the header
-- (description, dates, people) of an entry touching another project stays hidden.
CREATE FUNCTION entry_fully_visible(eid bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM journal_line WHERE entry_id = eid AND NOT app_can_see_project(project_id))
$$;

ALTER TABLE journal_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_entry_scope ON journal_entry FOR ALL TO coni_app
  USING (
    app_all_projects()
    OR (entry_fully_visible(id) AND (created_by = app_username() OR entry_line_count(id) > 0)))
  WITH CHECK (true);

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_event FOR SELECT TO coni_app USING (app_has_permission('audit.read'));
CREATE POLICY audit_insert ON audit_event FOR INSERT TO coni_app WITH CHECK (true);

-- Identity: the app role reads non-secret columns only. Credential checks and
-- admin changes go through SECURITY DEFINER functions that enforce permission.
GRANT SELECT (username, full_name, email, status, all_projects, mfa_required,
              must_change_password, created_at, disabled_at) ON app_user TO coni_app;
GRANT SELECT, INSERT, UPDATE ON app_session TO coni_app;
GRANT SELECT ON permission, role, role_permission TO coni_app;
GRANT SELECT, INSERT, DELETE ON user_role, user_project TO coni_app;

ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_role_read ON user_role FOR SELECT TO coni_app USING (true);
CREATE POLICY user_role_admin_ins ON user_role FOR INSERT TO coni_app WITH CHECK (app_has_permission('admin.users'));
CREATE POLICY user_role_admin_del ON user_role FOR DELETE TO coni_app USING (app_has_permission('admin.users'));
ALTER TABLE user_project ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_project_read ON user_project FOR SELECT TO coni_app USING (true);
CREATE POLICY user_project_admin_ins ON user_project FOR INSERT TO coni_app WITH CHECK (app_has_permission('admin.users'));
CREATE POLICY user_project_admin_del ON user_project FOR DELETE TO coni_app USING (app_has_permission('admin.users'));

CREATE FUNCTION auth_get_credentials(u text)
RETURNS TABLE (password_hash text, totp_secret_enc text, status text, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT password_hash, totp_secret_enc, status, locked_until FROM app_user WHERE username = u
$$;

-- Records a login outcome; locks the account after max_attempts consecutive failures.
CREATE FUNCTION auth_record_login(u text, ok boolean, max_attempts int, lock_minutes int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ok THEN
    UPDATE app_user SET failed_attempts = 0, locked_until = NULL
     WHERE username = u AND (failed_attempts > 0 OR locked_until IS NOT NULL);
  ELSE
    UPDATE app_user SET
      failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= max_attempts
                          THEN now() + make_interval(mins => lock_minutes) ELSE locked_until END
     WHERE username = u;
  END IF;
  INSERT INTO audit_event (actor, action, entity_type, entity_id, hash)
  VALUES (u, CASE WHEN ok THEN 'LOGIN_OK' ELSE 'LOGIN_FAILED' END, 'app_user', u, ''::bytea);
END $$;

CREATE FUNCTION require_permission(p text) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT app_has_permission(p) THEN
    RAISE EXCEPTION 'permission % required', p USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE FUNCTION admin_create_user(u text, name text, mail text, pw_hash text, all_proj boolean, mfa boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_permission('admin.users');
  INSERT INTO app_user (username, full_name, email, password_hash, all_projects, mfa_required)
  VALUES (u, name, mail, pw_hash, all_proj, mfa);
END $$;

CREATE FUNCTION admin_set_password(u text, pw_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_permission('admin.users');
  UPDATE app_user SET password_hash = pw_hash, must_change_password = true,
         failed_attempts = 0, locked_until = NULL WHERE username = u;
  UPDATE app_session SET revoked_at = now() WHERE username = u AND revoked_at IS NULL;
END $$;

CREATE FUNCTION admin_disable_user(u text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_permission('admin.users');
  IF u = app_username() THEN
    RAISE EXCEPTION 'administrators cannot disable themselves' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app_user SET status = 'DISABLED', disabled_at = now() WHERE username = u;
  UPDATE app_session SET revoked_at = now() WHERE username = u AND revoked_at IS NULL;
END $$;

-- Self-service, always for the acting user only.
CREATE FUNCTION user_change_password(pw_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE app_user SET password_hash = pw_hash, must_change_password = false WHERE username = app_username();
END $$;

CREATE FUNCTION user_enroll_totp(secret_enc text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE app_user SET totp_secret_enc = secret_enc
   WHERE username = app_username() AND totp_secret_enc IS NULL;
  RETURN FOUND;
END $$;

ALTER FUNCTION audit_verify_chain() SECURITY DEFINER SET search_path = public, pg_temp;

-- ---------------------------------------------------------------- catalogue
INSERT INTO permission (code, description, privileged) VALUES
  ('admin.users',          'Administrar usuarios, roles y asignaciones', true),
  ('admin.projects',       'Administrar proyectos', true),
  ('audit.read',           'Consultar y verificar la bitácora', false),
  ('ledger.read',          'Consultar partidas y reportes', false),
  ('ledger.write',         'Crear y editar partidas en borrador', false),
  ('ledger.approve',       'Aprobar partidas', true),
  ('ledger.post',          'Contabilizar y revertir partidas', true),
  ('ledger.institutional', 'Ver y registrar líneas institucionales (sin proyecto)', false);

-- PROPOSED roles pending CONI's approved role matrix (DEC: matriz de roles).
-- System administration is separated from accounting (separation of duties).
INSERT INTO role (code, name) VALUES
  ('ADMIN_SISTEMA',      'Administrador del sistema'),
  ('CONTADOR',           'Contador'),
  ('GERENTE_FINANCIERO', 'Gerente financiero'),
  ('AUDITOR',            'Auditor'),
  ('CONSULTA',           'Consulta');
INSERT INTO role_permission (role_code, permission_code) VALUES
  ('ADMIN_SISTEMA', 'admin.users'), ('ADMIN_SISTEMA', 'admin.projects'), ('ADMIN_SISTEMA', 'audit.read'),
  ('CONTADOR', 'ledger.read'), ('CONTADOR', 'ledger.write'), ('CONTADOR', 'ledger.post'), ('CONTADOR', 'ledger.institutional'),
  ('GERENTE_FINANCIERO', 'ledger.read'), ('GERENTE_FINANCIERO', 'ledger.approve'), ('GERENTE_FINANCIERO', 'ledger.institutional'),
  ('AUDITOR', 'ledger.read'), ('AUDITOR', 'audit.read'), ('AUDITOR', 'ledger.institutional'),
  ('CONSULTA', 'ledger.read');
