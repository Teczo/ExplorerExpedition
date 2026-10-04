-- ---------------------------------------------------------------------------
-- 0011  The physical challenge mission type (EXPD-034)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `physical-challenge` at 1.0.0, with no
-- organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- The code that judges a challenge is
-- `apps/api/src/mission-types/platform/physical-challenge.ts`, and the API
-- plays with it. This row is what the Studio lists and what an expedition's
-- missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/physical-challenge-row.test.ts` reads each
-- JSON value below between its dollar-quote tags and compares it with the
-- code. Change one and that test fails until the other matches.
--
-- It asks the phone for nothing (`capabilities` is empty): the work is done
-- with hands and feet, and the team hands in its word and, when there is a
-- measure, a number.
--
-- A published type is never edited (0001). A change to the physical
-- challenge is a new row at the next version, in a new migration.

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
  'physical-challenge',
  '1.0.0',
  'Physical challenge',
  'Teams build something, move, or show a skill in the real world, following steps the app describes.',
  'published',
  ARRAY[]::text[],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "activity": { "type": "string", "enum": ["build", "move", "skill"] },
      "steps": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" }
      },
      "doneWhen": {
        "type": "array",
        "maxItems": 10,
        "items": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" }
      },
      "measure": {
        "type": "object",
        "properties": {
          "what": { "type": "string", "minLength": 1, "maxLength": 80, "pattern": "\\s*\\S[\\s\\S]*" },
          "unit": { "type": "string", "minLength": 1, "maxLength": 20, "pattern": "\\s*\\S[\\s\\S]*" },
          "atLeast": { "type": "number" },
          "atMost": { "type": "number" }
        },
        "required": ["what", "unit"]
      },
      "acceptWithoutReview": { "type": "boolean" }
    },
    "required": ["activity", "steps"]
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "done": { "type": "boolean", "const": true },
      "result": { "type": "number" },
      "note": { "type": "string", "maxLength": 280 }
    },
    "required": ["done"]
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "activity": "move",
    "steps": ["Say what the team has to do."],
    "doneWhen": ["Say how the team knows they are done."],
    "acceptWithoutReview": false
  }
  $default_config$::jsonb,
  'automatic',
  $default_scoring$
  { "basePoints": 100, "allowPartialCredit": false }
  $default_scoring$::jsonb,
  $student_layout$
  {
    "blocks": [
      { "kind": "brief" },
      { "kind": "instructions" },
      { "kind": "media" },
      { "kind": "config-field", "field": "steps", "heading": "What to do" },
      { "kind": "config-field", "field": "doneWhen", "heading": "You are done when" },
      { "kind": "config-field", "field": "measure", "heading": "What to measure" },
      { "kind": "timer" },
      { "kind": "hints" },
      { "kind": "submission" }
    ],
    "submitLabel": "We did it"
  }
  $student_layout$::jsonb
);

COMMIT;
