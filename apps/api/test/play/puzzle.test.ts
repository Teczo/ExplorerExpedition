/**
 * Playing a puzzle mission through the API (EXPD-035).
 *
 * `createApp` is built with no mission types of its own, so the puzzle is
 * the one the platform ships (`PLATFORM_MISSION_TYPES`). There is no
 * `puzzle` row seeded either: the code judges the answers without one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/app.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { ASHA, CONFIG, RUN_A, missionIn, phone, refusalOf, scoreOf, seed } from './support.ts';

const LOCKS = {
  kind: 'sequence',
  question: 'Put the locks in the order they were built.',
  answerType: 'order',
  choices: [
    { id: 'mill', label: 'Mill lock' },
    { id: 'abbey', label: 'Abbey lock' },
    { id: 'weir', label: 'Weir lock' },
  ],
  correctOrder: ['abbey', 'mill', 'weir'],
};

async function playing(): Promise<{
  app: RunningApp;
  post: (path: string, body?: unknown) => Promise<Answer>;
}> {
  const db = new FakeDatabase();
  seed(db, { gate: { type: 'puzzle', config: LOCKS } });
  const app = await listen(createApp({ db, authConfig: CONFIG }));
  const post = (path: string, body?: unknown) =>
    send(app, `/sessions/${RUN_A}/missions/gate/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${phone(ASHA)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, post };
}

describe('a puzzle mission in a run', () => {
  test('is judged by the platform type, and the right answer completes it', async () => {
    const { app, post } = await playing();
    try {
      assert.equal((await post('attempts')).status, 201);
      const answer = await post('submissions', { payload: { order: ['abbey', 'mill', 'weir'] } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['feedback'], 'Puzzle solved.');
      assert.equal(missionIn(answer)['state'], 'complete');
      assert.equal(scoreOf(answer).total > 0, true);
    } finally {
      await app.close();
    }
  });

  test('turns a wrong answer away, and says how close it came', async () => {
    const { app, post } = await playing();
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { order: ['abbey', 'weir', 'mill'] } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'incorrect');
      assert.equal(verdict['feedback'], '1 of 3 in the right place.');
      assert.notEqual(missionIn(answer)['state'], 'complete');
    } finally {
      await app.close();
    }
  });

  test('refuses a submission with nothing in it', async () => {
    const { app, post } = await playing();
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: {} });
      assert.equal(refusalOf(answer), 'invalid-submission');
    } finally {
      await app.close();
    }
  });
});
