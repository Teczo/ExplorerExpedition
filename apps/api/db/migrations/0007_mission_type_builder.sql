-- ---------------------------------------------------------------------------
-- 0007  The Mission Type Builder (EXPD-025)
-- ---------------------------------------------------------------------------
--
-- 0001 gave `mission_type` everything the registry needs (EXPD-009). The
-- Studio's builder decides three more things about a type, and each is a
-- column here:
--
--   1. **`validation_method`.** The `verification` a new mission of this type
--      starts with. The same enum `MissionInstance.verification` uses.
--   2. **`default_scoring`.** The `scoring` a new mission of this type starts
--      with, as an EXPD-002 `MissionScoring` object.
--   3. **`student_layout`.** How the student app draws a mission of this type:
--      the blocks top to bottom, and the words on the submit button.
--
-- The shapes of the two JSON columns are checked by
-- `validateAuthoredMissionType` in `@explorer/shared-types` before the API
-- writes a row. The database checks only that each is an object.
--
-- The defaults are `DEFAULT_MISSION_TYPE_AUTHORING`, so a row written before
-- this migration reads the same as one the builder wrote with nothing chosen.

BEGIN;

ALTER TABLE mission_type
  ADD COLUMN validation_method verification_mode NOT NULL DEFAULT 'teacher',
  ADD COLUMN default_scoring jsonb NOT NULL
    DEFAULT '{"basePoints": 0, "allowPartialCredit": false}'::jsonb,
  ADD COLUMN student_layout jsonb NOT NULL
    DEFAULT '{"blocks": [{"kind": "brief"}, {"kind": "instructions"}, {"kind": "submission"}], "submitLabel": "Submit"}'::jsonb,
  ADD CONSTRAINT mission_type_default_scoring_is_object
    CHECK (jsonb_typeof(default_scoring) = 'object'),
  ADD CONSTRAINT mission_type_student_layout_is_object
    CHECK (jsonb_typeof(student_layout) = 'object');

COMMIT;
