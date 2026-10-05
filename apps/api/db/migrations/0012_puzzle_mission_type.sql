-- ---------------------------------------------------------------------------
-- 0012  The puzzle mission type (EXPD-035)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `puzzle` at 1.0.0, with no
-- organisation, so every organisation can use it (EXPD-004's shared rows).
--
-- Numbered 0012 because 0011 is the physical challenge's (EXPD-034).
--
-- The code that judges an answer is
-- `apps/api/src/mission-types/platform/puzzle.ts`, and the API plays with it.
-- This row is what the Studio lists and what an expedition's missions are
-- checked against. The two say the same thing:
-- `apps/api/test/mission-types/puzzle-row.test.ts` reads each JSON value
-- below between its dollar-quote tags and compares it with the code. Change
-- one and that test fails until the other matches.
--
-- It asks the phone for nothing (`capabilities` is empty): a puzzle is
-- answered on the screen.
--
-- A published type is never edited (0001). A change to the puzzle is a new
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
  'puzzle',
  '1.0.0',
  'Puzzle',
  'Teams solve a logic, code, sequence or pattern puzzle and answer it in the app.',
  'published',
  ARRAY[]::text[],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "logic",
          "code",
          "sequence",
          "pattern"
        ]
      },
      "question": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000,
        "pattern": "\\s*\\S[\\s\\S]*"
      },
      "answerType": {
        "type": "string",
        "enum": [
          "text",
          "number",
          "choice",
          "order"
        ]
      },
      "acceptedAnswers": {
        "type": "array",
        "minItems": 1,
        "maxItems": 50,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "pattern": "\\s*\\S[\\s\\S]*"
        }
      },
      "caseSensitive": {
        "type": "boolean"
      },
      "ignoreSpaces": {
        "type": "boolean"
      },
      "tolerance": {
        "type": "number",
        "minimum": 0
      },
      "choices": {
        "type": "array",
        "minItems": 2,
        "maxItems": 20,
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 40,
              "pattern": "\\s*\\S[\\s\\S]*"
            },
            "label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "pattern": "\\s*\\S[\\s\\S]*"
            }
          },
          "required": [
            "id",
            "label"
          ]
        }
      },
      "correctChoices": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      },
      "correctOrder": {
        "type": "array",
        "minItems": 2,
        "maxItems": 20,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      }
    },
    "required": [
      "kind",
      "question",
      "answerType"
    ]
  }
  $config_schema$::jsonb,
  $submission_schema$
  {
    "type": "object",
    "properties": {
      "answer": {
        "type": "string",
        "maxLength": 200
      },
      "selected": {
        "type": "array",
        "maxItems": 20,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "maxLength": 40
        }
      },
      "order": {
        "type": "array",
        "maxItems": 20,
        "items": {
          "type": "string",
          "maxLength": 40
        }
      }
    },
    "minProperties": 1
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "kind": "code",
    "question": "Write the puzzle here.",
    "answerType": "text",
    "acceptedAnswers": [
      "CHANGE-ME"
    ]
  }
  $default_config$::jsonb,
  'automatic',
  $default_scoring$
  {
    "basePoints": 100,
    "allowPartialCredit": false
  }
  $default_scoring$::jsonb,
  $student_layout$
  {
    "blocks": [
      {
        "kind": "brief"
      },
      {
        "kind": "instructions"
      },
      {
        "kind": "media"
      },
      {
        "kind": "config-field",
        "field": "question",
        "heading": "Puzzle"
      },
      {
        "kind": "config-field",
        "field": "choices",
        "heading": "Choose from"
      },
      {
        "kind": "timer"
      },
      {
        "kind": "hints"
      },
      {
        "kind": "submission"
      }
    ],
    "submitLabel": "Check answer"
  }
  $student_layout$::jsonb
);

COMMIT;
