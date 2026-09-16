-- The role the API signs in as (EXPD-007).
--
-- `0003_append_only_audit_log.sql` says a grant is "something a later
-- deployment ticket (EXPD-007) still has to create". This is it.
--
-- The server administrator created by `main.bicep` owns the schema and can do
-- anything to it. The API is not that: it reads and writes rows in tables that
-- already exist, and nothing else. So there are two logins, and the connection
-- string in Key Vault holds this one.
--
-- Run it once per environment, as the server administrator, against the
-- `explorer` database, after the migrations in `apps/api/db/migrations` have
-- been applied. Running it again is safe, and is how the password is rotated.
--
--   psql "host=<postgresHost> port=5432 dbname=explorer \
--         user=explorer_admin sslmode=require" \
--     -v ON_ERROR_STOP=1 \
--     -v api_password="$API_DATABASE_PASSWORD" \
--     -f infra/sql/application-role.sql
--
-- `ALTER DEFAULT PRIVILEGES` below only covers tables created by the role that
-- runs this file, which is why it has to be the same administrator that
-- applies the migrations.

BEGIN;

-- CREATE ROLE is not a statement plpgsql understands, so it goes through
-- EXECUTE. The check makes a second run an update rather than an error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer_api') THEN
    EXECUTE 'CREATE ROLE explorer_api LOGIN';
  END IF;
END
$$;

ALTER ROLE explorer_api WITH LOGIN PASSWORD :'api_password';

COMMENT ON ROLE explorer_api IS
  'The API signs in as this (EXPD-007). Owns nothing; reads and writes rows in the tables the migrations own.';

-- What it may reach at all.
GRANT CONNECT ON DATABASE explorer TO explorer_api;
GRANT USAGE ON SCHEMA public TO explorer_api;

-- Rows, in tables that already exist.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO explorer_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO explorer_api;

-- And in the tables the next migration adds, so that applying one does not
-- also mean remembering to come back here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO explorer_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO explorer_api;

-- The audit log is append-only (EXPD-006). The triggers in migration 0003
-- already refuse an UPDATE, a DELETE and a TRUNCATE from every caller, the
-- owner included, and they are the rule. This is the belt that goes with them:
-- the API is not even granted the statements the triggers would refuse, so the
-- attempt fails at the permission check rather than inside a trigger.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM explorer_api;

-- `score_event` and `live_event` are written once as well, but holding them to
-- it is EXPD-014, and it should be the same trigger and the same revoke, added
-- together.

COMMIT;
