/**
 * Playing a physical challenge mission through the API (EXPD-034).
 *
 * `createApp` is built with no mission types of its own, so the physical
 * challenge is the one the platform ships (`PLATFORM_MISSION_TYPES`). There
 * is no `physical-challenge` row seeded either: the code judges the hand-in
 * without one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { ASHA, CONFIG, RUN_A, missionIn, phone, refusalOf, scoreOf, seed } from './support.ts';

const TOWER = {
  activity: 'build',
  steps: ['Build a tower from the cups.'],
  measure: { what: 'Tower height', unit: 'cm', atLeast: 50 },
};

async function playing(config: JsonObject): Promise<{
  app: RunningApp;
  post: (path: string, body?: unknown) => Promise<Answer>;
}> {
  const db = new FakeDatabase();
  seed(db, { gate: { type: 'physical-challenge', config } });
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

describe('a physical challenge mission in a run', () => {
  test('is judged by the platform type, and a met target completes it', async () => {
    const { app, post } = await playing({ ...TOWER, acceptWithoutReview: true });
    try {
      assert.equal((await post('attempts')).status, 201);
      const answer = await post('submissions', { payload: { done: true, result: 55 } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['feedback'], 'Challenge complete.');
      assert.equal(missionIn(answer)['state'], 'complete');
      assert.equal(scoreOf(answer).total > 0, true);
    } finally {
      await app.close();
    }
  });

  test('waits for a teacher by default', async () => {
    const { app, post } = await playing(TOWER);
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { done: true, result: 55 } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'needs-review');
      assert.equal(missionIn(answer)['state'], 'awaiting-verification');
    } finally {
      await app.close();
    }
  });

  test('turns a result under the target away, and says the target', async () => {
    const { app, post } = await playing(TOWER);
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { done: true, result: 35 } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'incorrect');
      assert.equal(verdict['feedback'], 'Not yet: 35 cm. Tower height has to be at least 50 cm.');
      assert.notEqual(missionIn(answer)['state'], 'complete');
    } finally {
      await app.close();
    }
  });

  test('refuses a submission that does not say the challenge is done', async () => {
    const { app, post } = await playing(TOWER);
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { result: 55 } });
      assert.equal(refusalOf(answer), 'invalid-submission');
    } finally {
      await app.close();
    }
  });
});
