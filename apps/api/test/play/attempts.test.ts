/**
 * Starting a try (EXPD-020).
 *
 * The state machine (EXPD-010) says whether a try may start, and progression
 * (EXPD-013) says whether the lock is off. These tests hold the endpoint to
 * asking both, writing down exactly what they said, and writing nothing at
 * all when either says no.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  BEN,
  CAL,
  DEV,
  EVE,
  MISSING_ID,
  MISSION_ROWS,
  ORG_B,
  RIA,
  RUN_A,
  RUN_A2,
  RUN_B,
  TEAM_BLUE,
  TEAM_RED,
  harness,
  missionIn,
  phone,
  refusalOf,
  staff,
  teamRows,
} from './support.ts';

describe('a team starts a try', () => {
  test('the mission is unlocked, started, and the try is written down', async () => {
    const h = await harness();
    try {
      const answer = await h.start(phone(ASHA), 'gate');

      assert.equal(answer.status, 201);
      const mission = missionIn(answer);
      assert.equal(mission['id'], 'gate');
      assert.equal(mission['state'], 'in-progress');
      assert.equal(mission['attemptsUsed'], 1);
      assert.ok((mission['allowedTriggers'] as string[]).includes('submit'));

      const attempt = answer.body['attempt'] as Record<string, unknown>;
      assert.equal(attempt['number'], 1);
      assert.equal(attempt['status'], 'open');

      const attempts = teamRows(h, 'mission_attempt', TEAM_RED);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.['mission_instance_id'], MISSION_ROWS['gate']);
      assert.equal(attempts[0]?.['opened_by'], ASHA);
      assert.equal(attempts[0]?.['attempt_number'], 1);
    } finally {
      await h.close();
    }
  });

  test('the history holds the unlock and the start, in order, and nothing else', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const lines = teamRows(h, 'mission_transition', TEAM_RED);

      assert.deepEqual(
        lines.map((line) => [line['sequence'], line['trigger'], line['from_state'], line['to_state']]),
        [
          [1, 'unlock', 'locked', 'available'],
          [2, 'start', 'available', 'in-progress'],
        ],
      );
      assert.equal(lines[0]?.['actor'], 'engine');
      assert.equal(lines[1]?.['actor'], 'team');
      assert.equal(lines[0]?.['mission_attempt_id'], null);
      assert.equal(lines[1]?.['mission_attempt_id'], teamRows(h, 'mission_attempt', TEAM_RED)[0]?.['id']);
    } finally {
      await h.close();
    }
  });

  test('the first thing a team does writes down the doors the expedition opened with', async () => {
    const h = await harness();
    try {
      const answer = await h.start(phone(ASHA), 'gate');
      const progression = answer.body['progression'] as Record<string, unknown>;
      const reasons = (progression['events'] as Record<string, unknown>[]).map((event) => event['reason']);

      assert.ok(reasons.includes('node-reached'));
      assert.ok(reasons.includes('mission-unlocked'));
      assert.deepEqual(
        [...(progression['unlockedMissionIds'] as string[])].sort(),
        ['gate', 'ghost', 'photo'],
      );
      assert.equal(teamRows(h, 'progression_event', TEAM_RED).length, reasons.length);

      // And the second writes nothing new, because nothing new opened.
      const again = await h.start(phone(ASHA), 'photo');
      assert.deepEqual((again.body['progression'] as Record<string, unknown>)['events'], []);
    } finally {
      await h.close();
    }
  });

  test('two students on one team share one history', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.start(phone(BEN), 'gate');

      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'wrong-state');
      assert.equal(teamRows(h, 'mission_attempt', TEAM_RED).length, 1);
      assert.equal(teamRows(h, 'mission_transition', TEAM_RED).length, 2);
    } finally {
      await h.close();
    }
  });

  test('another team has a history of its own', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.start(phone(CAL), 'gate');

      assert.equal(answer.status, 201);
      assert.equal(teamRows(h, 'mission_attempt', TEAM_BLUE).length, 1);
      assert.equal(teamRows(h, 'mission_transition', TEAM_BLUE)[0]?.['sequence'], 1);
    } finally {
      await h.close();
    }
  });
});

describe('what is refused, and that a refusal writes nothing', () => {
  test('a mission behind one that is not finished is locked', async () => {
    const h = await harness();
    try {
      const answer = await h.start(phone(ASHA), 'tower');

      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'locked');
      const refusal = answer.body['refusal'] as Record<string, unknown>;
      assert.equal((refusal['blockedBy'] as Record<string, unknown>[])[0]?.['reason'], 'not-cleared');
      assert.equal(h.rows('mission_transition').length, 0);
      assert.equal(h.rows('mission_attempt').length, 0);
    } finally {
      await h.close();
    }
  });

  test('strict mode opens one mission at a time', async () => {
    const h = await harness({ progression: 'strict' });
    try {
      assert.equal((await h.start(phone(ASHA), 'gate')).status, 201);
      assert.equal(refusalOf(await h.start(phone(ASHA), 'photo')), 'locked');
    } finally {
      await h.close();
    }
  });

  for (const status of ['paused', 'lobby', 'ended']) {
    test(`a run that is ${status} is not played in`, async () => {
      const h = await harness({ runStatus: status });
      try {
        const answer = await h.start(phone(ASHA), 'gate');
        assert.equal(answer.status, 409);
        assert.equal(refusalOf(answer), 'run-not-playing');
        assert.equal(h.rows('mission_transition').length, 0);
      } finally {
        await h.close();
      }
    });
  }

  test('a student on no team is told so', async () => {
    const h = await harness();
    try {
      const answer = await h.start(phone(DEV), 'gate');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'no-team');
    } finally {
      await h.close();
    }
  });

  test('a student a teacher removed cannot play on', async () => {
    const h = await harness();
    try {
      const answer = await h.start(phone(EVE), 'gate');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'not-in-run');
    } finally {
      await h.close();
    }
  });

  test('a mission the document does not have is not found', async () => {
    const h = await harness();
    try {
      assert.equal((await h.start(phone(ASHA), 'no-such-mission')).status, 404);
    } finally {
      await h.close();
    }
  });

  test('a cooldown after a wrong answer holds the next try back', async () => {
    const h = await harness({ cooldownSeconds: 30 });
    try {
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'WRONG' } });

      const answer = await h.start(phone(ASHA), 'gate');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'cooling-down');
      assert.equal(teamRows(h, 'mission_attempt', TEAM_RED).length, 1);
    } finally {
      await h.close();
    }
  });

  test('no tries left is the state machine’s answer', async () => {
    const h = await harness({ gateMaxAttempts: 1 });
    try {
      await h.start(phone(ASHA), 'gate');
      const wrong = await h.submit(phone(ASHA), 'gate', { payload: { code: 'WRONG' } });
      assert.equal(missionIn(wrong)['state'], 'failed');

      const answer = await h.start(phone(ASHA), 'gate');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'terminal-state');
    } finally {
      await h.close();
    }
  });
});

describe('who may start one', () => {
  test('a phone plays in its own run only', async () => {
    const h = await harness();
    try {
      assert.equal((await h.start(phone(ASHA), 'gate', RUN_A2)).status, 404);
      assert.equal((await h.start(phone(ASHA), 'gate', MISSING_ID)).status, 404);
    } finally {
      await h.close();
    }
  });

  test('another school’s run is not found, even with its own phone’s run id', async () => {
    const h = await harness();
    try {
      // Ria's phone is Riverbank's, and Riverbank's run is not in this
      // organisation's scope from Portside's side — nor Portside's from hers.
      assert.equal((await h.start(phone(ASHA), 'gate', RUN_B)).status, 404);
      assert.equal(
        (await h.start(phone(RIA, { sessionId: RUN_B, organisationId: ORG_B }), 'gate', RUN_A)).status,
        404,
      );
    } finally {
      await h.close();
    }
  });

  test('a teacher cannot play for a team', async () => {
    const h = await harness();
    try {
      for (const role of ['facilitator', 'creator', 'org-admin']) {
        assert.equal((await h.start(staff({ role }), 'gate')).status, 403);
      }
      assert.equal(h.rows('mission_transition').length, 0);
    } finally {
      await h.close();
    }
  });

  test('no token, no play', async () => {
    const h = await harness();
    try {
      const answer = await h.start('not-a-token', 'gate');
      assert.equal(answer.status, 401);
    } finally {
      await h.close();
    }
  });
});
