/**
 * Playing a teacher verification mission through the API (EXPD-037).
 *
 * The team says it is ready, and the facilitator approves or rejects it with
 * the decision endpoint Director Mode calls (EXPD-020's
 * `POST .../teams/:teamId/missions/:missionId/complete`).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { teacherVerification } from '../../src/mission-types/platform/index.ts';
import {
  ASHA,
  TEAM_RED,
  harness,
  missionIn,
  phone,
  refusalOf,
  scoreOf,
  staff,
  teamRows,
  type Harness,
} from './support.ts';

const KNOT = { checklist: ['The bowline holds a person’s weight.'] };

async function playing(): Promise<Harness> {
  return harness({
    gate: { type: 'teacher-verification', config: KNOT },
    missionTypes: [teacherVerification],
  });
}

/** Asha's team says it is ready, and the gate waits for the facilitator. */
async function ready(h: Harness): Promise<void> {
  assert.equal((await h.start(phone(ASHA), 'gate')).status, 201);
  const sent = await h.submit(phone(ASHA), 'gate', {
    payload: { ready: true, note: 'At the climbing frame.' },
  });
  assert.equal(sent.status, 201);
  const verdict = sent.body['verdict'] as Record<string, unknown>;
  assert.equal(verdict['outcome'], 'needs-review');
  assert.equal(verdict['review'], 'required');
  assert.deepEqual(verdict['detail'], {
    checklist: ['The bowline holds a person’s weight.'],
    note: 'At the climbing frame.',
  });
  assert.equal(missionIn(sent)['state'], 'awaiting-verification');
  assert.deepEqual(scoreOf(sent).events, []);
}

describe('a teacher verification mission in a run', () => {
  test('waits for the facilitator, who approves it and pays for it', async () => {
    const h = await playing();
    try {
      await ready(h);
      const answer = await h.decide(staff(), TEAM_RED, 'gate', {
        decision: 'approve',
        note: 'Solid knot.',
      });

      assert.equal(answer.status, 200);
      assert.equal(missionIn(answer)['state'], 'complete');
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['method'], 'teacher');
      assert.deepEqual(
        scoreOf(answer).events.map((event) => [event['reason'], event['points']]),
        [
          ['mission-complete', 10],
          ['first-to-complete-bonus', 5],
        ],
      );
      assert.equal(h.rows('submission')[0]?.['status'], 'accepted');
      assert.equal(teamRows(h, 'mission_transition', TEAM_RED).at(-1)?.['reason'], 'Solid knot.');
    } finally {
      await h.close();
    }
  });

  test('a rejection hands it back, and a rejection on the last try fails it', async () => {
    const h = await playing();
    try {
      await ready(h);
      const first = await h.decide(staff(), TEAM_RED, 'gate', {
        decision: 'reject',
        note: 'It slipped. Tie it again.',
      });
      assert.equal(first.status, 200);
      assert.equal(missionIn(first)['state'], 'available');
      assert.equal(h.rows('submission')[0]?.['status'], 'rejected');

      // The gate allows two tries.
      await ready(h);
      const last = await h.decide(staff(), TEAM_RED, 'gate', { decision: 'reject' });
      assert.equal(missionIn(last)['state'], 'failed');
    } finally {
      await h.close();
    }
  });

  test('cannot be decided before the team says it is ready', async () => {
    const h = await playing();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.decide(staff(), TEAM_RED, 'gate', { decision: 'approve' });
      assert.equal(refusalOf(answer), 'not-now');
    } finally {
      await h.close();
    }
  });

  test('a team cannot approve its own work', async () => {
    const h = await playing();
    try {
      await ready(h);
      const answer = await h.decide(phone(ASHA), TEAM_RED, 'gate', { decision: 'approve' });
      assert.equal(answer.status, 403);
      assert.equal(missionIn(await h.decide(staff(), TEAM_RED, 'gate', { decision: 'approve' }))['state'], 'complete');
    } finally {
      await h.close();
    }
  });
});
