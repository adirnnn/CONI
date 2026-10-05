-- 003: Chart-of-accounts governance, period close/reopen, exchange-rate provenance, settings.
-- Requirements: M01-COA-001, M01-ACC-003, M01-CUR-001, M01-CUR-002.

INSERT INTO permission (code, description, privileged) VALUES
  ('accounting.config', 'Mantener catálogo de cuentas y periodos', true),
  ('period.close',      'Cerrar y reabrir periodos contables', true),
  ('rates.manual',      'Registrar tipos de cambio manuales autorizados', true);

-- PROPOSED assignment, pending CONI's role matrix (DEC-ROL).
INSERT INTO role_permission (role_code, permission_code) VALUES
  ('CONTADOR', 'accounting.config'),
  ('GERENTE_FINANCIERO', 'period.close'),
  ('GERENTE_FINANCIERO', 'rates.manual');

-- ---------------------------------------------------------------- settings
-- Values with status PROPUESTA are engineering placeholders awaiting approval.
CREATE TABLE app_setting (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  status      text NOT NULL DEFAULT 'PROPUESTA' CHECK (status IN ('PROPUESTA', 'APROBADO')),
  description text NOT NULL,
  approved_by text,
  CHECK (status <> 'APROBADO' OR approved_by IS NOT NULL)
);
INSERT INTO app_setting (key, value, description) VALUES
  ('money.rounding', 'HALF_UP', 'Redondeo de conversión a GTQ (HALF_UP | HALF_EVEN). Pendiente del contador (SUP-008).');
CREATE TRIGGER app_setting_audit AFTER INSERT OR UPDATE ON app_setting FOR EACH ROW EXECUTE FUNCTION audit_row();
GRANT SELECT ON app_setting TO coni_app;

-- ---------------------------------------------------------------- accounts
CREATE FUNCTION account_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parent account;
  used boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted; deactivate them' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO parent FROM account WHERE id = NEW.parent_id;
    IF parent.is_postable THEN
      RAISE EXCEPTION 'parent account % is postable; only header accounts can have children', parent.code
        USING ERRCODE = 'check_violation';
    END IF;
    IF parent.type <> NEW.type THEN
      RAISE EXCEPTION 'account type must match parent (%)', parent.type USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.code NOT LIKE parent.code || '%' THEN
      RAISE EXCEPTION 'account code must start with parent code %', parent.code USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    used := EXISTS (SELECT 1 FROM journal_line WHERE account_id = OLD.id);
    IF used AND (NEW.code <> OLD.code OR NEW.type <> OLD.type OR NEW.is_postable <> OLD.is_postable
                 OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
      RAISE EXCEPTION 'account % has movements: code, type, parent and postability are fixed', OLD.code
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.is_postable AND NOT OLD.is_postable AND EXISTS (SELECT 1 FROM account WHERE parent_id = OLD.id) THEN
      RAISE EXCEPTION 'account % has children and cannot become postable', OLD.code USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_guard BEFORE INSERT OR UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION account_guard();

ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_read ON account FOR SELECT TO coni_app USING (true);
CREATE POLICY account_insert ON account FOR INSERT TO coni_app WITH CHECK (app_has_permission('accounting.config'));
CREATE POLICY account_update ON account FOR UPDATE TO coni_app
  USING (app_has_permission('accounting.config')) WITH CHECK (app_has_permission('accounting.config'));

-- ---------------------------------------------------------------- periods
ALTER TABLE fiscal_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY period_read ON fiscal_period FOR SELECT TO coni_app USING (true);
CREATE POLICY period_insert ON fiscal_period FOR INSERT TO coni_app
  WITH CHECK (app_has_permission('accounting.config') AND status = 'OPEN');
-- No UPDATE policy: status changes only through period_set_status().

-- Closing requires no pending (DRAFT/APPROVED) entries. Reopening requires a reason.
-- Both are recorded in the audit trail with the reason.
CREATE FUNCTION period_set_status(pid int, new_status text, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p fiscal_period;
  pending int;
BEGIN
  PERFORM require_permission('period.close');
  SELECT * INTO p FROM fiscal_period WHERE id = pid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'period not found' USING ERRCODE = 'no_data_found'; END IF;
  IF p.status = new_status THEN
    RAISE EXCEPTION 'period % is already %', p.code, new_status USING ERRCODE = 'check_violation';
  END IF;
  IF new_status = 'CLOSED' THEN
    SELECT count(*) INTO pending FROM journal_entry WHERE period_id = pid AND status IN ('DRAFT', 'APPROVED');
    IF pending > 0 THEN
      RAISE EXCEPTION 'period % has % pending entries (draft or approved)', p.code, pending
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF new_status = 'OPEN' THEN
    IF reason IS NULL OR length(trim(reason)) < 10 THEN
      RAISE EXCEPTION 'reopening a period requires a reason (10+ characters)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid status %', new_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE fiscal_period SET status = new_status WHERE id = pid;
  INSERT INTO audit_event (actor, action, entity_type, entity_id, data, hash)
  VALUES (app_username(), 'PERIOD_' || new_status, 'fiscal_period', pid::text,
          jsonb_build_object('code', p.code, 'reason', reason), ''::bytea);
END $$;

-- ---------------------------------------------------------------- exchange rates
ALTER TABLE exchange_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_read ON exchange_rate FOR SELECT TO coni_app USING (true);
-- No write policies for the app role: BANGUAT rates come from the scheduled job
-- (database owner); manual rates only through rate_set_manual().

ALTER TABLE currency ADD COLUMN banguat_code int UNIQUE;
ALTER TABLE currency ADD COLUMN enabled boolean NOT NULL DEFAULT true;
-- Verified 2026-10-04 against VariablesDisponibles: 2 = "Dólares de EE.UU.", quoted in GTQ.
-- Other currencies are NOT mapped: some are quoted against USD (e.g. code 24 ≈ 1.13), see docs/08.
INSERT INTO currency (code, name, is_functional, banguat_code) VALUES
  ('GTQ', 'Quetzal', true, NULL),
  ('USD', 'Dólar de EE.UU.', false, 2)
ON CONFLICT (code) DO UPDATE SET banguat_code = EXCLUDED.banguat_code;

CREATE FUNCTION rate_set_manual(ccy char(3), d date, r numeric, justification text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_permission('rates.manual');
  IF justification IS NULL OR length(trim(justification)) < 10 THEN
    RAISE EXCEPTION 'a manual rate requires a justification (10+ characters)' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO exchange_rate (currency_code, rate_date, rate, source, justification, approved_by)
  VALUES (ccy, d, r, 'MANUAL', justification, app_username());
END $$;

-- Rate applicable on a date: the official BANGUAT rate; otherwise an authorized
-- manual rate for that exact date; otherwise nothing (posting must be blocked).
CREATE FUNCTION rate_for(ccy char(3), d date)
RETURNS TABLE (rate numeric, source text, rate_date date)
LANGUAGE sql STABLE AS $$
  SELECT rate, source, rate_date FROM exchange_rate
   WHERE currency_code = ccy AND rate_date = d
   ORDER BY CASE source WHEN 'BANGUAT' THEN 0 ELSE 1 END
   LIMIT 1
$$;

-- Foreign-currency lines must cite a stored rate exactly.
CREATE FUNCTION journal_line_rate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.rate_source IN ('BANGUAT', 'MANUAL') AND NOT EXISTS (
       SELECT 1 FROM exchange_rate
        WHERE currency_code = NEW.currency_code AND rate_date = NEW.rate_date
          AND source = NEW.rate_source AND rate = NEW.rate) THEN
    RAISE EXCEPTION 'no % rate % for % on %', NEW.rate_source, NEW.rate, NEW.currency_code, NEW.rate_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_rate_guard BEFORE INSERT OR UPDATE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_rate_guard();

-- Record of each synchronization run (idempotent upserts; evidence for audits).
CREATE TABLE rate_sync_run (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  currency_code char(3) NOT NULL,
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  inserted    int NOT NULL DEFAULT 0,
  unchanged   int NOT NULL DEFAULT 0,
  conflicts   int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'ERROR')),
  error       text
);
GRANT SELECT ON rate_sync_run TO coni_app;
