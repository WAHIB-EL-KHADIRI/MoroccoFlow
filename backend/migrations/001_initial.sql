CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moroccoflow_app') THEN
    CREATE ROLE moroccoflow_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE TYPE user_role AS ENUM (
  'owner', 'admin', 'sales', 'project_manager', 'finance', 'hr', 'viewer'
);
CREATE TYPE record_status AS ENUM ('active', 'archived');
CREATE TYPE client_status AS ENUM ('active', 'prospect', 'archived');
CREATE TYPE task_status AS ENUM ('todo', 'doing', 'review', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high');
CREATE TYPE document_status AS ENUM ('draft', 'sent', 'pending', 'paid', 'overdue', 'cancelled');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name varchar(160) NOT NULL,
  legal_name varchar(200),
  ice varchar(15) CHECK (ice IS NULL OR ice ~ '^[0-9]{15}$'),
  rc varchar(80),
  tax_id varchar(80),
  cnss varchar(80),
  address text,
  city varchar(100),
  country char(2) NOT NULL DEFAULT 'MA',
  currency char(3) NOT NULL DEFAULT 'MAD',
  locale varchar(10) NOT NULL DEFAULT 'fr-MA',
  timezone varchar(80) NOT NULL DEFAULT 'Africa/Casablanca',
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email citext NOT NULL,
  password_hash text NOT NULL,
  full_name varchar(160) NOT NULL,
  role user_role NOT NULL DEFAULT 'viewer',
  department varchar(100),
  status record_status NOT NULL DEFAULT 'active',
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_encrypted bytea,
  failed_login_count smallint NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email)
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  user_agent varchar(300),
  ip_hash char(64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email citext NOT NULL,
  full_name varchar(160) NOT NULL,
  role user_role NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_invitations_pending_idx
  ON user_invitations (tenant_id, email) WHERE accepted_at IS NULL;
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  company varchar(200) NOT NULL,
  email citext,
  phone varchar(30),
  city varchar(100),
  ice varchar(15) CHECK (ice IS NULL OR ice ~ '^[0-9]{15}$'),
  status client_status NOT NULL DEFAULT 'prospect',
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  title varchar(200) NOT NULL,
  stage varchar(30) NOT NULL CHECK (stage IN ('contact', 'qualified', 'proposal', 'won', 'lost')),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  probability smallint NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  owner_user_id uuid REFERENCES users(id),
  expected_close_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id),
  name varchar(200) NOT NULL,
  description text,
  status varchar(30) NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'paused', 'done', 'cancelled')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  start_date date,
  due_date date,
  owner_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  title varchar(240) NOT NULL,
  description text,
  status task_status NOT NULL DEFAULT 'todo',
  priority task_priority NOT NULL DEFAULT 'medium',
  assignee_user_id uuid REFERENCES users(id),
  due_date date,
  position numeric(20, 10) NOT NULL DEFAULT 1000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  number varchar(60) NOT NULL,
  issue_date date NOT NULL,
  valid_until date,
  status document_status NOT NULL DEFAULT 'draft',
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents bigint GENERATED ALWAYS AS (subtotal_cents + tax_cents) STORED,
  currency char(3) NOT NULL DEFAULT 'MAD',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, number),
  CHECK (valid_until IS NULL OR valid_until >= issue_date)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  quote_id uuid REFERENCES quotes(id),
  number varchar(60) NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  status document_status NOT NULL DEFAULT 'draft',
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents bigint GENERATED ALWAYS AS (subtotal_cents + tax_cents) STORED,
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'MAD',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, number),
  CHECK (due_date >= issue_date),
  CHECK (paid_cents <= subtotal_cents + tax_cents)
);

CREATE TABLE line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  description varchar(500) NOT NULL,
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  tax_rate_basis_points integer NOT NULL DEFAULT 0 CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  position smallint NOT NULL DEFAULT 0,
  CHECK ((quote_id IS NOT NULL)::integer + (invoice_id IS NOT NULL)::integer = 1)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label varchar(240) NOT NULL,
  category varchar(80) NOT NULL,
  expense_date date NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'MAD',
  receipt_file_id uuid,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key varchar(500) NOT NULL UNIQUE,
  original_name varchar(255) NOT NULL,
  content_type varchar(120) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256 char(64) NOT NULL,
  scan_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE expenses
  ADD CONSTRAINT expenses_receipt_file_fk
  FOREIGN KEY (receipt_file_id) REFERENCES files(id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type varchar(30) NOT NULL CHECK (type IN ('info', 'success', 'warning', 'error')),
  title varchar(240) NOT NULL,
  detail text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  ip_hash char(64),
  user_agent varchar(300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key varchar(120) NOT NULL,
  request_hash char(64) NOT NULL,
  response_status smallint,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX clients_tenant_updated_idx ON clients (tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX deals_tenant_stage_idx ON deals (tenant_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX projects_tenant_updated_idx ON projects (tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_position_idx ON tasks (tenant_id, project_id, status, position) WHERE deleted_at IS NULL;
CREATE INDEX invoices_tenant_due_idx ON invoices (tenant_id, due_date, status) WHERE deleted_at IS NULL;
CREATE INDEX expenses_tenant_date_idx ON expenses (tenant_id, expense_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX notifications_user_unread_idx ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (tenant_id, user_id, expires_at) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION set_record_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER clients_updated BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER deals_updated BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER projects_updated BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER tasks_updated BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER quotes_updated BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();
CREATE TRIGGER expenses_updated BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_record_updated_at();

CREATE OR REPLACE FUNCTION auth_lookup(p_slug citext, p_email citext)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  password_hash text,
  role user_role,
  status record_status,
  failed_login_count smallint,
  locked_until timestamptz,
  mfa_enabled boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.role, u.status,
         u.failed_login_count, u.locked_until, u.mfa_enabled
  FROM public.users u
  JOIN public.tenants t ON t.id = u.tenant_id
  WHERE t.slug = p_slug
    AND u.email = p_email
    AND t.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_lookup(citext, citext) FROM PUBLIC;

CREATE OR REPLACE FUNCTION invitation_lookup(p_token_hash char(64))
RETURNS TABLE (
  invitation_id uuid,
  tenant_id uuid,
  email citext,
  full_name varchar,
  role user_role,
  expires_at timestamptz,
  accepted_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.tenant_id, i.email, i.full_name, i.role, i.expires_at, i.accepted_at
  FROM public.user_invitations i
  JOIN public.tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_token_hash AND t.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION invitation_lookup(char) FROM PUBLIC;
CREATE OR REPLACE FUNCTION refresh_token_lookup(p_token_hash char(64))
RETURNS TABLE (
  token_id uuid,
  user_id uuid,
  tenant_id uuid,
  role user_role,
  expires_at timestamptz,
  revoked_at timestamptz,
  user_status record_status
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT rt.id, rt.user_id, rt.tenant_id, u.role, rt.expires_at,
         rt.revoked_at, u.status
  FROM public.refresh_tokens rt
  JOIN public.users u ON u.id = rt.user_id AND u.tenant_id = rt.tenant_id
  JOIN public.tenants t ON t.id = rt.tenant_id
  WHERE rt.token_hash = p_token_hash
    AND t.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION refresh_token_lookup(char) FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'users', 'refresh_tokens', 'user_invitations', 'clients', 'deals', 'projects',
    'tasks', 'quotes', 'invoices', 'line_items', 'expenses', 'files',
    'notifications', 'audit_logs', 'idempotency_keys'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'tenants' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO moroccoflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, refresh_tokens, user_invitations, clients, deals, projects, tasks, quotes,
  invoices, line_items, expenses, files, notifications, idempotency_keys
TO moroccoflow_app;
GRANT SELECT, INSERT ON audit_logs TO moroccoflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO moroccoflow_app;
GRANT EXECUTE ON FUNCTION auth_lookup(citext, citext) TO moroccoflow_app;
GRANT EXECUTE ON FUNCTION invitation_lookup(char) TO moroccoflow_app;
GRANT EXECUTE ON FUNCTION refresh_token_lookup(char) TO moroccoflow_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM moroccoflow_app;
