-- ---------------------------------------------------------------------------
-- 0004  Auditable score and progression event stream (EXPD-014)
-- ---------------------------------------------------------------------------
--
-- 0001 created `score_event` and called it "append-only ... authoritative" in
-- a comment, and 0003 left it alone on purpose, saying so in as many words:
--
--   "`score_event` and `live_event` are append-only in the same sense and are
--    deliberately left alone here. Holding the score stream to it is
--    EXPD-014."
--
-- This is that. After this migration a team's score and progression events
-- are one ordered stream, sealed line by line, that only accepts an INSERT —
-- so a final result can be rebuilt from the record by anybody, and an
-- argument about a total can be answered with the lines rather than with the
-- database's word for it.
--
-- Three things arrive together, because none of them is worth much alone:
--
--   1. **An order.** `stream_sequence` numbers a team's lines from one, with
--      no gaps, across both tables. A stream ordered by a timestamp is not
--      ordered: two events land in the same millisecond, a clock steps
--      backwards, and a queued offline submission (EXPD-048) is stamped an
--      hour before the line that follows it.
--   2. **A seal.** `hash` is SHA-256 over the line's contents and the seal on
--      the line before it, so a line cannot be changed, removed or slipped in
--      without every hash after it disagreeing. `packages/engine/src/stream/`
--      is what works one out, and it is the only thing that does.
--   3. **A rule the database keeps.** The same trigger function 0003 wrote
--      for `audit_log`, which it named for what it does rather than for that
--      table so that this migration could point two more tables at it.
--
-- `live_event` stays out. It is the realtime channel's replay buffer
-- (EXPD-023) rather than a record of what a team earned: a client that
-- dropped a connection catches up from it, and nothing is ever decided by it.

BEGIN;

-- ---------------------------------------------------------------------------
-- Progression events
-- ---------------------------------------------------------------------------
--
-- 0001 has a table for every score change and none for the other half of a
-- result: which missions the team was ever allowed to work on, which they
-- were shown at all, and when they finished. A `ProgressionSnapshot`
-- (EXPD-013) answers that for right now and is worked out from scratch every
-- time, against today's document and today's clock. It cannot answer "the app
-- never showed us mission four", which is the dispute teams actually have.
--
-- The five reasons are `ProgressionEventReason` in
-- `packages/shared-types/src/progression/event.ts`, value for value, and a
-- test in that package holds the two lists together.

CREATE TYPE progression_event_reason AS ENUM (
  'node-reached',
  'node-cleared',
  'mission-unlocked',
  'mission-revealed',
  'expedition-finished'
);

CREATE TABLE progression_event (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL,
  expedition_session_id  uuid NOT NULL,
  team_id                uuid NOT NULL,
  reason                 progression_event_reason NOT NULL,
  -- The `ExpeditionNode.id` from the definition document. Text, because the
  -- node lives inside the document, the same way `scoring_rule_key` does.
  node_key               text,
  -- The `MissionInstance.id` from the document, when it was about a mission.
  -- Text and not the `mission_instance` row's uuid, for the reason under
  -- "A line has to carry its own seal's ingredients" below.
  mission_instance_key   text,
  -- Why, in a sentence a person can read.
  note                   text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- This line's place in its team's stream, counting from one. Shared with
  -- `score_event`: one team has one number line, not two.
  stream_sequence        bigint NOT NULL CHECK (stream_sequence > 0),
  -- The seal on the line before it. Sixty-four noughts for the first line.
  previous_hash          char(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  -- The seal on this line, over its contents and `previous_hash`.
  hash                   char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT progression_event_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  -- The three reasons about a stop always name one, and the two about a
  -- mission always name one. Both together is normal: a mission line also
  -- names the stop that holds it, so a reader can place it on the graph
  -- without the document to hand.
  CONSTRAINT progression_event_node_reason_has_node
    CHECK (reason NOT IN ('node-reached', 'node-cleared') OR node_key IS NOT NULL),
  CONSTRAINT progression_event_mission_reason_has_mission
    CHECK (
      reason NOT IN ('mission-unlocked', 'mission-revealed')
      OR mission_instance_key IS NOT NULL
    )
);

COMMENT ON TABLE progression_event IS
  'Append-only record of every door that opened for a team (EXPD-014). One stream with score_event, ordered by stream_sequence.';
COMMENT ON COLUMN progression_event.stream_sequence IS
  'Place in this team''s stream, from one. Shared with score_event: one team, one number line.';
COMMENT ON COLUMN progression_event.hash IS
  'SHA-256 over this line and previous_hash. Worked out by packages/engine/src/stream/, and by nothing else.';

-- ---------------------------------------------------------------------------
-- A line has to carry its own seal's ingredients
-- ---------------------------------------------------------------------------
--
-- The seal is taken over the `ScoreEvent` the engine minted, and that event
-- names a mission and a hint by the ids the *definition document* uses.
-- `score_event` names both by the uuid of a row in another table. So a reader
-- checking a seal off a stored row would have to join to `mission_instance`
-- and to `hint` to find out what the engine actually sealed — and a line
-- about a mission that has since been deleted could not be checked at all,
-- which is exactly the line somebody will want to check.
--
-- So the two document ids are stored on the line as well, as text, the way
-- `scoring_rule_key` already is and for the word-for-word reason 0001 gives
-- for it: "A string, because the rule lives inside the document." The uuids
-- stay, because a join is still the fast way to draw a report; the keys are
-- what the record is made of.

ALTER TABLE score_event
  ADD COLUMN mission_instance_key text,
  ADD COLUMN hint_key text;

COMMENT ON COLUMN score_event.mission_instance_key IS
  'The MissionInstance.id from the document. What the seal was taken over, and what survives the mission_instance row being deleted.';
COMMENT ON COLUMN score_event.hint_key IS
  'The HintDefinition.id from the document, for the same reason as mission_instance_key.';

-- The key is the record and the uuid is the join, so a line may carry the key
-- alone but never the uuid alone. A caller that knows which row a document id
-- resolves to says so and makes a report one join shorter; a caller that does
-- not — a draft naming a mission no row has yet, a line written before the
-- row was read — still writes a line that can be checked against its own
-- seal, which is the part that matters. A uuid with no key beside it is the
-- one combination that would put a fact in the record the seal never covered.
ALTER TABLE score_event
  ADD CONSTRAINT score_event_mission_uuid_needs_key
    CHECK (mission_instance_id IS NULL OR mission_instance_key IS NOT NULL),
  ADD CONSTRAINT score_event_hint_uuid_needs_key
    CHECK (hint_id IS NULL OR hint_key IS NOT NULL);

-- Two more things a `ScoreEvent` says that 0001 had nowhere to put, and that
-- a line therefore could not carry — so a row read back was not the line that
-- was sealed, and could not be checked against its own seal.
--
-- `attempt_number` is which try the line was about. 0001 has
-- `mission_attempt_id`, which is the row, and the number is not on it.
--
-- `limit_*` is the one that matters most. An award a mission's `maxPoints`
-- cap or the expedition's `minimumTotal` floor cut down is written down as
-- what it actually moved — that is what keeps a stream addable — and the
-- untrimmed figure goes beside it. Without somewhere to put that, the record
-- could say a team was given 10 and could not say they had earned 40 and hit
-- the cap, which is precisely the conversation a cap causes.

CREATE TYPE score_limit_kind AS ENUM ('mission-cap', 'minimum-total');

ALTER TABLE score_event
  ADD COLUMN attempt_number integer CHECK (attempt_number >= 1),
  ADD COLUMN limit_kind score_limit_kind,
  ADD COLUMN limit_would_have_been integer;

ALTER TABLE score_event
  ADD CONSTRAINT score_event_limit_is_whole
    CHECK ((limit_kind IS NULL) = (limit_would_have_been IS NULL));

COMMENT ON COLUMN score_event.limit_kind IS
  'Which limit cut this award down, if one did: the mission cap or the expedition floor.';
COMMENT ON COLUMN score_event.limit_would_have_been IS
  'What the award would have been had the limit not been there. points is what actually moved.';

-- ---------------------------------------------------------------------------
-- The place in the order, and the seal
-- ---------------------------------------------------------------------------
--
-- Nothing writes the table yet — EXPD-020 is what will, once EXPD-016 opens a
-- connection — so the columns can be NOT NULL from the start rather than
-- arriving nullable and being tightened later against rows that have no seal
-- and never could.

ALTER TABLE score_event
  ADD COLUMN stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  ADD COLUMN previous_hash char(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN hash char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN score_event.stream_sequence IS
  'Place in this team''s stream, from one. Shared with progression_event: one team, one number line.';
COMMENT ON COLUMN score_event.hash IS
  'SHA-256 over this line and previous_hash. Worked out by packages/engine/src/stream/, and by nothing else.';

-- One place per team, in each table. The two indexes cannot between them stop
-- a score line and a progression line claiming the same place, because no
-- constraint spans two tables; what stops that is the counter on `team`
-- below, which a writer takes under a row lock before it seals anything. The
-- indexes are the second line of defence, and the one that catches a writer
-- that forgot the lock.
CREATE UNIQUE INDEX score_event_team_stream_sequence_key
  ON score_event (team_id, stream_sequence);
CREATE UNIQUE INDEX progression_event_team_stream_sequence_key
  ON progression_event (team_id, stream_sequence);

-- Reads a team's stream in order, and a session's in order.
CREATE INDEX progression_event_team_sequence_idx
  ON progression_event (team_id, stream_sequence);
CREATE INDEX progression_event_session_occurred_at_idx
  ON progression_event (expedition_session_id, occurred_at);
CREATE INDEX progression_event_mission_key_idx
  ON progression_event (expedition_session_id, mission_instance_key);

-- ---------------------------------------------------------------------------
-- Where the next line's number and seal come from
-- ---------------------------------------------------------------------------
--
-- The head of the chain lives on `team`, beside `total_score`, and for the
-- same reason that column exists: it is a cache of the stream, kept so that
-- nothing has to read the whole stream to write one more line to it. A writer
-- takes `SELECT ... FROM team WHERE id = $1 FOR UPDATE`, reads the two
-- columns, seals the line, inserts it and writes the columns back — all in
-- one transaction, which is what makes the numbering gapless under two phones
-- submitting at once.
--
-- They are a cache and they are checkable: `stream_length` is the number of
-- rows for that team across the two tables, and `stream_head_hash` is the
-- `hash` of the last of them. A cache that disagrees with the stream is a
-- finding, and the stream is what is right.

ALTER TABLE team
  ADD COLUMN stream_length bigint NOT NULL DEFAULT 0
    CHECK (stream_length >= 0),
  ADD COLUMN stream_head_hash char(64)
    CHECK (stream_head_hash ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN team.stream_length IS
  'How many lines this team''s stream holds, and so which number the next one takes. A cache of the stream (EXPD-014), the way total_score is.';
COMMENT ON COLUMN team.stream_head_hash IS
  'The seal on the last line of this team''s stream, which the next one seals against. NULL before the first line.';

-- ---------------------------------------------------------------------------
-- The foreign keys have to go first
-- ---------------------------------------------------------------------------
--
-- 0003 took the same step for `audit_log`, and the reasoning carries over
-- whole. `ON DELETE SET NULL` is an UPDATE run by the database itself and
-- `ON DELETE CASCADE` is a DELETE run by the database itself, and with the
-- rule below in place both would be refused — so deleting an organisation, a
-- session or a team would fail, and blanking a line is not what anybody wants
-- anyway.
--
-- So every reference out of the stream becomes a plain uuid, for the reason
-- `audit_log.entity_id` already was one: a line about something that has been
-- deleted is exactly the line somebody will want to read. A team's result is
-- disputed after the afternoon is over, and sometimes after the session has
-- been tidied away.
--
-- Nothing is lost that the stream needs. `organisation_id` still scopes every
-- read: `TABLE_SCOPES` and the repository layer key off the column, not off a
-- constraint.

ALTER TABLE score_event DROP CONSTRAINT score_event_organisation_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_expedition_session_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_team_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_participant_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_mission_instance_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_mission_attempt_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_submission_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_hint_id_fkey;
ALTER TABLE score_event DROP CONSTRAINT score_event_created_by_fkey;

COMMENT ON COLUMN score_event.organisation_id IS
  'Which organisation the team belonged to. No foreign key: a line outlives the rows it describes (EXPD-014).';
COMMENT ON COLUMN score_event.team_id IS
  'Whose line it is. No foreign key, for the same reason as organisation_id.';

-- `progression_event` was created above with no foreign keys at all, rather
-- than with keys this paragraph would then drop.

-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------
--
-- `refuse_write_to_append_only_table()` is 0003's, written once and named for
-- what it does rather than for `audit_log`, precisely so that this migration
-- could point two more tables at it. Row level for UPDATE and DELETE,
-- statement level for TRUNCATE, for the reason 0003 gives: PostgreSQL has no
-- FOR EACH ROW truncate trigger, and a TRUNCATE nobody thought to block would
-- empty the table without touching a row.

CREATE TRIGGER score_event_refuse_update
  BEFORE UPDATE ON score_event
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER score_event_refuse_delete
  BEFORE DELETE ON score_event
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER score_event_refuse_truncate
  BEFORE TRUNCATE ON score_event
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER progression_event_refuse_update
  BEFORE UPDATE ON progression_event
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER progression_event_refuse_delete
  BEFORE DELETE ON progression_event
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER progression_event_refuse_truncate
  BEFORE TRUNCATE ON progression_event
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_write_to_append_only_table();

COMMENT ON TABLE score_event IS
  'Append-only, and the database says so (EXPD-014): only INSERT is accepted. Authoritative; team.total_score is a cache. Outlives the rows it describes, so nothing in it has a foreign key.';

COMMIT;
