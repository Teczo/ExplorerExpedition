/**
 * The photo evidence type's platform row says what its code says (EXPD-033).
 *
 * The type is written down twice: as code, which judges a photo, and as the
 * `mission_type` row migration 0010 inserts, which the Studio lists and an
 * expedition is checked against. This reads the migration itself and holds
 * the row to the code, so the two cannot drift apart unnoticed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PHOTO_EVIDENCE_AUTHORING, photoEvidence } from '../../src/mission-types/platform/index.ts';

const MIGRATION = fileURLToPath(
  new URL('../../db/migrations/0010_photo_evidence_mission_type.sql', import.meta.url),
);
const sql = readFileSync(MIGRATION, 'utf8');

/** The JSON between `$tag$` and `$tag$`, parsed. */
function dollarQuoted(tag: string): unknown {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  assert.notEqual(match, null, `the migration has no $${tag}$ value`);
  return JSON.parse(match![1]!);
}

/** The single-quoted values of the INSERT, in column order. */
function quotedValues(): string[] {
  const values = sql.slice(sql.indexOf('VALUES'));
  return [...values.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]!.replace(/''/g, "'"));
}

describe('the photo-evidence row in migration 0010', () => {
  const { definition } = photoEvidence;

  test('belongs to the platform, not to an organisation', () => {
    assert.match(sql, /VALUES \(\s*NULL,/);
  });

  test('has the key, version, name, description, status and verification of the code', () => {
    assert.deepEqual(quotedValues(), [
      definition.key,
      definition.version,
      definition.name,
      definition.description,
      definition.status,
      ...definition.capabilities,
      PHOTO_EVIDENCE_AUTHORING.validationMethod,
    ]);
  });

  test('asks for the same capabilities', () => {
    const listed = sql.match(/ARRAY\[([^\]]*)\]/)?.[1] ?? '';
    assert.deepEqual(
      [...listed.matchAll(/'([^']*)'/g)].map((match) => match[1]),
      definition.capabilities,
    );
  });

  test('has the same config schema', () => {
    assert.deepEqual(dollarQuoted('config_schema'), definition.configSchema);
  });

  test('has the same submission schema', () => {
    assert.deepEqual(dollarQuoted('submission_schema'), definition.submissionSchema);
  });

  test('has the same starting settings', () => {
    assert.deepEqual(dollarQuoted('default_config'), definition.defaultConfig);
  });

  test('has the same starting score and student layout', () => {
    assert.deepEqual(dollarQuoted('default_scoring'), PHOTO_EVIDENCE_AUTHORING.defaultScoring);
    assert.deepEqual(dollarQuoted('student_layout'), PHOTO_EVIDENCE_AUTHORING.studentLayout);
  });
});
