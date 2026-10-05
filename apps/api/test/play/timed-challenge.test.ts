/**
 * Playing a timed challenge mission through the API (EXPD-036).
 *
 * `createApp` is built with no mission types of its own, so the timed
 * challenge is the one the platform ships (`PLATFORM_MISSION_TYPES`). There
 * is no `timed-challenge` row seeded either: the code judges the hand-in
 * without one.
 *
 * The clock is the server's, and a test cannot wind it, so a hand-in here is
 * always fast. What a slow one is worth is the type's own tests' to show.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { ASHA, CONFIG, RUN_A, missionIn, phone, refusalOf, scoreOf, seed } from './support.ts';

const RELAY = {
  steps: ['Run to the bandstand and back.'],
  fullPointsWithinSeconds: 60,
  pointsRunOutAtSeconds: 180,
  finishCode: 'KESTREL',
};

async function playing(config: JsonObject): Promise<{
  app: RunningApp;
  post: (path: string, body?: unknown) => Promise<Answer>;
}> {
  const db = new FakeDatabase();
  seed(db, { gate: { type: 'timed-challenge', config, allowPartialCredit: true } });
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

describe('a timed challenge mission in a run', () => {
  test('is timed by the server, and a fast finish earns full points', async () => {
    const { app, post } = await playing(RELAY);
    try {
      assert.equal((await post('attempts')).status, 201);
      const answer = await post('submissions', { payload: { done: true, code: 'kestrel' } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['progress'], 1);
      const detail = verdict['detail'] as Record<string, unknown>;
      assert.equal(typeof detail['elapsedSeconds'], 'number');
      assert.ok((detail['elapsedSeconds'] as number) < 60);
      assert.equal(missionIn(answer)['state'], 'complete');

      const reasons = scoreOf(answer).events.map((event) => event['reason']);
      assert.ok(reasons.includes('mission-complete'));
      assert.ok(!reasons.includes('partial-credit'));
    } finally {
      await app.close();
    }
  });

  test('keeps the clock running on a wrong finish code', async () => {
    const { app, post } = await playing(RELAY);
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { done: true, code: 'falcon' } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'incorrect');
      assert.notEqual(missionIn(answer)['state'], 'complete');
    } finally {
      await app.close();
    }
  });

  test('refuses a time the phone sends of its own', async () => {
    const { app, post } = await playing(RELAY);
    try {
      await post('attempts');
      const answer = await post('submissions', {
        payload: { done: true, code: 'kestrel', elapsedSeconds: 1 },
      });
      assert.equal(refusalOf(answer), 'invalid-submission');
    } finally {
      await app.close();
    }
  });
});
