-- ---------------------------------------------------------------------------
-- 0015  The communication challenge mission type (EXPD-038)
-- ---------------------------------------------------------------------------
--
-- One platform row in `mission_type`: `communication-challenge` at 1.0.0,
-- with no organisation, so every organisation can use it (EXPD-004's shared
-- rows). It covers the Blind Rover, Radio Rescue and Memory Relay patterns.
--
-- The code that deals the parts out and judges the answer is
-- `apps/api/src/mission-types/platform/communication-challenge.ts`, and the
-- API plays with it. This row is what the Studio lists and what an
-- expedition's missions are checked against. The two say the same thing:
-- `apps/api/test/mission-types/communication-challenge-row.test.ts` reads each
-- JSON value below between its dollar-quote tags and compares it with the
-- code. Change one and that test fails until the other matches.
--
-- It asks the phone for nothing (`capabilities` is empty): the parts are
-- read off the screen and the team talks.
--
-- The student layout places no config field on purpose: each phone reads
-- its own share through `GET /sessions/:id/missions/:missionId/part`, and a
-- field placed here would show every part to every player.
--
-- A published type is never edited (0001). A change to the communication
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
  'communication-challenge',
  '1.0.0',
  'Communication challenge',
  'Information is split between players, and the team has to talk to put it together.',
  'published',
  ARRAY[]::text[],
  $config_schema$
  {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "enum": [
          "blind-rover",
          "radio-rescue",
          "memory-relay"
        ]
      },
      "parts": {
        "type": "array",
        "minItems": 1,
        "maxItems": 12,
        "items": {
          "type": "object",
          "properties": {
            "heading": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80,
              "pattern": "\\s*\\S[\\s\\S]*"
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1000,
              "pattern": "\\s*\\S[\\s\\S]*"
            },
            "role": {
              "type": "string",
              "minLength": 1,
              "maxLength": 60,
              "pattern": "\\s*\\S[\\s\\S]*"
            },
            "showForSeconds": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "heading",
            "text"
          ]
        }
      },
      "answerType": {
        "type": "string",
        "enum": [
          "text",
          "sequence"
        ]
      },
      "acceptedAnswers": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "pattern": "\\s*\\S[\\s\\S]*"
        }
      },
      "correctSequence": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "pattern": "\\s*\\S[\\s\\S]*"
        }
      }
    },
    "required": [
      "pattern",
      "parts",
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
      "sequence": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "string",
          "maxLength": 200
        }
      }
    },
    "required": []
  }
  $submission_schema$::jsonb,
  $default_config$
  {
    "pattern": "radio-rescue",
    "parts": [
      {
        "heading": "Your fragment",
        "text": "Say what the first player knows."
      },
      {
        "heading": "Your fragment",
        "text": "Say what the second player knows."
      }
    ],
    "answerType": "text",
    "acceptedAnswers": [
      "Say what the team has to work out."
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
        "kind": "timer"
      },
      {
        "kind": "hints"
      },
      {
        "kind": "submission"
      }
    ],
    "submitLabel": "Send our answer"
  }
  $student_layout$::jsonb
);

COMMIT;
