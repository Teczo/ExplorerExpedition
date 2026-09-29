-- ---------------------------------------------------------------------------
-- 0009  The QR hunt mission type (EXPD-032)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `qr-hunt` at 1.0.0, with no
-- organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- The code that judges a scan is `apps/api/src/mission-types/platform/qr-hunt.ts`,
-- and the API plays with it. This row is what the Studio lists and what an
-- expedition's missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/qr-hunt-row.test.ts` reads each JSON value
-- below between its dollar-quote tags and compares it with the code. Change
-- one and that test fails until the other matches.
--
-- A published type is never edited (0001). A change to the QR hunt is a new
-- row at the next version, in a new migration.

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
  'qr-hunt',
  '1.0.0',
  'QR hunt',
  'Teams scan QR markers placed around a site: to find them, to follow them in order, or to prove they reached a place.',
  'published',
  ARRAY['qr'],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "purpose": { "type": "string", "enum": ["discovery", "progression", "validation"] },
      "markers": {
        "type": "array",
        "minItems": 1,
        "maxItems": 200,
        "items": {
          "type": "object",
          "properties": {
            "code": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\s*\\S[\\s\\S]*" },
            "label": { "type": "string", "maxLength": 120 }
          },
          "required": ["code"]
        }
      },
      "foundToComplete": { "type": "integer", "minimum": 1, "maximum": 200 }
    },
    "required": ["purpose", "markers"]
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "scanned": {
        "type": "array",
        "minItems": 1,
        "maxItems": 400,
        "items": { "type": "string", "minLength": 1, "maxLength": 200 }
      }
    },
    "required": ["scanned"]
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "purpose": "discovery",
    "markers": [{ "code": "CHANGE-ME", "label": "Where this marker is stuck up" }]
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
      { "kind": "timer" },
      { "kind": "hints" },
      { "kind": "submission" }
    ],
    "submitLabel": "Scan"
  }
  $student_layout$::jsonb
);

COMMIT;
