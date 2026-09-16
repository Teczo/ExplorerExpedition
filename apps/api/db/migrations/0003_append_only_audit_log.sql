-- ---------------------------------------------------------------------------
-- 0003  Append-only audit log (EXPD-006)
-- ---------------------------------------------------------------------------
--
-- 0001 created `audit_log` and called it append-only in a comment. A comment
-- is not a rule: an UPDATE against the table went through, and an audit log
-- that can be edited proves nothing, because the first thing somebody
-- covering their tracks would edit is the record of them doing it.
--
-- This migration makes it a rule the database keeps. After it, the only
-- statement the table accepts is an INSERT. A wrong entry is corrected the
-- way a ledger is corrected: by appending another entry that says so.
--
-- `score_event` and `live_event` are append-only in the same sense and are
-- deliberately left alone here. Holding the score stream to it is EXPD-014.

BEGIN;

-- ---------------------------------------------------------------------------
-- The foreign keys have to go first
-- ---------------------------------------------------------------------------
--
-- 0001 gave three of the columns `ON DELETE SET NULL`. That is an UPDATE
-- against `audit_log`, run by the database itself, so with the rule below in
-- place deleting an organisation, a user or a participant would fail — and
-- blanking the entry is not what anybody wants anyway.
--
-- So they become plain uuids, for the reason `entity_id` already was one:
--
--   "The audit log keeps entity_id as a plain uuid with no foreign key at
--    all, because an entry about something that has been deleted is exactly
--    the entry somebody will want to read."
--
-- Nothing is lost. `actor_label` is in the table precisely so that an entry
-- still names somebody after the account behind it is gone, and
-- `organisation_id` still scopes the read: `TABLE_SCOPES` and the repository
-- layer key off the column, not off a constraint.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_organisation_id_fkey;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_user_id_fkey;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_participant_id_fkey;

COMMENT ON COLUMN audit_log.organisation_id IS
  'Which organisation the action belonged to, or NULL for the platform. No foreign key: an entry outlives the organisation it names.';
COMMENT ON COLUMN audit_log.actor_user_id IS
  'Who did it. No foreign key: the entry outlives the account, which is what actor_label is for.';
COMMENT ON COLUMN audit_log.actor_participant_id IS
  'Which student did it. No foreign key, for the same reason as actor_user_id.';

-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------
--
-- A trigger rather than a grant, because a grant is per role and a role is
-- something a later deployment ticket (EXPD-007) still has to create, while a
-- trigger holds for every caller the moment this file is applied — the owner
-- of the table included.
--
-- The function is written once and named for what it does rather than for the
-- table, so EXPD-014 can point `score_event` at the same one.

CREATE FUNCTION refuse_write_to_append_only_table() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed on it', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'X0006',
          HINT = 'Correct a wrong entry by appending another entry that says so.';
END;
$$;

COMMENT ON FUNCTION refuse_write_to_append_only_table() IS
  'Raises SQLSTATE X0006. Attached to the tables that are written once and never changed (EXPD-006).';

-- Row level for UPDATE and DELETE, statement level for TRUNCATE: PostgreSQL
-- has no FOR EACH ROW truncate trigger, and a TRUNCATE that ran because
-- nobody thought to block it would empty the table without touching a row.

CREATE TRIGGER audit_log_refuse_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER audit_log_refuse_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER audit_log_refuse_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_write_to_append_only_table();

COMMENT ON TABLE audit_log IS
  'Append-only, and the database says so (EXPD-006): only INSERT is accepted. Outlives the rows it describes, so nothing in it has a foreign key.';

COMMIT;
