-- ---------------------------------------------------------------------------
-- 0005  Expedition session lifecycle (EXPD-019)
-- ---------------------------------------------------------------------------
--
-- 0001 created `expedition_session` with most of a clock on it — `started_at`,
-- `paused_at`, `paused_seconds_total`, `ended_at` — and left the rules that
-- move them to this ticket, saying so where it declares the table:
--
--   "`status` lists the states a run can be in. Which change may follow
--    which, and what pausing does to the clock, is EXPD-019 and EXPD-058."
--
-- The rules themselves are code, in `apps/api/src/sessions/`. Two things are
-- the database's to keep, and they are all this migration is.
--
--   1. **Time a teacher gave the class on the day.** A run's time limit comes
--      from `rules.timing.totalTimeLimitSeconds` in the revision it is pinned
--      to (EXPD-002), and that document is frozen — a teacher who gives a
--      class ten more minutes because a coach was late cannot be changing it.
--      So the extension is the run's, in a column of its own, and the limit
--      the class plays to is the document's number plus this one.
--
--   2. **A started run has a time it started at.** 0001 already pairs
--      `paused` with `paused_at` and the two finished states with `ended_at`.
--      The same pairing for `started_at` was the one missing corner: without
--      it a row could claim to be `running` with no clock to run, and every
--      elapsed time worked out from it would be a guess.
--
-- Nothing here changes an existing row's meaning, and both additions are safe
-- on a table with rows in it: the column has a default, and the constraint is
-- true of every row a schema without a lifecycle could have produced, because
-- nothing has ever written `running` or `paused` to this table.

BEGIN;

-- ---------------------------------------------------------------------------
-- Time added on the day
-- ---------------------------------------------------------------------------

ALTER TABLE expedition_session
  ADD COLUMN extended_seconds_total integer NOT NULL DEFAULT 0
    CONSTRAINT expedition_session_extended_seconds_non_negative
      CHECK (extended_seconds_total >= 0);

COMMENT ON COLUMN expedition_session.extended_seconds_total IS
  'Seconds added to this run by a teacher (EXPD-019). The limit the class plays to is the pinned revision''s rules.timing.totalTimeLimitSeconds plus this. Never negative: time is given, not taken back.';

-- ---------------------------------------------------------------------------
-- A started run has a start time
-- ---------------------------------------------------------------------------
--
-- Stated as "not in those two states, or there is a time", rather than as an
-- equality, because `ended_at` is the other half of the story: a run that has
-- ended has a `started_at` as well, unless it was cancelled before it was
-- played, and `expedition_session_times_ordered` already holds that pair
-- together.

ALTER TABLE expedition_session
  ADD CONSTRAINT expedition_session_started_has_time
    CHECK (status NOT IN ('running', 'paused') OR started_at IS NOT NULL);

COMMENT ON TABLE expedition_session IS
  'One run of one expedition with one group of students. The revision it plays is pinned, so publishing does not change what a class is in the middle of. Which state may follow which is EXPD-019, in apps/api/src/sessions/.';

COMMIT;
