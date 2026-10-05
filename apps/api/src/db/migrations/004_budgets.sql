-- 004: Project budgets, ceilings and overspend control.
-- Requirements: M01-BUD-001 (ceilings per project), M01-BUD-002 (overspend alerts), M01-BUD-003 (executed vs budget).
--
-- Consumption of a budget line = net debits (debit - credit, GTQ) of APPROVED, POSTED and
-- REVERSED entries on that project and account within the budget dates. A reversal
-- (POSTED) cancels its REVERSED original, so corrections release budget.
-- The check runs inside journal_entry_guard when an entry is approved, with the budget
-- lines locked, so concurrent approvals cannot both consume the same remaining amount.

INSERT INTO permission (code, description, privileged) VALUES
  ('budget.manage',  'Preparar presupuestos en borrador', false),
  ('budget.approve', 'Aprobar presupuestos', true);
-- PROPOSED, pending CONI's role matrix (DEC-ROL).
INSERT INTO role_permission (role_code, permission_code) VALUES
  ('CONTADOR', 'budget.manage'),
  ('GERENTE_FINANCIERO', 'budget.approve');

CREATE TABLE budget (
  id           serial PRIMARY KEY,
  project_id   int NOT NULL REFERENCES project,
  name         text NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- BLOCK: approval exceeding the available amount is rejected; WARN: approved with an alert.
  -- Which mode applies is CONI's decision (DEC-PRE); it must be chosen explicitly per budget.
  enforcement  text NOT NULL CHECK (enforcement IN ('BLOCK', 'WARN')),
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'CLOSED')),
  created_by   text NOT NULL,
  approved_by  text,
  approved_at  timestamptz,
  CHECK (end_date >= start_date),
  CHECK (status = 'DRAFT' OR approved_by IS NOT NULL),
  -- At most one approved budget per project for any date.
  EXCLUDE USING gist (project_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status = 'APPROVED')
);

CREATE TABLE budget_line (
  id          serial PRIMARY KEY,
  budget_id   int NOT NULL REFERENCES budget,
  account_id  int NOT NULL REFERENCES account,
  amount      numeric(18,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (budget_id, account_id)
);

CREATE TABLE budget_alert (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  entry_id    bigint NOT NULL REFERENCES journal_entry,
  budget_id   int NOT NULL REFERENCES budget,
  project_id  int NOT NULL REFERENCES project,
  account_id  int NOT NULL REFERENCES account,
  kind        text NOT NULL CHECK (kind IN ('OVERSPEND', 'UNBUDGETED')),
  requested   numeric(18,2) NOT NULL,
  available   numeric(18,2) NOT NULL,
  approved_by text NOT NULL
);
CREATE INDEX budget_alert_entry ON budget_alert (entry_id);

-- Budget rules: only expense accounts that accept postings; approved budgets are frozen
-- (amendments need a revision workflow still to be agreed with CONI, DEC-PRE).
CREATE FUNCTION budget_line_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  st text;
  acc account;
BEGIN
  SELECT status INTO st FROM budget
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.budget_id ELSE NEW.budget_id END FOR SHARE;
  IF st <> 'DRAFT' THEN
    RAISE EXCEPTION 'lines of a % budget cannot be changed', st USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO acc FROM account WHERE id = NEW.account_id;
  IF acc.type <> 'EXPENSE' OR NOT acc.is_postable THEN
    RAISE EXCEPTION 'account % is not a postable expense account', acc.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budget_line_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_line
  FOR EACH ROW EXECUTE FUNCTION budget_line_guard();

CREATE FUNCTION budget_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budgets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'budgets are created as DRAFT' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
      IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.created_by THEN
        RAISE EXCEPTION 'a budget must be approved by someone other than its creator'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM budget_line WHERE budget_id = NEW.id) THEN
        RAISE EXCEPTION 'budget has no lines' USING ERRCODE = 'check_violation';
      END IF;
      NEW.approved_at := now();
    ELSIF OLD.status = 'APPROVED' AND NEW.status = 'CLOSED' THEN
      NULL;
    ELSIF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid budget transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'DRAFT' AND (NEW.project_id, NEW.start_date, NEW.end_date, NEW.enforcement, NEW.name)
         IS DISTINCT FROM (OLD.project_id, OLD.start_date, OLD.end_date, OLD.enforcement, OLD.name) THEN
      RAISE EXCEPTION 'an approved budget is frozen' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budget_guard BEFORE INSERT OR UPDATE OR DELETE ON budget
  FOR EACH ROW EXECUTE FUNCTION budget_guard();

CREATE TRIGGER budget_audit AFTER INSERT OR UPDATE ON budget FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER budget_line_audit AFTER INSERT OR UPDATE OR DELETE ON budget_line FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER budget_alert_audit AFTER INSERT ON budget_alert FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Net consumption on (project, account) within dates, excluding one entry.
CREATE FUNCTION budget_consumed(pid int, aid int, d1 date, d2 date, exclude_entry bigint) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(l.debit_gtq - l.credit_gtq), 0)
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
   WHERE l.project_id = pid AND l.account_id = aid
     AND e.status IN ('APPROVED', 'POSTED', 'REVERSED')
     AND e.entry_date BETWEEN d1 AND d2
     AND e.id <> exclude_entry
$$;

-- Called while approving an entry. Locks the affected budget lines, compares the entry's
-- net debit per (project, account) with what remains, and blocks or records an alert.
CREATE FUNCTION budget_check_entry(eid bigint, edate date, approver text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  b budget;
  bl budget_line;
  avail numeric;
BEGIN
  FOR r IN
    SELECT l.project_id, l.account_id, sum(l.debit_gtq - l.credit_gtq) AS net
      FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.entry_id = eid AND l.project_id IS NOT NULL AND a.type = 'EXPENSE'
     GROUP BY l.project_id, l.account_id
    HAVING sum(l.debit_gtq - l.credit_gtq) > 0
     ORDER BY l.project_id, l.account_id          -- consistent lock order avoids deadlocks
  LOOP
    SELECT * INTO b FROM budget
     WHERE project_id = r.project_id AND status = 'APPROVED' AND edate BETWEEN start_date AND end_date
     FOR UPDATE;                                   -- serializes approvals against this budget
    CONTINUE WHEN NOT FOUND;                       -- project without an approved budget for the date

    SELECT * INTO bl FROM budget_line WHERE budget_id = b.id AND account_id = r.account_id;
    IF NOT FOUND THEN
      avail := 0;                                  -- account not budgeted: nothing available
    ELSE
      avail := bl.amount - budget_consumed(r.project_id, r.account_id, b.start_date, b.end_date, eid);
    END IF;

    IF r.net > avail THEN
      IF b.enforcement = 'BLOCK' THEN
        RAISE EXCEPTION 'presupuesto excedido: proyecto %, cuenta %, solicitado %, disponible %',
          (SELECT code FROM project WHERE id = r.project_id), (SELECT code FROM account WHERE id = r.account_id),
          r.net, greatest(avail, 0)
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO budget_alert (entry_id, budget_id, project_id, account_id, kind, requested, available, approved_by)
      VALUES (eid, b.id, r.project_id, r.account_id,
              CASE WHEN bl.id IS NULL THEN 'UNBUDGETED' ELSE 'OVERSPEND' END, r.net, greatest(avail, 0), approver);
    END IF;
  END LOOP;
END $$;

-- Hook the check into the existing approval transition.
CREATE FUNCTION journal_entry_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
    PERFORM budget_check_entry(NEW.id, NEW.entry_date, NEW.approved_by);
  END IF;
  RETURN NEW;
END $$;
-- Runs after journal_entry_guard (alphabetical order of BEFORE triggers), so the entry is already validated.
CREATE TRIGGER journal_entry_zbudget BEFORE UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_budget();

-- Execution report rows for one budget: budgeted, executed (posted), committed (approved, not posted).
CREATE FUNCTION budget_execution(bid int)
RETURNS TABLE (account_id int, code text, name text, budgeted numeric, executed numeric, committed numeric, available numeric)
LANGUAGE sql STABLE AS $$
  WITH b AS (SELECT * FROM budget WHERE id = bid),
  accts AS (
    SELECT bl.account_id, bl.amount FROM budget_line bl WHERE bl.budget_id = bid
    UNION
    SELECT l.account_id, 0 FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id, b
     WHERE l.project_id = b.project_id AND a.type = 'EXPENSE'
       AND e.status IN ('APPROVED', 'POSTED', 'REVERSED') AND e.entry_date BETWEEN b.start_date AND b.end_date
       AND NOT EXISTS (SELECT 1 FROM budget_line x WHERE x.budget_id = bid AND x.account_id = l.account_id)
  ),
  mov AS (
    SELECT l.account_id,
           sum(CASE WHEN e.status IN ('POSTED', 'REVERSED') THEN l.debit_gtq - l.credit_gtq ELSE 0 END) AS executed,
           sum(CASE WHEN e.status = 'APPROVED' THEN l.debit_gtq - l.credit_gtq ELSE 0 END) AS committed
      FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id, b
     WHERE l.project_id = b.project_id AND e.entry_date BETWEEN b.start_date AND b.end_date
       AND e.status IN ('APPROVED', 'POSTED', 'REVERSED')
     GROUP BY l.account_id
  )
  SELECT a.id, a.code, a.name,
         sum(x.amount)::numeric(18,2),
         coalesce(max(m.executed), 0)::numeric(18,2),
         coalesce(max(m.committed), 0)::numeric(18,2),
         (sum(x.amount) - coalesce(max(m.executed), 0) - coalesce(max(m.committed), 0))::numeric(18,2)
    FROM accts x JOIN account a ON a.id = x.account_id LEFT JOIN mov m ON m.account_id = x.account_id
   GROUP BY a.id, a.code, a.name
   ORDER BY a.code
$$;

-- ---------------------------------------------------------------- acting-user checks
-- For application sessions (role coni_app) the approver/poster recorded must be the
-- acting user and hold the permission, so these fields cannot be spoofed via SQL.
-- Not SECURITY DEFINER on purpose: current_user must be the caller's role.
CREATE FUNCTION acting_user_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'coni_app' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'journal_entry' THEN
    IF TG_OP = 'UPDATE' AND NEW.status = 'APPROVED' AND OLD.status = 'DRAFT'
       AND (NEW.approved_by IS DISTINCT FROM app_username() OR NOT app_has_permission('ledger.approve')) THEN
      RAISE EXCEPTION 'approval must be recorded by an authorized acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status = 'POSTED' AND OLD.status = 'APPROVED'
       AND (NEW.posted_by IS DISTINCT FROM app_username() OR NOT app_has_permission('ledger.post')) THEN
      RAISE EXCEPTION 'posting must be recorded by an authorized acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM app_username() THEN
      RAISE EXCEPTION 'created_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'budget' THEN
    IF TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM app_username() THEN
      RAISE EXCEPTION 'created_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status = 'APPROVED' AND OLD.status = 'DRAFT'
       AND (NEW.approved_by IS DISTINCT FROM app_username() OR NOT app_has_permission('budget.approve')) THEN
      RAISE EXCEPTION 'budget approval must be recorded by an authorized acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_actor BEFORE INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION acting_user_check();
CREATE TRIGGER budget_actor BEFORE INSERT OR UPDATE ON budget
  FOR EACH ROW EXECUTE FUNCTION acting_user_check();

-- ---------------------------------------------------------------- access
ALTER TABLE budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_read ON budget FOR SELECT TO coni_app USING (app_can_see_project(project_id));
CREATE POLICY budget_insert ON budget FOR INSERT TO coni_app
  WITH CHECK (app_has_permission('budget.manage') AND app_can_see_project(project_id));
CREATE POLICY budget_update ON budget FOR UPDATE TO coni_app
  USING (app_can_see_project(project_id) AND (app_has_permission('budget.manage') OR app_has_permission('budget.approve')))
  WITH CHECK (app_can_see_project(project_id));

ALTER TABLE budget_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_line_read ON budget_line FOR SELECT TO coni_app
  USING (EXISTS (SELECT 1 FROM budget b WHERE b.id = budget_id));
CREATE POLICY budget_line_write ON budget_line FOR ALL TO coni_app
  USING (app_has_permission('budget.manage') AND EXISTS (SELECT 1 FROM budget b WHERE b.id = budget_id))
  WITH CHECK (app_has_permission('budget.manage') AND EXISTS (SELECT 1 FROM budget b WHERE b.id = budget_id));

ALTER TABLE budget_alert ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_alert_read ON budget_alert FOR SELECT TO coni_app USING (app_can_see_project(project_id));

GRANT SELECT, INSERT, UPDATE ON budget TO coni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_line TO coni_app;
GRANT SELECT ON budget_alert TO coni_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO coni_app;
