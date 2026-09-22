/**
 * Opening a hint (EXPD-020).
 *
 * What a hint costs in points is the scoring engine's `hint-penalty`
 * (EXPD-012), charged the moment it is opened and never twice. What it costs
 * in tokens is EXPD-046's, and nothing here counts them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  BEN,
  TEAM_RED,
  harness,
  phone,
  refusalOf,
  scoreOf,
  staff,
  teamRows,
} from './support.ts';

function hintOf(answer: { body: Record<string, unknown> }): Record<string, unknown> {
  return answer.body['hint'] as Record<string, unknown>;
}

describe('a team opens a hint', () => {
  test('the first one in order, charged as the expedition says', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.hint(phone(ASHA), 'gate');

      assert.equal(answer.status, 201);
      assert.equal(hintOf(answer)['id'], 'gate-hint-1');
      assert.equal(hintOf(answer)['text'], 'Look on the gatepost.');
      assert.equal(hintOf(answer)['alreadyOpened'], false);
      assert.deepEqual(
        scoreOf(answer).events.map((event) => [event['reason'], event['points'], event['hintId']]),
        [['hint-penalty', -3, 'gate-hint-1']],
      );
      assert.equal(scoreOf(answer).total, -3);

      const opened = teamRows(h, 'hint_request', TEAM_RED);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.['hint_key'], 'gate-hint-1');
      assert.equal(opened[0]?.['participant_id'], ASHA);
      // The stream line points at the hint row as well as naming the key.
      assert.equal(teamRows(h, 'score_event', TEAM_RED)[0]?.['hint_id'], 'a0000000-0000-4000-8000-000000000b01');
    } finally {
      await h.close();
    }
  });

  test('the next one after that, and then there are none left', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.hint(phone(ASHA), 'gate');
      const second = await h.hint(phone(BEN), 'gate');
      assert.equal(hintOf(second)['id'], 'gate-hint-2');
      assert.equal(scoreOf(second).total, -6);

      const third = await h.hint(phone(ASHA), 'gate');
      assert.equal(third.status, 409);
      assert.equal(refusalOf(third), 'no-hints-left');
    } finally {
      await h.close();
    }
  });

  test('asking again for one already opened shows it and charges nothing', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.hint(phone(ASHA), 'gate', { hintId: 'gate-hint-1' });
      const again = await h.hint(phone(BEN), 'gate', { hintId: 'gate-hint-1' });

      assert.equal(again.status, 200);
      assert.equal(hintOf(again)['alreadyOpened'], true);
      assert.deepEqual(scoreOf(again).events, []);
      assert.equal(scoreOf(again).total, -3);
      assert.equal(teamRows(h, 'hint_request', TEAM_RED).length, 1);
      assert.equal(teamRows(h, 'score_event', TEAM_RED).length, 1);
    } finally {
      await h.close();
    }
  });

  test('a hint may be opened before the try starts, on a mission that is open', async () => {
    const h = await harness();
    try {
      const answer = await h.hint(phone(ASHA), 'gate');
      assert.equal(answer.status, 201);
      assert.equal(answer.body['attempt'], null);
    } finally {
      await h.close();
    }
  });
});

describe('what is refused', () => {
  test('an expedition that hands out no hints', async () => {
    const h = await harness({ hints: false });
    try {
      const answer = await h.hint(phone(ASHA), 'gate');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'hints-disabled');
    } finally {
      await h.close();
    }
  });

  test('a mission that is still locked', async () => {
    const h = await harness();
    try {
      const answer = await h.hint(phone(ASHA), 'tower');
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'mission-not-open');
    } finally {
      await h.close();
    }
  });

  test('a mission that is over', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });
      assert.equal(refusalOf(await h.hint(phone(ASHA), 'gate')), 'mission-not-open');
    } finally {
      await h.close();
    }
  });

  test('a hint the mission does not have', async () => {
    const h = await harness();
    try {
      assert.equal((await h.hint(phone(ASHA), 'gate', { hintId: 'made-up' })).status, 404);
    } finally {
      await h.close();
    }
  });

  test('a teacher', async () => {
    const h = await harness();
    try {
      assert.equal((await h.hint(staff(), 'gate')).status, 403);
    } finally {
      await h.close();
    }
  });
});
