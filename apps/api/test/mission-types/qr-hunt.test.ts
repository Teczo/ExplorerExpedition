/**
 * The QR hunt mission type (EXPD-032), through the registry that holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each list of scans is judged against it.
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
  PLATFORM_MISSION_TYPES,
  QR_HUNT_AUTHORING,
  QR_HUNT_KEY,
  QR_HUNT_VERSION,
  qrHunt,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([qrHunt]);

const LIBRARY = { code: 'LIB-01', label: 'Library window' };
const POND = { code: 'POND-02', label: 'By the pond' };
const OAK = { code: 'OAK-03', label: 'The big oak' };

/** Checks both halves the way the API does, then judges one list of scans. */
function judge(config: JsonObject, scanned: string[]): MissionEvaluation {
  assert.equal(registry.validateConfig(QR_HUNT_KEY, QR_HUNT_VERSION, config).valid, true);
  const submission = { scanned };
  assert.equal(registry.validateSubmission(QR_HUNT_KEY, QR_HUNT_VERSION, submission).valid, true);
  const prepared = registry.prepareConfig(QR_HUNT_KEY, QR_HUNT_VERSION, config);
  const behaviour = registry.behaviourFor(QR_HUNT_KEY, QR_HUNT_VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({ config, prepared, submission, attemptNumber: 1 });
}

describe('the QR hunt as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(qrHunt.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({ ...qrHunt.definition, ...QR_HUNT_AUTHORING }).valid,
      true,
    );
  });

  test('asks a phone for its QR scanner, and nothing else', () => {
    assert.deepEqual(qrHunt.definition.capabilities, ['qr']);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(qrHunt));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(QR_HUNT_KEY, QR_HUNT_VERSION, qrHunt.definition.defaultConfig).valid,
      true,
    );
  });

  test('never shows a team the markers, because the codes are the answer', () => {
    const fields = QR_HUNT_AUTHORING.studentLayout.blocks.filter(
      (block) => block.kind === 'config-field',
    );
    assert.deepEqual(fields, []);
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) =>
    registry.validateConfig(QR_HUNT_KEY, QR_HUNT_VERSION, config);

  test('has to say what the markers are for', () => {
    const result = check({ markers: [LIBRARY] });
    assert.equal(result.valid, false);
  });

  test('has to be one of the three purposes', () => {
    assert.equal(check({ purpose: 'treasure', markers: [LIBRARY] }).valid, false);
  });

  test('needs at least one marker', () => {
    assert.equal(check({ purpose: 'discovery', markers: [] }).valid, false);
  });

  test('refuses a code that is only spaces', () => {
    const result = check({ purpose: 'discovery', markers: [{ code: '   ' }] });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.issues[0]?.path, 'config.markers[0].code');
  });

  test('refuses a field the type does not know, such as a misspelling', () => {
    assert.equal(check({ purpose: 'discovery', markers: [LIBRARY], foundToComplet: 1 }).valid, false);
  });

  test('may leave the label out', () => {
    assert.equal(check({ purpose: 'validation', markers: [{ code: 'GATE' }] }).valid, true);
  });
});

describe('what a phone may hand in', () => {
  const check = (submission: JsonObject) =>
    registry.validateSubmission(QR_HUNT_KEY, QR_HUNT_VERSION, submission);

  test('is a list of the codes scanned', () => {
    assert.equal(check({ scanned: ['LIB-01'] }).valid, true);
  });

  test('is not empty', () => {
    assert.equal(check({ scanned: [] }).valid, false);
    assert.equal(check({}).valid, false);
  });

  test('is a list of words, not one', () => {
    assert.equal(check({ scanned: 'LIB-01' }).valid, false);
  });
});

describe('discovery: find the markers in any order', () => {
  const config = { purpose: 'discovery', markers: [LIBRARY, POND, OAK] };

  test('is done once every marker is found, whatever the order', () => {
    const verdict = judge(config, ['OAK-03', 'LIB-01', 'POND-02']);
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.progress, 1);
    assert.deepEqual(verdict.detail?.['found'], ['OAK-03', 'LIB-01', 'POND-02']);
  });

  test('counts some markers as partial progress, and says how many', () => {
    const verdict = judge(config, ['POND-02', 'NOT-OURS']);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.progress, 1 / 3);
    assert.equal(verdict.feedback, '1 of 3 markers found.');
    assert.deepEqual(verdict.detail?.['found'], ['POND-02']);
  });

  test('counts a marker scanned twice once', () => {
    const verdict = judge(config, ['POND-02', 'POND-02', 'pond-02']);
    assert.equal(verdict.progress, 1 / 3);
  });

  test('is done at foundToComplete, when the author set one', () => {
    const verdict = judge({ ...config, foundToComplete: 2 }, ['OAK-03', 'LIB-01']);
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.progress, 1);
    assert.equal(verdict.detail?.['needed'], 2);
  });

  test('reads a foundToComplete above the number of markers as all of them', () => {
    const verdict = judge({ ...config, foundToComplete: 9 }, ['OAK-03', 'LIB-01']);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.detail?.['needed'], 3);
  });

  test('never names a marker the team has not found', () => {
    const verdict = judge(config, ['LIB-01']);
    const said = JSON.stringify(verdict);
    assert.ok(!said.includes('POND-02') && !said.includes('By the pond'));
    assert.ok(!said.includes('OAK-03') && !said.includes('The big oak'));
  });
});

describe('progression: follow the markers in order', () => {
  const config = { purpose: 'progression', markers: [LIBRARY, POND, OAK] };

  test('is done when every marker is scanned in the order listed', () => {
    const verdict = judge(config, ['LIB-01', 'POND-02', 'OAK-03']);
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.feedback, 'Trail complete.');
  });

  test('does not count a marker scanned ahead of its turn', () => {
    const verdict = judge(config, ['LIB-01', 'OAK-03']);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.progress, 1 / 3);
    assert.equal(verdict.feedback, '1 of 3 markers found in order.');
    assert.deepEqual(verdict.detail?.['found'], ['LIB-01']);
  });

  test('lets a team that skipped ahead come back and finish', () => {
    const verdict = judge(config, ['LIB-01', 'OAK-03', 'POND-02', 'OAK-03']);
    assert.equal(verdict.outcome, 'correct');
  });

  test('ignores a code that is not on the trail', () => {
    const verdict = judge(config, ['LIB-01', 'SOMEWHERE', 'POND-02']);
    assert.equal(verdict.progress, 2 / 3);
  });

  test('ignores foundToComplete: the whole trail is the mission', () => {
    const verdict = judge({ ...config, foundToComplete: 1 }, ['LIB-01']);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.detail?.['needed'], 3);
  });
});

describe('validation: prove the team reached a place', () => {
  const config = { purpose: 'validation', markers: [LIBRARY, POND] };

  test('is done by any one of the markers', () => {
    const verdict = judge(config, ['POND-02']);
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.progress, 1);
    assert.equal(verdict.feedback, 'Marker found.');
  });

  test('is refused a code that is not one of them', () => {
    const verdict = judge(config, ['HALL-09']);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.progress, 0);
    assert.equal(verdict.feedback, 'That code is not a marker for this mission.');
  });
});

describe('comparing codes', () => {
  const config = { purpose: 'validation', markers: [{ code: 'LIB-01' }] };

  test('ignores case, so a code typed in from the sign still counts', () => {
    assert.equal(judge(config, ['lib-01']).outcome, 'correct');
  });

  test('ignores spaces around the code', () => {
    assert.equal(judge(config, ['  LIB-01 ']).outcome, 'correct');
  });

  test('reports the code as the author wrote it', () => {
    assert.deepEqual(judge(config, ['lib-01']).detail?.['found'], ['LIB-01']);
  });

  test('keeps the first of two markers that differ only in case', () => {
    const verdict = judge(
      { purpose: 'discovery', markers: [{ code: 'LIB-01' }, { code: 'lib-01' }, POND] },
      ['LIB-01'],
    );
    assert.equal(verdict.detail?.['needed'], 2);
  });
});

describe('purity', () => {
  test('the same config and scans give the same verdict twice', () => {
    const config = { purpose: 'discovery', markers: [LIBRARY, POND, OAK] };
    assert.deepEqual(judge(config, ['OAK-03']), judge(config, ['OAK-03']));
  });

  test('judges correctly when nothing was prepared', () => {
    const config = { purpose: 'validation', markers: [LIBRARY] };
    const verdict = qrHunt.behaviour!.evaluate({
      config,
      prepared: undefined,
      submission: { scanned: ['LIB-01'] },
      attemptNumber: 1,
    });
    assert.equal(verdict.outcome, 'correct');
  });
});
