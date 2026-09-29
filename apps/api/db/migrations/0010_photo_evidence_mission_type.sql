-- ---------------------------------------------------------------------------
-- 0010  The photo evidence mission type (EXPD-033)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `photo-evidence` at 1.0.0, with no
-- organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- Numbered 0010 because 0009 is the QR hunt's (EXPD-032).
--
-- The code that judges a photo is
-- `apps/api/src/mission-types/platform/photo-evidence.ts`, and the API plays
-- with it. This row is what the Studio lists and what an expedition's
-- missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/photo-evidence-row.test.ts` reads each JSON
-- value below between its dollar-quote tags and compares it with the code.
-- Change one and that test fails until the other matches.
--
-- A published type is never edited (0001). A change to photo evidence is a
-- new row at the next version, in a new migration.

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
  'photo-evidence',
  '1.0.0',
  'Photo evidence',
  'Teams take a photo as proof they completed the mission, and a teacher checks it.',
  'published',
  ARRAY['camera'],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "mustShow": {
        "type": "array",
        "maxItems": 10,
        "items": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" }
      },
      "acceptWithoutReview": { "type": "boolean" }
    },
    "required": []
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "mediaId": {
        "type": "string",
        "pattern": "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
      },
      "caption": { "type": "string", "maxLength": 280 }
    },
    "required": ["mediaId"]
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "mustShow": ["Your whole team"],
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
      { "kind": "config-field", "field": "mustShow", "heading": "Your photo has to show" },
      { "kind": "timer" },
      { "kind": "hints" },
      { "kind": "submission" }
    ],
    "submitLabel": "Send photo"
  }
  $student_layout$::jsonb
);

COMMIT;
