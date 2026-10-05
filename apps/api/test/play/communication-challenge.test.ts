/**
 * Playing a communication challenge through the API (EXPD-038).
 *
 * Asha and Ben are on Red, and Asha joined first. Each phone reads its own
 * share with `GET .../part`, and never the other's.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '@explorer/shared-types';

import { communicationChallenge } from '../../src/mission-types/platform/index.ts';
import { send } from '../http/support.ts';
import {
  ASHA,
  BEN,
  RUN_A,
  harness,
  missionIn,
  phone,
  refusalOf,
  staff,
  type Harness,
} from './support.ts';

const RADIO_RESCUE = {
  pattern: 'radio-rescue',
  parts: [
    { heading: 'Bearing', text: 'Due north of the bandstand.' },
    { heading: 'Landmark', text: 'Beside the tallest oak.' },
  ],
  answerType: 'text',
  acceptedAnswers: ['the tallest oak'],
};

const BLIND_ROVER = {
  pattern: 'blind-rover',
  parts: [{ heading: 'The route', text: 'Ten paces, then left.', role: 'navigator' }],
  answerType: 'text',
  acceptedAnswers: ['HERON'],
};

async function playing(config: JsonObject): Promise<Harness> {
  return harness({
    gate: { type: 'communication-challenge', config },
    missionTypes: [communicationChallenge],
  });
}

function part(h: Harness, bearer: string, mission = 'gate') {
  return send(h.app, `/sessions/${RUN_A}/missions/${mission}/part`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe('a communication challenge in a run', () => {
  test('shows each player their own part, and not their teammate’s', async () => {
    const h = await playing(RADIO_RESCUE);
    try {
      await h.start(phone(ASHA), 'gate');

      const asha = await part(h, phone(ASHA));
      assert.equal(asha.status, 200);
      assert.equal(asha.body['pattern'], 'radio-rescue');
      assert.deepEqual(asha.body['parts'], [
        { index: 0, heading: 'Bearing', text: 'Due north of the bandstand.', showForSeconds: null },
      ]);
      assert.doesNotMatch(JSON.stringify(asha.body), /oak/i);

      const ben = await part(h, phone(BEN));
      assert.deepEqual(
        (ben.body['parts'] as JsonObject[]).map((p) => p['heading']),
        ['Landmark'],
      );
      assert.doesNotMatch(JSON.stringify(ben.body), /bandstand/);
    } finally {
      await h.close();
    }
  });

  test('deals a role’s part to the player who holds it, and the rover sees nothing', async () => {
    const h = await playing(BLIND_ROVER);
    try {
      await h.db.query(
        'UPDATE "team_member" SET "role" = $1 WHERE "id" = $2 RETURNING *',
        ['navigator', `member-${BEN}`],
      );
      await h.start(phone(ASHA), 'gate');

      const ben = await part(h, phone(BEN));
      assert.equal(ben.body['role'], 'navigator');
      assert.deepEqual(
        (ben.body['parts'] as JsonObject[]).map((p) => p['heading']),
        ['The route'],
      );
      const asha = await part(h, phone(ASHA));
      assert.deepEqual(asha.body['parts'], []);
    } finally {
      await h.close();
    }
  });

  test('shows nothing until the mission is opened', async () => {
    const h = await playing(RADIO_RESCUE);
    try {
      const answer = await part(h, phone(ASHA));
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'mission-not-running');
    } finally {
      await h.close();
    }
  });

  test('has no parts for another type of mission', async () => {
    const h = await playing(RADIO_RESCUE);
    try {
      assert.equal(refusalOf(await part(h, phone(ASHA), 'photo')), 'no-parts');
    } finally {
      await h.close();
    }
  });

  test('is a phone’s to read, not a teacher’s', async () => {
    const h = await playing(RADIO_RESCUE);
    try {
      await h.start(phone(ASHA), 'gate');
      assert.equal((await part(h, staff())).status, 403);
    } finally {
      await h.close();
    }
  });

  test('is finished by the answer the team put together', async () => {
    const h = await playing(RADIO_RESCUE);
    try {
      await h.start(phone(ASHA), 'gate');
      const wrong = await h.submit(phone(BEN), 'gate', { payload: { answer: 'the bandstand' } });
      assert.equal((wrong.body['verdict'] as JsonObject)['outcome'], 'incorrect');

      await h.start(phone(ASHA), 'gate');
      const right = await h.submit(phone(BEN), 'gate', { payload: { answer: 'The tallest oak' } });
      assert.equal(right.status, 201);
      assert.equal(missionIn(right)['state'], 'complete');
    } finally {
      await h.close();
    }
  });
});
