/**
 * Typing a code (EXPD-018).
 *
 * The one endpoint in the API with no token in front of it, so these tests
 * are about what stands in its place: six right characters, and nothing else
 * gets in. They also cover the thing that makes the endpoint usable in a
 * classroom — a phone that closes the app and comes back is the same student,
 * not a second one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonymous,
  as,
  CODE_A,
  harness,
  join,
  ORG_A,
  participantIdOf,
  RUN_A,
  token,
} from './support.ts';

describe('joining a run with the code on the whiteboard', () => {
  test('answers 201 with the run, the student and a device token', async () => {
    const harnessed = await harness();
    try {
      const answer = await join(harnessed);

      assert.equal(answer.status, 201);
      assert.equal(
        (answer.body['session'] as Record<string, unknown>)['id'],
        RUN_A,
      );
      assert.equal(answer.body['organisationId'], ORG_A);
      assert.equal(
        (answer.body['participant'] as Record<string, unknown>)['displayName'],
        'Sam',
      );
      assert.equal(typeof answer.body['deviceToken'], 'string');
      assert.ok(String(answer.body['deviceToken']).length > 20);
    } finally {
      await harnessed.close();
    }
  });

  test('puts the student in the run and on no team', async () => {
    const harnessed = await harness();
    try {
      const answer = await join(harnessed);
      const participant = answer.body['participant'] as Record<string, unknown>;

      assert.equal(participant['status'], 'joined');
      assert.equal(participant['teamId'], null);
      assert.equal(participant['role'], null);
      assert.equal(answer.body['team'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('writes one participant row, in the run’s own organisation', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed);
      const rows = harnessed.db.rowsIn('participant');

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.['organisation_id'], ORG_A);
      assert.equal(rows[0]?.['expedition_session_id'], RUN_A);
      assert.equal(rows[0]?.['device_id'], 'phone-1');
    } finally {
      await harnessed.close();
    }
  });

  test('hands back a device token the student app can sign in with', async () => {
    const harnessed = await harness();
    try {
      const joined = await join(harnessed);

      const exchanged = await harnessed.request(
        '/auth/device/token',
        anonymous({
          organisationId: joined.body['organisationId'],
          deviceToken: joined.body['deviceToken'],
        }),
      );

      assert.equal(exchanged.status, 200);
      assert.equal(exchanged.body['participantId'], participantIdOf(joined));
      assert.equal(exchanged.body['expeditionSessionId'], RUN_A);
    } finally {
      await harnessed.close();
    }
  });

  test('reads a code typed in lower case, with a hyphen in it', async () => {
    const harnessed = await harness();
    try {
      const answer = await join(harnessed, { joinCode: ' hj4-kmn ' });

      assert.equal(answer.status, 201);
    } finally {
      await harnessed.close();
    }
  });

  test('reads a zero somebody typed for the D they were looking at', async () => {
    const harnessed = await harness({ joinCode: 'DDJ456' });
    try {
      const answer = await join(harnessed, { joinCode: '00j456' });

      assert.equal(answer.status, 201);
    } finally {
      await harnessed.close();
    }
  });
});

describe('a code that reaches nothing', () => {
  test('is 404, not 422, when it is not a code at all', async () => {
    const harnessed = await harness();
    try {
      const answer = await join(harnessed, { joinCode: '@@@@@@' });

      assert.equal(answer.status, 404);
      assert.equal(answer.body['error'], 'not-found');
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 when no run is using it', async () => {
    const harnessed = await harness();
    try {
      assert.equal((await join(harnessed, { joinCode: 'WXY234' })).status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 once the run it belonged to has ended', async () => {
    const harnessed = await harness({ status: 'ended' });
    try {
      assert.equal((await join(harnessed)).status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('is refused before a body is read, so nothing is written', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed, { joinCode: 'WXY234' });

      assert.deepEqual(harnessed.db.rowsIn('participant'), []);
      assert.deepEqual(harnessed.db.rowsIn('participant_device'), []);
    } finally {
      await harnessed.close();
    }
  });

  test('says what is missing when the body is short of a name', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        '/join',
        anonymous({ joinCode: CODE_A, deviceId: 'phone-1' }),
      );

      assert.equal(answer.status, 422);
      assert.deepEqual(
        (answer.body['details'] as { path: string }[]).map((issue) => issue.path),
        ['displayName'],
      );
    } finally {
      await harnessed.close();
    }
  });
});

describe('a phone that comes back', () => {
  test('is the same student, not a second one', async () => {
    const harnessed = await harness();
    try {
      const first = await join(harnessed);
      const again = await join(harnessed);

      assert.equal(participantIdOf(again), participantIdOf(first));
      assert.equal(harnessed.db.rowsIn('participant').length, 1);
    } finally {
      await harnessed.close();
    }
  });

  test('can fix the name it typed the first time', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed, { displayName: 'Sam' });
      const again = await join(harnessed, { displayName: 'Sammy' });

      assert.equal(
        (again.body['participant'] as Record<string, unknown>)['displayName'],
        'Sammy',
      );
    } finally {
      await harnessed.close();
    }
  });

  test('gets a fresh token, and the old one stops working', async () => {
    const harnessed = await harness();
    try {
      const first = await join(harnessed);
      const again = await join(harnessed);

      assert.notEqual(again.body['deviceToken'], first.body['deviceToken']);

      const stale = await harnessed.request(
        '/auth/device/token',
        anonymous({
          organisationId: ORG_A,
          deviceToken: first.body['deviceToken'],
        }),
      );
      assert.equal(stale.status, 401);
    } finally {
      await harnessed.close();
    }
  });

  test('comes back beside the student on the other phone, not over them', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed, { deviceId: 'phone-1', displayName: 'Sam' });
      await join(harnessed, { deviceId: 'phone-2', displayName: 'Alex' });

      assert.equal(harnessed.db.rowsIn('participant').length, 2);
    } finally {
      await harnessed.close();
    }
  });

  test('is refused with 409 once a teacher has removed it', async () => {
    const harnessed = await harness();
    try {
      const joined = await join(harnessed);
      await harnessed.request(
        `/sessions/${RUN_A}/participants/${participantIdOf(joined)}`,
        as(token(ORG_A), { method: 'DELETE' }),
      );

      const again = await join(harnessed);

      assert.equal(again.status, 409);
      assert.equal(again.body['error'], 'conflict');
    } finally {
      await harnessed.close();
    }
  });
});

describe('a run that is full', () => {
  test('refuses the student who would be one too many', async () => {
    const harnessed = await harness({ rules: { maxTeams: 1, size: { min: 1, max: 2 } } });
    try {
      assert.equal((await join(harnessed, { deviceId: 'phone-1' })).status, 201);
      assert.equal((await join(harnessed, { deviceId: 'phone-2' })).status, 201);

      const third = await join(harnessed, { deviceId: 'phone-3' });

      assert.equal(third.status, 409);
      assert.match(String(third.body['message']), /holds 2 students/u);
    } finally {
      await harnessed.close();
    }
  });

  test('has no capacity at all when the expedition caps no teams', async () => {
    const harnessed = await harness({ rules: { maxTeams: null, size: { min: 1, max: 1 } } });
    try {
      for (const phone of ['phone-1', 'phone-2', 'phone-3', 'phone-4']) {
        assert.equal((await join(harnessed, { deviceId: phone })).status, 201);
      }
    } finally {
      await harnessed.close();
    }
  });

  test('lets somebody in again once a place has been given up', async () => {
    const harnessed = await harness({ rules: { maxTeams: 1, size: { min: 1, max: 1 } } });
    try {
      const first = await join(harnessed, { deviceId: 'phone-1' });
      assert.equal((await join(harnessed, { deviceId: 'phone-2' })).status, 409);

      await harnessed.request(
        `/sessions/${RUN_A}/participants/${participantIdOf(first)}`,
        as(token(ORG_A), { method: 'DELETE' }),
      );

      assert.equal((await join(harnessed, { deviceId: 'phone-2' })).status, 201);
    } finally {
      await harnessed.close();
    }
  });
});
