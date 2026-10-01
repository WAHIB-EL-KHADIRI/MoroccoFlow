-- Quote lifecycle, the quote -> project link, and payment obligations.
--
-- Quotes used to share document_status with invoices, an invoice-shaped enum
-- (pending, paid, overdue) that has no way to say "accepted". Quotes get their own
-- lifecycle; invoices keep document_status unchanged. "Expired" is not stored: it is
-- derived from valid_until, like "overdue" is derived from due_date below.

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s (%s)', number, status), ', ') INTO offenders
  FROM quotes WHERE status::text NOT IN ('draft', 'sent', 'cancelled');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 003 stopped, nothing was changed. Quotes with an invoice-only status: %', offenders
      USING HINT = 'Set these quotes to draft, sent or cancelled by hand, then run again.';
  END IF;
END
$$;

CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'cancelled');

ALTER TABLE quotes ALTER COLUMN status DROP DEFAULT;
ALTER TABLE quotes ALTER COLUMN status TYPE quote_status USING status::text::quote_status;
ALTER TABLE quotes ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE quotes
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_by uuid,
  ADD CONSTRAINT quotes_accepted_by_tenant_fkey
    FOREIGN KEY (tenant_id, accepted_by) REFERENCES users (tenant_id, id),
  ADD CONSTRAINT quotes_accepted_has_timestamp
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL));

-- One project per accepted quote: the database, not the handler, is what makes a
-- second acceptance unable to produce a second project.
ALTER TABLE projects
  ADD COLUMN quote_id uuid,
  ADD CONSTRAINT projects_quote_id_tenant_fkey
    FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  ADD CONSTRAINT projects_quote_id_key UNIQUE (tenant_id, quote_id);

CREATE TABLE payment_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  quote_id uuid,
  project_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'MAD',
  due_date date NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- One obligation per accepted quote until payment milestones exist.
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

-- Append-only: a payment is corrected by a later entry, never edited, so the ledger
-- always explains how a balance was reached.
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_on date NOT NULL,
  method varchar(20) NOT NULL DEFAULT 'transfer'
    CHECK (method IN ('transfer', 'cash', 'cheque', 'card', 'other')),
  reference varchar(120),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, obligation_id) REFERENCES payment_obligations (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX payment_obligations_tenant_due_idx ON payment_obligations (tenant_id, due_date);
CREATE INDEX payments_obligation_idx ON payments (tenant_id, obligation_id);

CREATE TRIGGER payment_obligations_updated BEFORE UPDATE ON payment_obligations
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();

-- Balances and status are computed, never stored, so they cannot drift from the
-- ledger. "Today" is the tenant's business date, not the server's.
-- security_invoker makes the view run under the caller's RLS, not the owner's.
CREATE VIEW payment_obligation_balances WITH (security_invoker = true) AS
SELECT
  o.*,
  COALESCE(p.paid_cents, 0)::bigint AS paid_cents,
  (o.amount_cents - COALESCE(p.paid_cents, 0))::bigint AS remaining_cents,
  CASE
    WHEN COALESCE(p.paid_cents, 0) >= o.amount_cents THEN 'paid'
    WHEN o.due_date < (now() AT TIME ZONE t.timezone)::date THEN 'overdue'
    WHEN COALESCE(p.paid_cents, 0) > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS payment_status
FROM payment_obligations o
JOIN tenants t ON t.id = o.tenant_id
LEFT JOIN (
  SELECT tenant_id, obligation_id, sum(amount_cents) AS paid_cents
  FROM payments GROUP BY tenant_id, obligation_id
) p ON p.tenant_id = o.tenant_id AND p.obligation_id = o.id;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payment_obligations', 'payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON payment_obligations TO moroccoflow_app;
GRANT SELECT, INSERT ON payments TO moroccoflow_app;
GRANT SELECT ON payment_obligation_balances TO moroccoflow_app;
