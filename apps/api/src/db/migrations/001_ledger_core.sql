-- 001: Ledger core, dimensions and append-only audit trail.
-- Requirements: M01-ACC-001, M01-ACC-003, M01-CUR-001, M07-AUD-001, SG-001, SG-002.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Application role: ordinary app connections use this role (see docs/05-permisos.md).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coni_app') THEN
    CREATE ROLE coni_app NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_event (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor        text NOT NULL,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  data         jsonb,
  prev_hash    bytea,
  hash         bytea NOT NULL
);

CREATE FUNCTION audit_event_canonical(e audit_event) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(
    e.id::text || '|' ||
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    e.actor || '|' || e.action || '|' || e.entity_type || '|' ||
    coalesce(e.entity_id, '') || '|' || coalesce(e.data::text, ''),
    'UTF8')
$$;

CREATE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize writers so each row links to its true predecessor.
  PERFORM pg_advisory_xact_lock(hashtext('audit_event_chain'));
  SELECT hash INTO NEW.prev_hash FROM audit_event ORDER BY id DESC LIMIT 1;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := digest(coalesce(NEW.prev_hash, ''::bytea) || audit_event_canonical(NEW), 'sha256');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_chain();

CREATE FUNCTION reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Returns the id of the first row whose hash does not verify, or NULL if intact.
CREATE FUNCTION audit_verify_chain() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_event;
  prev bytea := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_event ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM prev
       OR r.hash <> digest(coalesce(prev, ''::bytea) || audit_event_canonical(r), 'sha256') THEN
      RETURN r.id;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Generic row audit: records who (app.user_id) did what to which row.
CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  INSERT INTO audit_event (actor, action, entity_type, entity_id, data, hash)
  VALUES (
    coalesce(nullif(current_setting('app.user_id', true), ''), 'system:' || current_user),
    TG_OP, TG_TABLE_NAME, rec->>'id',
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('old', to_jsonb(OLD), 'new', rec) ELSE rec END,
    ''::bytea);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- reference data
CREATE TABLE currency (
  code      char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name      text NOT NULL,
  is_functional boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX currency_one_functional ON currency (is_functional) WHERE is_functional;

CREATE TABLE exchange_rate (
  id            bigserial PRIMARY KEY,
  currency_code char(3) NOT NULL REFERENCES currency,
  rate_date     date NOT NULL,
  rate          numeric(18,6) NOT NULL CHECK (rate > 0),
  source        text NOT NULL CHECK (source IN ('BANGUAT', 'MANUAL')),
  justification text,
  approved_by   text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency_code, rate_date, source),
  CHECK (source <> 'MANUAL' OR (justification IS NOT NULL AND approved_by IS NOT NULL))
);

CREATE TABLE fiscal_period (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  CHECK (end_date >= start_date),
  EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);

CREATE TABLE account (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  parent_id   int REFERENCES account,
  is_postable boolean NOT NULL DEFAULT true,
  requires_project boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true
);

-- Reporting dimensions (M01-ACC-001). Minimal now; extended by M05.
CREATE TABLE project   (id serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE fund      (id serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE donor     (id serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE agreement (id serial PRIMARY KEY, code text NOT NULL UNIQUE, donor_id int NOT NULL REFERENCES donor, project_id int REFERENCES project);

-- ---------------------------------------------------------------- journal
CREATE TABLE journal_entry (
  id             bigserial PRIMARY KEY,
  entry_date     date NOT NULL,
  period_id      int NOT NULL REFERENCES fiscal_period,
  description    text NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED')),
  source_type    text NOT NULL DEFAULT 'MANUAL',
  source_id      text,
  source_purpose text NOT NULL DEFAULT 'MAIN',
  reverses_entry_id bigint UNIQUE REFERENCES journal_entry,
  created_by     text NOT NULL,
  approved_by    text,
  posted_by      text,
  posted_at      timestamptz,
  -- SG-002: one posting per source document and purpose.
  UNIQUE (source_type, source_id, source_purpose)
);

CREATE TABLE journal_line (
  id            bigserial PRIMARY KEY,
  entry_id      bigint NOT NULL REFERENCES journal_entry,
  line_no       int NOT NULL,
  account_id    int NOT NULL REFERENCES account,
  currency_code char(3) NOT NULL REFERENCES currency,
  debit_tx      numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit_tx >= 0),
  credit_tx     numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_tx >= 0),
  rate          numeric(18,6) NOT NULL CHECK (rate > 0),
  rate_source   text NOT NULL CHECK (rate_source IN ('FUNCTIONAL', 'BANGUAT', 'MANUAL')),
  rate_date     date NOT NULL,
  debit_gtq     numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit_gtq >= 0),
  credit_gtq    numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_gtq >= 0),
  project_id    int REFERENCES project,
  fund_id       int REFERENCES fund,
  donor_id      int REFERENCES donor,
  agreement_id  int REFERENCES agreement,
  memo          text,
  UNIQUE (entry_id, line_no),
  -- exactly one side per line, consistent between currencies
  CHECK ((debit_tx > 0 AND credit_tx = 0 AND credit_gtq = 0)
      OR (credit_tx > 0 AND debit_tx = 0 AND debit_gtq = 0))
);
CREATE INDEX journal_line_entry ON journal_line (entry_id);
CREATE INDEX journal_line_account ON journal_line (account_id);
CREATE INDEX journal_line_project ON journal_line (project_id);

-- Line rules: editable only while the entry is DRAFT; account must be postable;
-- functional-currency lines carry rate 1 and identical amounts.
CREATE FUNCTION journal_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  acc account;
  functional boolean;
BEGIN
  SELECT status INTO st FROM journal_entry
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END
   FOR SHARE;  -- blocks a concurrent approve/post until this line change commits
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'journal lines of a % entry cannot be changed', st
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.entry_id <> OLD.entry_id THEN
    RAISE EXCEPTION 'journal line cannot move between entries' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  SELECT * INTO acc FROM account WHERE id = NEW.account_id;
  IF NOT acc.is_postable OR NOT acc.active THEN
    RAISE EXCEPTION 'account % is not postable', acc.code USING ERRCODE = 'check_violation';
  END IF;
  IF acc.requires_project AND NEW.project_id IS NULL THEN
    RAISE EXCEPTION 'account % requires a project', acc.code USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_functional INTO functional FROM currency WHERE code = NEW.currency_code;
  IF functional AND (NEW.rate <> 1 OR NEW.rate_source <> 'FUNCTIONAL'
                     OR NEW.debit_gtq <> NEW.debit_tx OR NEW.credit_gtq <> NEW.credit_tx) THEN
    RAISE EXCEPTION 'functional-currency line must use rate 1 and equal amounts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT functional AND NEW.rate_source = 'FUNCTIONAL' THEN
    RAISE EXCEPTION 'foreign-currency line needs a BANGUAT or MANUAL rate'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_line_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_guard();

-- Entry state machine and posting invariants.
CREATE FUNCTION journal_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p fiscal_period;
  n int;
  unbalanced_gtq numeric;
  unbalanced_ccy text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only DRAFT entries can be deleted' USING ERRCODE = 'check_violation';
    END IF;
    DELETE FROM journal_line WHERE entry_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'entries must be created as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- Posted/reversed entries are immutable except POSTED -> REVERSED.
    IF OLD.status IN ('POSTED', 'REVERSED') THEN
      IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
              AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')) THEN
        RAISE EXCEPTION 'a % entry is immutable; correct it with a reversal', OLD.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT ((OLD.status = 'DRAFT'    AND NEW.status IN ('DRAFT', 'APPROVED'))
         OR (OLD.status = 'APPROVED' AND NEW.status IN ('DRAFT', 'POSTED'))) THEN
      RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT * INTO p FROM fiscal_period WHERE id = NEW.period_id;
  IF NEW.entry_date NOT BETWEEN p.start_date AND p.end_date THEN
    RAISE EXCEPTION 'entry date % is outside period %', NEW.entry_date, p.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF p.status = 'CLOSED' THEN
    RAISE EXCEPTION 'period % is closed', p.code USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('APPROVED', 'POSTED') THEN
    SELECT count(*), sum(debit_gtq) - sum(credit_gtq)
      INTO n, unbalanced_gtq FROM journal_line WHERE entry_id = NEW.id;
    IF n < 2 THEN
      RAISE EXCEPTION 'entry needs at least two lines' USING ERRCODE = 'check_violation';
    END IF;
    IF unbalanced_gtq <> 0 THEN
      RAISE EXCEPTION 'entry is unbalanced in GTQ by %', unbalanced_gtq
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT string_agg(currency_code, ',') INTO unbalanced_ccy FROM (
      SELECT currency_code FROM journal_line WHERE entry_id = NEW.id
       GROUP BY currency_code HAVING sum(debit_tx) <> sum(credit_tx)) u;
    -- Single-currency entries must also balance in transaction currency.
    -- Mixed-currency entries (e.g. a USD bank vs GTQ expense) balance in GTQ only.
    IF unbalanced_ccy IS NOT NULL
       AND (SELECT count(DISTINCT currency_code) FROM journal_line WHERE entry_id = NEW.id) = 1 THEN
      RAISE EXCEPTION 'entry is unbalanced in %', unbalanced_ccy USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'APPROVED' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'approved_by is required' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'APPROVED' AND NEW.approved_by = NEW.created_by THEN
    RAISE EXCEPTION 'creator cannot approve own entry' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'POSTED' THEN
    IF NEW.posted_by IS NULL THEN
      RAISE EXCEPTION 'posted_by is required' USING ERRCODE = 'check_violation';
    END IF;
    NEW.posted_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_guard();

CREATE TRIGGER journal_entry_audit AFTER INSERT OR UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER journal_line_audit AFTER INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER fiscal_period_audit AFTER INSERT OR UPDATE OR DELETE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER exchange_rate_audit AFTER INSERT OR UPDATE OR DELETE ON exchange_rate
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER account_audit AFTER INSERT OR UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------- grants
GRANT USAGE ON SCHEMA public TO coni_app;
GRANT SELECT, INSERT ON audit_event TO coni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  journal_entry, journal_line, fiscal_period, exchange_rate, account,
  currency, project, fund, donor, agreement TO coni_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO coni_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM coni_app;
