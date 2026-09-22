-- ---------------------------------------------------------------------------
-- 0006  Mission attempts and submissions (EXPD-020)
-- ---------------------------------------------------------------------------
--
-- 0001 made `mission_attempt` and `submission`, and EXPD-010 said where the
-- rest would come from:
--
--   "These are mission states, not attempt states. `mission_attempt.status`
--    tracks one try; a team that got a puzzle wrong twice has two attempt
--    rows and one mission state. Writing either is EXPD-020's."
--
-- An attempt row says how one try went. It cannot say where the team stands
-- on the mission as a whole — `locked`, `available`, `awaiting-verification`
-- — and it cannot say it in a way the rules can check. The engine keeps that
-- as a history of named transitions, and replaying the history is how a
-- mission is rebuilt (`replayMissionTransitions`). So the history is stored,
-- line for line, and the mission state is worked out from it on every read.
--
-- Three things, and nothing else:
--
--   1. **`mission_transition`.** Every line of every mission's history for one
--      team, numbered across the team so the order two missions moved in is
--      kept too. Append-only, with the triggers 0003 wrote, for the reason
--      0004 gives for the score stream: the first thing somebody fixing a
--      result by hand would edit is the line saying the mission failed.
--   2. **`hint_request`.** Which hints a team opened. A hint on an expedition
--      with no `hint-penalty` rule costs nothing, so the score stream does not
--      carry it — and a hint opened twice must not be charged twice. Tokens
--      are EXPD-046's; this is only the record of the opening.
--   3. **Three running counts on `team`.** The streak, the longest streak and
--      the wrong answers. EXPD-012 keeps them out of the score stream on
--      purpose, because an answer that cost nothing still breaks a streak, and
--      said they would be "stored beside the total". This is beside it.

BEGIN;

-- ---------------------------------------------------------------------------
-- The history of every mission, for every team
-- ---------------------------------------------------------------------------
--
-- The words are EXPD-010's, value for value: `MissionState`,
-- `MissionTrigger` and `MissionTransitionActor` in
-- `packages/shared-types/src/mission-state/`.

CREATE TYPE mission_state AS ENUM (
  'locked', 'available', 'in-progress', 'submitted',
  'awaiting-verification', 'complete', 'failed', 'skipped'
);

CREATE TYPE mission_trigger AS ENUM (
  'unlock', 'relock', 'start', 'submit', 'accept', 'reject',
  'refer', 'verify', 'overrule', 'expire', 'skip'
);

CREATE TYPE mission_transition_actor AS ENUM ('team', 'engine', 'teacher');

-- No foreign keys, for the reason 0004 gives for `score_event`: a cascade is a
-- DELETE the database runs by itself, and the triggers below would refuse it.
-- `organisation_id` still scopes every read, because the repository layer
-- keys off the column and not off a constraint.
CREATE TABLE mission_transition (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL,
  expedition_session_id  uuid NOT NULL,
  team_id                uuid NOT NULL,
  -- The `MissionInstance.id` from the definition document, which is what the
  -- engine's history names. Text, for the reason 0004 gives.
  mission_instance_key   text NOT NULL CHECK (length(btrim(mission_instance_key)) > 0),
  -- The try this line belongs to, as a row. NULL on an `unlock`, which comes
  -- before any try.
  mission_attempt_id     uuid,
  -- This line's place in the team's history, counting from one, across every
  -- mission. Rebuilding one mission reads its own lines in this order.
  sequence               integer NOT NULL CHECK (sequence > 0),
  from_state             mission_state NOT NULL,
  to_state               mission_state NOT NULL,
  trigger                mission_trigger NOT NULL,
  actor                  mission_transition_actor NOT NULL,
  -- Which try it was, as the engine counts them. Nought before the first.
  attempt_number         integer NOT NULL CHECK (attempt_number >= 0),
  reason                 text,
  detail                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The `at` the engine was given. The history is replayed against it: a
  -- mission's own time limit is measured from the `start` line.
  occurred_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, sequence),
  CONSTRAINT mission_transition_detail_is_object
    CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX mission_transition_team_mission_idx
  ON mission_transition (team_id, mission_instance_key, sequence);
CREATE INDEX mission_transition_session_idx
  ON mission_transition (expedition_session_id);

COMMENT ON TABLE mission_transition IS
  'Append-only history of every mission, for every team (EXPD-020). A mission state is replayed from this; it is never stored.';

CREATE TRIGGER mission_transition_refuse_update
  BEFORE UPDATE ON mission_transition
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER mission_transition_refuse_delete
  BEFORE DELETE ON mission_transition
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER mission_transition_refuse_truncate
  BEFORE TRUNCATE ON mission_transition
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_write_to_append_only_table();

-- ---------------------------------------------------------------------------
-- The hints a team opened
-- ---------------------------------------------------------------------------

CREATE TABLE hint_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL,
  expedition_session_id  uuid NOT NULL,
  team_id                uuid NOT NULL,
  -- Who asked. NULL when it is not known which member did.
  participant_id         uuid,
  -- The document ids, which are what the score stream names a hint by.
  mission_instance_key   text NOT NULL CHECK (length(btrim(mission_instance_key)) > 0),
  hint_key               text NOT NULL CHECK (length(btrim(hint_key)) > 0),
  opened_at              timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- A team opens a hint once. Asking again shows it again and charges nothing.
  UNIQUE (team_id, mission_instance_key, hint_key)
);

CREATE INDEX hint_request_team_idx ON hint_request (team_id);

COMMENT ON TABLE hint_request IS
  'Append-only record of each hint a team opened (EXPD-020). Tokens are EXPD-046; this is only the opening.';

CREATE TRIGGER hint_request_refuse_update
  BEFORE UPDATE ON hint_request
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER hint_request_refuse_delete
  BEFORE DELETE ON hint_request
  FOR EACH ROW EXECUTE FUNCTION refuse_write_to_append_only_table();

CREATE TRIGGER hint_request_refuse_truncate
  BEFORE TRUNCATE ON hint_request
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_write_to_append_only_table();

-- ---------------------------------------------------------------------------
-- The running counts the score stream does not carry
-- ---------------------------------------------------------------------------

ALTER TABLE team
  ADD COLUMN streak integer NOT NULL DEFAULT 0
    CONSTRAINT team_streak_non_negative CHECK (streak >= 0),
  ADD COLUMN longest_streak integer NOT NULL DEFAULT 0
    CONSTRAINT team_longest_streak_non_negative CHECK (longest_streak >= 0),
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT team_failed_attempts_non_negative CHECK (failed_attempts >= 0);

COMMENT ON COLUMN team.streak IS
  'Right answers in a row (EXPD-012). Kept here because a wrong answer that cost nothing is not in score_event and still breaks it.';

COMMIT;
