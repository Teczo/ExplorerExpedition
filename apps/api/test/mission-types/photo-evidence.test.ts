/**
 * The photo evidence mission type (EXPD-033), through the registry that
 * holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each photo is judged against it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMissionTypeRegistry, type MissionEvaluation } from '@explorer/engine';
import {
  validateAuthoredMissionType,
  validateMissionTypeDefinition,
  type JsonObject,
} from '@explorer/shared-types';

import {
  PHOTO_EVIDENCE_AUTHORING,
  PHOTO_EVIDENCE_KEY,
  PHOTO_EVIDENCE_VERSION,
  PLATFORM_MISSION_TYPES,
  photoEvidence,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([photoEvidence]);

const PHOTO = '0b6f1c1e-6a3b-4a4e-9f55-3c2b1a0d9e11';

/** Checks both halves the way the API does, then judges one photo. */
function judge(config: JsonObject, submission: JsonObject): MissionEvaluation {
  assert.equal(registry.validateConfig(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION, config).valid, true);
  assert.equal(
    registry.validateSubmission(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION, submission).valid,
    true,
  );
  const prepared = registry.prepareConfig(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION, config);
  const behaviour = registry.behaviourFor(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({ config, prepared, submission, attemptNumber: 1 });
}

describe('photo evidence as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(photoEvidence.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({ ...photoEvidence.definition, ...PHOTO_EVIDENCE_AUTHORING }).valid,
      true,
    );
  });

  test('asks a phone for its camera, and nothing else', () => {
    assert.deepEqual(photoEvidence.definition.capabilities, ['camera']);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(photoEvidence));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(
        PHOTO_EVIDENCE_KEY,
        PHOTO_EVIDENCE_VERSION,
        photoEvidence.definition.defaultConfig,
      ).valid,
      true,
    );
  });

  test('shows the team what the photo has to show', () => {
    const fields = PHOTO_EVIDENCE_AUTHORING.studentLayout.blocks.filter(
      (block) => block.kind === 'config-field',
    );
    assert.deepEqual(
      fields.map((block) => (block.kind === 'config-field' ? block.field : '')),
      ['mustShow'],
    );
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) =>
    registry.validateConfig(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION, config);

  test('may write nothing at all', () => {
    assert.equal(check({}).valid, true);
  });

  test('may not list a blank requirement', () => {
    assert.equal(check({ mustShow: ['   '] }).valid, false);
    assert.equal(check({ mustShow: [''] }).valid, false);
  });

  test('may list at most ten requirements', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `Thing ${index + 1}`);
    assert.equal(check({ mustShow: eleven.slice(0, 10) }).valid, true);
    assert.equal(check({ mustShow: eleven }).valid, false);
  });

  test('says yes or no to review, and nothing else', () => {
    assert.equal(check({ acceptWithoutReview: true }).valid, true);
    assert.equal(check({ acceptWithoutReview: 'yes' }).valid, false);
  });
});

describe('what a team may send', () => {
  const check = (submission: JsonObject) =>
    registry.validateSubmission(PHOTO_EVIDENCE_KEY, PHOTO_EVIDENCE_VERSION, submission);

  test('has to name the photo it uploaded', () => {
    assert.equal(check({ mediaId: PHOTO }).valid, true);
    assert.equal(check({}).valid, false);
  });

  test('names it by the id the upload gave back, and nothing else', () => {
    assert.equal(check({ mediaId: 'img-1' }).valid, false);
    assert.equal(check({ mediaId: `${PHOTO}x` }).valid, false);
    assert.equal(check({ mediaId: 42 }).valid, false);
  });

  test('may add a short caption', () => {
    assert.equal(check({ mediaId: PHOTO, caption: 'At the gate.' }).valid, true);
    assert.equal(check({ mediaId: PHOTO, caption: 'x'.repeat(281) }).valid, false);
  });
});

describe('judging a photo', () => {
  test('sends it to a teacher, because code cannot judge a photo', () => {
    const evaluation = judge({ mustShow: ['The heron', 'Your whole team'] }, { mediaId: PHOTO });
    assert.equal(evaluation.outcome, 'needs-review');
    assert.equal(evaluation.feedback, 'Photo received. Your teacher will check it.');
    assert.equal(evaluation.progress, undefined);
  });

  test('keeps the photo and what it has to show, for whoever reviews it', () => {
    const evaluation = judge(
      { mustShow: ['  The heron  ', 'Your whole team'] },
      { mediaId: PHOTO, caption: 'By the pond.' },
    );
    assert.deepEqual(evaluation.detail, {
      mediaId: PHOTO,
      mustShow: ['The heron', 'Your whole team'],
      caption: 'By the pond.',
    });
  });

  test('leaves out a caption that is only spaces', () => {
    const evaluation = judge({}, { mediaId: PHOTO, caption: '   ' });
    assert.deepEqual(evaluation.detail, { mediaId: PHOTO, mustShow: [] });
  });

  test('counts it straight away when the author said no review is needed', () => {
    const evaluation = judge({ acceptWithoutReview: true }, { mediaId: PHOTO });
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.progress, 1);
    assert.equal(evaluation.feedback, 'Photo received.');
  });

  test('gives the same answer twice', () => {
    const config = { mustShow: ['The heron'] };
    assert.deepEqual(judge(config, { mediaId: PHOTO }), judge(config, { mediaId: PHOTO }));
  });
});
