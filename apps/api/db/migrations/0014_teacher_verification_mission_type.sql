-- ---------------------------------------------------------------------------
-- 0014  The teacher verification mission type (EXPD-037)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `teacher-verification` at 1.0.0, with
-- no organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- The code that refers a hand-in is
-- `apps/api/src/mission-types/platform/teacher-verification.ts`, and the API
-- plays with it. This row is what the Studio lists and what an expedition's
-- missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/teacher-verification-row.test.ts` reads each
-- JSON value below between its dollar-quote tags and compares it with the
-- code. Change one and that test fails until the other matches.
--
-- It asks the phone for nothing (`capabilities` is empty): the team shows a
-- facilitator in person, and the facilitator decides.
--
-- A published type is never edited (0001). A change to teacher verification
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
  'teacher-verification',
  '1.0.0',
  'Teacher verification',
  'Teams show a facilitator what they did, and the facilitator approves or rejects it.',
  'published',
  ARRAY[]::text[],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "checklist": {
        "type": "array",
        "minItems": 1,
        "maxItems": 10,
        "items": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" }
      }
    },
    "required": ["checklist"]
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "ready": { "type": "boolean", "const": true },
      "note": { "type": "string", "maxLength": 280 }
    },
    "required": ["ready"]
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "checklist": ["Say what the facilitator has to see."]
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
      { "kind": "config-field", "field": "checklist", "heading": "Your teacher will check" },
      { "kind": "timer" },
      { "kind": "hints" },
      { "kind": "submission" }
    ],
    "submitLabel": "Ready for the teacher"
  }
  $student_layout$::jsonb
);

COMMIT;
