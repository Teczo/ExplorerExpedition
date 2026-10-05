-- ---------------------------------------------------------------------------
-- 0013  The timed challenge mission type (EXPD-036)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `timed-challenge` at 1.0.0, with no
-- organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- The code that judges a challenge is
-- `apps/api/src/mission-types/platform/timed-challenge.ts`, and the API plays
-- with it. This row is what the Studio lists and what an expedition's
-- missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/timed-challenge-row.test.ts` reads each JSON
-- value below between its dollar-quote tags and compares it with the code.
-- Change one and that test fails until the other matches.
--
-- It asks the phone for nothing (`capabilities` is empty): the clock is the
-- server's, from the team opening the mission to their hand-in reaching it.
--
-- `default_scoring` turns partial credit on, because how long the team took
-- is paid as a share of the base points, and a share is paid only then.
--
-- A published type is never edited (0001). A change to the timed challenge
-- is a new row at the next version, in a new migration.

BEGIN;

INSERT INTO mission_type (
  organisation_id,
  type_key,
  version,
  name,
  description,
  status,
  capabilities,
  config_schema,
  submission_schema,
  default_config,
  validation_method,
  default_scoring,
  student_layout
) VALUES (
  NULL,
  'timed-challenge',
  '1.0.0',
  'Timed challenge',
  'Teams race the clock to finish a task. The faster they finish, the more points they earn.',
  'published',
  ARRAY[]::text[],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "steps": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" }
      },
      "fullPointsWithinSeconds": { "type": "integer", "minimum": 1 },
      "pointsRunOutAtSeconds": { "type": "integer", "minimum": 1 },
      "minimumShare": { "type": "number", "minimum": 0, "maximum": 1 },
      "finishCode": { "type": "string", "minLength": 1, "maxLength": 40, "pattern": "\\s*\\S[\\s\\S]*" }
    },
    "required": ["steps", "fullPointsWithinSeconds", "pointsRunOutAtSeconds"]
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "done": { "type": "boolean", "const": true },
      "code": { "type": "string", "maxLength": 40 }
    },
    "required": ["done"]
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "steps": ["Say what the team has to do before the clock stops."],
    "fullPointsWithinSeconds": 60,
    "pointsRunOutAtSeconds": 180,
    "minimumShare": 0
  }
  $default_config$::jsonb,
  'automatic',
  $default_scoring$
  { "basePoints": 100, "allowPartialCredit": true }
  $default_scoring$::jsonb,
  $student_layout$
  {
    "blocks": [
      { "kind": "brief" },
      { "kind": "instructions" },
      { "kind": "media" },
      { "kind": "config-field", "field": "steps", "heading": "What to do" },
      { "kind": "config-field", "field": "fullPointsWithinSeconds", "heading": "Full points inside (seconds)" },
      { "kind": "timer" },
      { "kind": "hints" },
      { "kind": "submission" }
    ],
    "submitLabel": "Stop the clock"
  }
  $student_layout$::jsonb
);

COMMIT;
