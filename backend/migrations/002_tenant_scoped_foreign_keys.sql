-- Every reference between two tenant-scoped rows now carries tenant_id, so a row of one
-- company can never point at a row of another. RLS alone cannot guarantee this:
-- PostgreSQL runs referential-integrity checks without row security, so a single-column
-- foreign key accepts any existing id, whichever tenant owns it.
--
-- Nothing is deleted or rewritten. If an existing row already crosses tenants the
-- migration stops, lists the offending rows, and leaves the schema untouched.

DO $$
DECLARE
  fk record;
  offenders text;
  report text := '';
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('refresh_tokens', 'user_id', 'users'),
      ('refresh_tokens', 'replaced_by', 'refresh_tokens'),
      ('user_invitations', 'invited_by', 'users'),
      ('clients', 'created_by', 'users'),
      ('deals', 'client_id', 'clients'),
      ('deals', 'owner_user_id', 'users'),
      ('projects', 'client_id', 'clients'),
      ('projects', 'owner_user_id', 'users'),
      ('tasks', 'project_id', 'projects'),
      ('tasks', 'assignee_user_id', 'users'),
      ('quotes', 'client_id', 'clients'),
      ('invoices', 'client_id', 'clients'),
      ('invoices', 'quote_id', 'quotes'),
      ('line_items', 'quote_id', 'quotes'),
      ('line_items', 'invoice_id', 'invoices'),
      ('expenses', 'receipt_file_id', 'files'),
      ('expenses', 'created_by', 'users'),
      ('files', 'uploaded_by', 'users'),
      ('notifications', 'user_id', 'users'),
      ('audit_logs', 'actor_user_id', 'users')
    ) AS t(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT string_agg(c.id::text, '', '') FROM %I c JOIN %I p ON p.id = c.%I
       WHERE p.tenant_id <> c.tenant_id',
      fk.child, fk.parent, fk.col
    ) INTO offenders;
    IF offenders IS NOT NULL THEN
      report := report || format(E'\n  %s.%s -> %s: %s', fk.child, fk.col, fk.parent, offenders);
    END IF;
  END LOOP;

  IF report <> '' THEN
    RAISE EXCEPTION 'Migration 002 stopped, nothing was changed. Cross-tenant references:%', report
      USING HINT = 'Resolve these rows by hand, then run the migration again.';
  END IF;
END
$$;

DO $$
DECLARE
  parent text;
BEGIN
  FOREACH parent IN ARRAY ARRAY[
    'users', 'refresh_tokens', 'clients', 'projects', 'quotes', 'invoices', 'files'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)',
      parent, parent || '_tenant_id_id_key'
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  fk record;
  old_name text;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('refresh_tokens', 'user_id', 'users', 'CASCADE'),
      ('refresh_tokens', 'replaced_by', 'refresh_tokens', 'NO ACTION'),
      ('user_invitations', 'invited_by', 'users', 'NO ACTION'),
      ('clients', 'created_by', 'users', 'NO ACTION'),
      ('deals', 'client_id', 'clients', 'NO ACTION'),
      ('deals', 'owner_user_id', 'users', 'NO ACTION'),
      ('projects', 'client_id', 'clients', 'NO ACTION'),
      ('projects', 'owner_user_id', 'users', 'NO ACTION'),
      ('tasks', 'project_id', 'projects', 'NO ACTION'),
      ('tasks', 'assignee_user_id', 'users', 'NO ACTION'),
      ('quotes', 'client_id', 'clients', 'NO ACTION'),
      ('invoices', 'client_id', 'clients', 'NO ACTION'),
      ('invoices', 'quote_id', 'quotes', 'NO ACTION'),
      ('line_items', 'quote_id', 'quotes', 'CASCADE'),
      ('line_items', 'invoice_id', 'invoices', 'CASCADE'),
      ('expenses', 'receipt_file_id', 'files', 'NO ACTION'),
      ('expenses', 'created_by', 'users', 'NO ACTION'),
      ('files', 'uploaded_by', 'users', 'NO ACTION'),
      ('notifications', 'user_id', 'users', 'CASCADE'),
      -- Only the actor column is cleared; tenant_id is NOT NULL and must survive.
      ('audit_logs', 'actor_user_id', 'users', 'SET NULL (actor_user_id)')
    ) AS t(child, col, parent, on_delete)
  LOOP
    SELECT con.conname INTO old_name
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.conrelid = fk.child::regclass
      AND array_length(con.conkey, 1) = 1
      AND att.attname = fk.col;

    IF old_name IS NULL THEN
      RAISE EXCEPTION 'Migration 002: no single-column foreign key found on %.%', fk.child, fk.col;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.child, old_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I)
       REFERENCES %I (tenant_id, id) ON DELETE %s',
      fk.child, fk.child || '_' || fk.col || '_tenant_fkey', fk.col, fk.parent, fk.on_delete
    );
  END LOOP;
END
$$;
