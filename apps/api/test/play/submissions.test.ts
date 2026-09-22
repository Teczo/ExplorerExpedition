/**
 * Handing work in (EXPD-020).
 *
 * The completion interface (EXPD-011) judges, the state machine moves, the
 * scoring engine says what it was worth, and progression says what it
 * opened. These tests hold the endpoint to exposing each answer as it was
 * given, and to storing a record that adds up: every point a sealed line in
 * the team's stream, and the total on the team row the sum of them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyStream } from '@explorer/engine';

import { tenantRepository } from '../../src/db/tenant-repository.ts';
import { teamStream } from '../../src/stream/team-stream.ts';
import {
  ASHA,
  CAL,
  ORG_A,
  RUN_A,
  TEAM_BLUE,
  TEAM_RED,
  harness,
  missionIn,
  phone,
  refusalOf,
  scoreOf,
  teamRows,
  type Harness,
} from './support.ts';

/** The team row, as stored. */
function teamRow(h: Harness, teamId: string): Record<string, unknown> {
  const row = h.rows('team').find((stored) => stored['id'] === teamId);
  assert.notEqual(row, undefined);
  return row as Record<string, unknown>;
}

describe('a right answer', () => {
  test('is judged by the mission type, finishes the mission, and is paid for', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['feedback'], 'That is the code.');
      assert.equal(missionIn(answer)['state'], 'complete');

      // Ten for the mission, five for being first there.
      const score = scoreOf(answer);
      assert.deepEqual(
        score.events.map((event) => [event['reason'], event['points']]),
        [
          ['mission-complete', 10],
          ['first-to-complete-bonus', 5],
        ],
      );
      assert.equal(score.total, 15);
      assert.equal(teamRow(h, TEAM_RED)['total_score'], 15);
      assert.equal(teamRow(h, TEAM_RED)['streak'], 1);

      const attempt = answer.body['attempt'] as Record<string, unknown>;
      assert.equal(attempt['status'], 'succeeded');
      assert.equal(attempt['awardedPoints'], 15);
      assert.notEqual(attempt['completedAt'], null);

      const submission = answer.body['submission'] as Record<string, unknown>;
      assert.equal(submission['status'], 'accepted');
      assert.equal(submission['isLate'], false);
      const stored = h.rows('submission')[0];
      assert.deepEqual(stored?.['payload'], { code: 'OTTER' });
      assert.equal(stored?.['participant_id'], ASHA);
    } finally {
      await h.close();
    }
  });

  test('writes the submit and the verdict into the history', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });

      assert.deepEqual(
        teamRows(h, 'mission_transition', TEAM_RED).map((line) => [line['sequence'], line['trigger']]),
        [
          [1, 'unlock'],
          [2, 'start'],
          [3, 'submit'],
          [4, 'accept'],
        ],
      );
    } finally {
      await h.close();
    }
  });

  test('opens what was behind it', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });

      const progression = answer.body['progression'] as Record<string, unknown>;
      assert.ok((progression['unlockedMissionIds'] as string[]).includes('tower'));
      assert.ok(
        (progression['events'] as Record<string, unknown>[]).some(
          (event) => event['reason'] === 'mission-unlocked' && event['missionInstanceId'] === 'tower',
        ),
      );
      assert.equal((await h.start(phone(ASHA), 'tower')).status, 201);
    } finally {
      await h.close();
    }
  });

  test('the second team to finish gets no first-to-complete bonus', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      await h.start(phone(CAL), 'gate');
      const answer = await h.submit(phone(CAL), 'gate', { payload: { code: 'OTTER' } });

      assert.deepEqual(
        scoreOf(answer).events.map((event) => event['reason']),
        ['mission-complete'],
      );
      assert.equal(teamRow(h, TEAM_BLUE)['total_score'], 10);
    } finally {
      await h.close();
    }
  });

  test('the stored stream verifies, and adds up to the total on the team', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.hint(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'WRONG' } });
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      await h.start(phone(ASHA), 'tower');

      const stream = teamStream(tenantRepository(h.db, { organisationId: ORG_A }), {
        teamId: TEAM_RED,
        expeditionSessionId: RUN_A,
      });
      const lines = await stream.read();
      const check = verifyStream(lines, { expectedTotal: Number(teamRow(h, TEAM_RED)['total_score']) });

      assert.equal(check.intact, true, JSON.stringify(check));
      assert.deepEqual(check.defects, []);
      // -3 for the hint, -2 for the wrong answer, then 10 and 5.
      assert.equal(teamRow(h, TEAM_RED)['total_score'], 10);
      assert.equal(Number(teamRow(h, TEAM_RED)['stream_length']), lines.length);
    } finally {
      await h.close();
    }
  });
});

describe('a wrong answer', () => {
  test('costs a try and the penalty, and hands the mission back', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'WRONG' } });

      assert.equal(answer.status, 201);
      assert.equal((answer.body['verdict'] as Record<string, unknown>)['outcome'], 'incorrect');
      assert.equal(missionIn(answer)['state'], 'available');
      assert.deepEqual(
        scoreOf(answer).events.map((event) => [event['reason'], event['points']]),
        [['attempt-penalty', -2]],
      );
      assert.equal((answer.body['attempt'] as Record<string, unknown>)['status'], 'failed');
      assert.equal((answer.body['submission'] as Record<string, unknown>)['status'], 'rejected');
      assert.equal(teamRow(h, TEAM_RED)['failed_attempts'], 1);
      assert.equal(teamRow(h, TEAM_RED)['streak'], 0);
    } finally {
      await h.close();
    }
  });

  test('on the last try fails the mission', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'WRONG' } });
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'STILL-WRONG' } });

      assert.equal(missionIn(answer)['state'], 'failed');
      assert.deepEqual(missionIn(answer)['allowedTriggers'], []);
      assert.equal(teamRows(h, 'mission_attempt', TEAM_RED).length, 2);
      assert.equal(teamRow(h, TEAM_RED)['failed_attempts'], 2);
    } finally {
      await h.close();
    }
  });
});

describe('work a person has to look at', () => {
  test('a type that is only a row sends the work to a teacher, and nothing is scored', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'photo');
      const answer = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: 'img-1' } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'needs-review');
      assert.equal(verdict['review'], 'required');
      assert.equal(missionIn(answer)['state'], 'awaiting-verification');
      assert.deepEqual(scoreOf(answer).events, []);
      assert.equal((answer.body['attempt'] as Record<string, unknown>)['status'], 'awaiting-review');
      assert.equal((answer.body['attempt'] as Record<string, unknown>)['awardedPoints'], null);
      assert.equal((answer.body['submission'] as Record<string, unknown>)['status'], 'needs-review');
      assert.equal(h.rows('score_event').length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('what is refused, and that a refusal writes nothing', () => {
  test('work handed in before a try started', async () => {
    const h = await harness();
    try {
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'not-now');
      assert.equal(h.rows('submission').length, 0);
    } finally {
      await h.close();
    }
  });

  test('work in the wrong shape is not judged and is not a try spent', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const before = teamRows(h, 'mission_transition', TEAM_RED).length;
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { answer: 'OTTER' } });

      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'invalid-submission');
      assert.ok(Array.isArray((answer.body['refusal'] as Record<string, unknown>)['issues']));
      assert.equal(teamRows(h, 'mission_transition', TEAM_RED).length, before);
      assert.equal(h.rows('submission').length, 0);

      // The try is still running, so the right answer still counts.
      const right = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      assert.equal(missionIn(right)['state'], 'complete');
    } finally {
      await h.close();
    }
  });

  test('a mission type nobody registered is the engine’s refusal to give', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'ghost');
      const answer = await h.submit(phone(ASHA), 'ghost', { payload: {} });
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'unknown-mission-type');
    } finally {
      await h.close();
    }
  });

  test('a body that is not an answer is a validation failure', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      assert.equal((await h.submit(phone(ASHA), 'gate', { payload: 'OTTER' })).status, 422);
      assert.equal((await h.submit(phone(ASHA), 'gate', {})).status, 422);
      assert.equal(
        (await h.submit(phone(ASHA), 'gate', { payload: {}, position: { latitude: 200, longitude: 0 } }))
          .status,
        422,
      );
    } finally {
      await h.close();
    }
  });
});

describe('late work', () => {
  test('is refused when the expedition says so', async () => {
    const h = await harness({ totalTimeLimitSeconds: 60, latePolicy: 'reject' });
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'late');
      assert.equal(h.rows('submission').length, 0);
    } finally {
      await h.close();
    }
  });

  test('is accepted and marked late', async () => {
    const h = await harness({ totalTimeLimitSeconds: 60, latePolicy: 'accept' });
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      assert.equal((answer.body['submission'] as Record<string, unknown>)['isLate'], true);
      assert.ok(!scoreOf(answer).events.some((event) => event['reason'] === 'late-penalty'));
    } finally {
      await h.close();
    }
  });

  test('is charged for, by the minute, when the expedition says so', async () => {
    // Started ten minutes ago with a one-minute limit: nine minutes late.
    const h = await harness({ totalTimeLimitSeconds: 60, latePolicy: 'accept-with-penalty' });
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      const late = scoreOf(answer).events.find((event) => event['reason'] === 'late-penalty');
      assert.equal(late?.['points'], -9);
    } finally {
      await h.close();
    }
  });
});
