/**
 * Making teams, and the code on the whiteboard (EXPD-018).
 *
 * Both are the teacher's side of the ticket, and both are held to the same
 * two things: the limits come from the expedition the run is pinned to, and
 * the endpoints answer to the permission the role really holds rather than to
 * the role's name.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonymous,
  as,
  CODE_A,
  createTeam,
  harness,
  join,
  MISSING_ID,
  ORG_A,
  RUN_A,
  token,
} from './support.ts';

describe('adding a team', () => {
  test('answers 201 with an empty team and where to find it', async () => {
    const harnessed = await harness();
    try {
      const answer = await createTeam(harnessed, 'Red');

      assert.equal(answer.status, 201);
      assert.equal(answer.body['name'], 'Red');
      assert.equal(answer.body['status'], 'forming');
      assert.equal(answer.body['memberCount'], 0);
      assert.deepEqual(answer.body['members'], []);
      assert.match(
        answer.headers.get('location') ?? '',
        new RegExp(`^/sessions/${RUN_A}/teams/`, 'u'),
      );
    } finally {
      await harnessed.close();
    }
  });

  test('says how many more students it can take', async () => {
    const harnessed = await harness({ rules: { size: { min: 2, max: 4 } } });
    try {
      assert.equal((await createTeam(harnessed, 'Red')).body['placesLeft'], 4);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a second team with the same name', async () => {
    const harnessed = await harness();
    try {
      await createTeam(harnessed, 'Red');
      const again = await createTeam(harnessed, 'Red');

      assert.equal(again.status, 409);
      assert.equal(harnessed.db.rowsIn('team').length, 1);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a team past the number the expedition allows', async () => {
    const harnessed = await harness({ rules: { maxTeams: 2 } });
    try {
      assert.equal((await createTeam(harnessed, 'Red')).status, 201);
      assert.equal((await createTeam(harnessed, 'Blue')).status, 201);

      const third = await createTeam(harnessed, 'Green');

      assert.equal(third.status, 409);
      assert.match(String(third.body['message']), /allows 2 teams/u);
      assert.equal(harnessed.db.rowsIn('team').length, 2);
    } finally {
      await harnessed.close();
    }
  });

  test('allows as many as anybody likes when the expedition caps none', async () => {
    const harnessed = await harness({ rules: { maxTeams: null } });
    try {
      for (const name of ['Red', 'Blue', 'Green', 'Yellow', 'Orange']) {
        assert.equal((await createTeam(harnessed, name)).status, 201);
      }
    } finally {
      await harnessed.close();
    }
  });

  test('refuses an empty name', async () => {
    const harnessed = await harness();
    try {
      const answer = await createTeam(harnessed, '   ');

      assert.equal(answer.status, 422);
      assert.deepEqual(
        (answer.body['details'] as { path: string }[]).map((issue) => issue.path),
        ['name'],
      );
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 for a run this organisation does not have', async () => {
    const harnessed = await harness();
    try {
      const answer = await createTeam(harnessed, 'Red', { sessionId: MISSING_ID });

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the team sheet', () => {
  test('carries the run, the limits and every team', async () => {
    const harnessed = await harness({ rules: { maxTeams: 3, size: { min: 2, max: 3 } } });
    try {
      await createTeam(harnessed, 'Red');
      await createTeam(harnessed, 'Blue');

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/teams`,
        as(token(ORG_A)),
      );

      assert.equal(answer.status, 200);
      assert.equal((answer.body['session'] as Record<string, unknown>)['id'], RUN_A);
      assert.deepEqual((answer.body['limits'] as Record<string, unknown>)['size'], {
        min: 2,
        max: 3,
      });
      assert.deepEqual((answer.body['limits'] as Record<string, unknown>)['roles'], [
        'navigator',
        'scribe',
      ]);
      assert.equal(
        (answer.body['limits'] as Record<string, unknown>)['participantCapacity'],
        9,
      );
      assert.equal((answer.body['teams'] as unknown[]).length, 2);
      assert.equal(answer.body['placesLeft'], 1);
    } finally {
      await harnessed.close();
    }
  });

  test('has no places left to report when the expedition caps no teams', async () => {
    const harnessed = await harness({ rules: { maxTeams: null } });
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/teams`,
        as(token(ORG_A)),
      );

      assert.equal(answer.body['placesLeft'], null);
      assert.equal(
        (answer.body['limits'] as Record<string, unknown>)['participantCapacity'],
        null,
      );
    } finally {
      await harnessed.close();
    }
  });
});

describe('everybody in the run', () => {
  test('lists the students, whether or not they are on a team', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed, { deviceId: 'phone-1', displayName: 'Sam' });
      await join(harnessed, { deviceId: 'phone-2', displayName: 'Alex' });

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/participants`,
        as(token(ORG_A)),
      );

      assert.equal(answer.status, 200);
      assert.deepEqual(
        (answer.body['participants'] as Record<string, unknown>[]).map(
          (row) => row['displayName'],
        ),
        ['Sam', 'Alex'],
      );
      assert.equal(answer.body['presentCount'], 2);
    } finally {
      await harnessed.close();
    }
  });
});

describe('who may do any of this', () => {
  test('a facilitator may: running somebody else’s expedition is the job', async () => {
    const harnessed = await harness();
    try {
      const answer = await createTeam(harnessed, 'Red', {
        bearer: token(ORG_A, { role: 'facilitator' }),
      });

      assert.equal(answer.status, 201);
    } finally {
      await harnessed.close();
    }
  });

  test('somebody with no role yet may not', async () => {
    const harnessed = await harness();
    try {
      const answer = await createTeam(harnessed, 'Red', {
        bearer: token(ORG_A, { role: 'org-member' }),
      });

      assert.equal(answer.status, 403);
    } finally {
      await harnessed.close();
    }
  });

  test('a request with no token at all may not', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/teams`,
        anonymous({ name: 'Red' }),
      );

      assert.equal(answer.status, 401);
    } finally {
      await harnessed.close();
    }
  });

  test('a student’s phone may not read the team sheet', async () => {
    const harnessed = await harness();
    try {
      const joined = await join(harnessed);
      const exchanged = await harnessed.request(
        '/auth/device/token',
        anonymous({
          organisationId: ORG_A,
          deviceToken: joined.body['deviceToken'],
        }),
      );

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/teams`,
        as(String(exchanged.body['accessToken'])),
      );

      assert.equal(answer.status, 403);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the code on the whiteboard', () => {
  test('is readable by anybody who may read the run', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/join-code`,
        as(token(ORG_A, { role: 'facilitator' })),
      );

      assert.equal(answer.status, 200);
      assert.equal(answer.body['joinCode'], CODE_A);
      assert.equal(answer.body['joinable'], true);
    } finally {
      await harnessed.close();
    }
  });

  test('can be replaced, and the old one then reaches nothing', async () => {
    const harnessed = await harness();
    try {
      const reissued = await harnessed.request(
        `/sessions/${RUN_A}/join-code`,
        as(token(ORG_A), { method: 'POST' }),
      );

      assert.equal(reissued.status, 200);
      assert.notEqual(reissued.body['joinCode'], CODE_A);

      assert.equal((await join(harnessed, { joinCode: CODE_A })).status, 404);
      assert.equal(
        (await join(harnessed, { joinCode: String(reissued.body['joinCode']) })).status,
        201,
      );
    } finally {
      await harnessed.close();
    }
  });

  test('is not replaced on a run that is over', async () => {
    const harnessed = await harness({ status: 'ended' });
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/join-code`,
        as(token(ORG_A), { method: 'POST' }),
      );

      assert.equal(answer.status, 409);
    } finally {
      await harnessed.close();
    }
  });

  test('says a run that is over cannot be joined', async () => {
    const harnessed = await harness({ status: 'ended' });
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/join-code`,
        as(token(ORG_A)),
      );

      assert.equal(answer.body['joinable'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('is replaced by a facilitator too: session:write is theirs', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/join-code`,
        as(token(ORG_A, { role: 'facilitator' }), { method: 'POST' }),
      );

      assert.equal(answer.status, 200);
    } finally {
      await harnessed.close();
    }
  });
});
