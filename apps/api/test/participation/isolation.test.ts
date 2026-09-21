/**
 * One school cannot reach another's run (EXPD-005, EXPD-018).
 *
 * This ticket has the only read in the API that is not scoped to an
 * organisation — `JoinCodeDirectory`, because a student typing a code has not
 * said which school they are in — so it owes the isolation claim more than
 * the tickets before it did.
 *
 * Two things are tested here. Every staff endpoint answers `404` for another
 * organisation's run, the same as EXPD-017's do. And the one crossing does
 * what it says on the tin: a code finds a run in whichever organisation owns
 * it, everything written afterwards is stamped with that organisation, and a
 * caller who has a code learns nothing about any other run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDatabase } from '../support/fake-database.ts';
import { JoinCodeDirectory } from '../../src/participation/join-code-directory.ts';
import { listen, send } from '../http/support.ts';
import {
  anonymous,
  as,
  CODE_A,
  CODE_B,
  ORG_A,
  ORG_B,
  participationApp,
  RUN_A,
  RUN_B,
  seedRun,
  token,
  VERSION_B,
} from './support.ts';

/** A database with a run in each of the two organisations. */
async function bothSchools() {
  const db = new FakeDatabase();
  seedRun(db);
  seedRun(db, {
    sessionId: RUN_B,
    versionId: VERSION_B,
    organisationId: ORG_B,
    joinCode: CODE_B,
  });

  const app = await listen(participationApp(db));
  return {
    db,
    app,
    request: (path: string, init: RequestInit = {}) => send(app, path, init),
    close: () => app.close(),
  };
}

/** Every staff endpoint, as a method and a path under one run. */
function endpointsFor(sessionId: string): readonly { method: string; path: string }[] {
  const student = '00000000-0000-4000-8000-000000000001';
  return [
    { method: 'GET', path: `/sessions/${sessionId}/join-code` },
    { method: 'POST', path: `/sessions/${sessionId}/join-code` },
    { method: 'GET', path: `/sessions/${sessionId}/teams` },
    { method: 'GET', path: `/sessions/${sessionId}/participants` },
    { method: 'DELETE', path: `/sessions/${sessionId}/participants/${student}/team` },
    { method: 'DELETE', path: `/sessions/${sessionId}/participants/${student}` },
  ];
}

describe('another organisation’s run', () => {
  for (const endpoint of endpointsFor(RUN_B)) {
    test(`${endpoint.method} ${endpoint.path} is 404, not 403`, async () => {
      const both = await bothSchools();
      try {
        const answer = await both.request(
          endpoint.path,
          as(token(ORG_A), { method: endpoint.method }),
        );

        assert.equal(answer.status, 404);
        assert.equal(answer.body['error'], 'not-found');
      } finally {
        await both.close();
      }
    });
  }

  test('cannot be given a team', async () => {
    const both = await bothSchools();
    try {
      const answer = await both.request(
        `/sessions/${RUN_B}/teams`,
        as(token(ORG_A), { method: 'POST', body: { name: 'Red' } }),
      );

      assert.equal(answer.status, 404);
      assert.deepEqual(both.db.rowsIn('team'), []);
    } finally {
      await both.close();
    }
  });

  test('cannot have one of its students moved', async () => {
    const both = await bothSchools();
    try {
      const joined = await both.request(
        '/join',
        anonymous({ joinCode: CODE_B, displayName: 'Robin', deviceId: 'phone-b' }),
      );
      const student = String(
        (joined.body['participant'] as Record<string, unknown>)['id'],
      );

      const team = await both.request(
        `/sessions/${RUN_B}/teams`,
        as(token(ORG_B), { method: 'POST', body: { name: 'Red' } }),
      );

      const answer = await both.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'PUT', body: { teamId: String(team.body['id']) } }),
      );

      assert.equal(answer.status, 404);
      assert.deepEqual(both.db.rowsIn('team_member'), []);
    } finally {
      await both.close();
    }
  });
});

describe('a code that belongs to the other school', () => {
  test('finds that school’s run, and says so', async () => {
    const both = await bothSchools();
    try {
      const answer = await both.request(
        '/join',
        anonymous({ joinCode: CODE_B, displayName: 'Robin', deviceId: 'phone-b' }),
      );

      assert.equal(answer.status, 201);
      assert.equal(answer.body['organisationId'], ORG_B);
      assert.equal((answer.body['session'] as Record<string, unknown>)['id'], RUN_B);
    } finally {
      await both.close();
    }
  });

  test('writes every row into that school, and not the other', async () => {
    const both = await bothSchools();
    try {
      await both.request(
        '/join',
        anonymous({ joinCode: CODE_B, displayName: 'Robin', deviceId: 'phone-b' }),
      );

      for (const table of ['participant', 'participant_device']) {
        const organisations = both.db
          .rowsIn(table)
          .map((row) => row['organisation_id']);

        assert.deepEqual(organisations, [ORG_B], `${table} was written into ${ORG_A}`);
      }
    } finally {
      await both.close();
    }
  });

  test('leaves the student unreadable to the other school’s staff', async () => {
    const both = await bothSchools();
    try {
      await both.request(
        '/join',
        anonymous({ joinCode: CODE_B, displayName: 'Robin', deviceId: 'phone-b' }),
      );

      const answer = await both.request(
        `/sessions/${RUN_A}/participants`,
        as(token(ORG_A)),
      );

      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body['participants'], []);
    } finally {
      await both.close();
    }
  });
});

describe('the one read that is not scoped to an organisation', () => {
  test('gives back the run and the organisation, and nothing else', async () => {
    const db = new FakeDatabase();
    seedRun(db);

    const match = await new JoinCodeDirectory(db).findJoinableSession(CODE_A, {
      reason: 'test',
    });

    assert.deepEqual(match, {
      expeditionSessionId: RUN_A,
      organisationId: ORG_A,
    });
  });

  test('reads two columns, so a code cannot be used to read a run', async () => {
    const db = new FakeDatabase();
    seedRun(db);
    await new JoinCodeDirectory(db).findJoinableSession(CODE_A, { reason: 'test' });

    assert.equal(
      db.lastStatement.text,
      'SELECT "id", "organisation_id" FROM "expedition_session"' +
        ' WHERE "join_code" = $1 AND "status" IN ($2, $3, $4, $5) LIMIT $6',
    );
  });

  test('binds the code rather than writing it into the statement', async () => {
    const db = new FakeDatabase();
    seedRun(db);
    await new JoinCodeDirectory(db).findJoinableSession(CODE_A, { reason: 'test' });

    assert.equal(db.lastStatement.values[0], CODE_A);
    assert.ok(!db.lastStatement.text.includes(CODE_A));
  });

  test('does not see a run that has ended', async () => {
    const db = new FakeDatabase();
    seedRun(db, { status: 'ended' });

    const match = await new JoinCodeDirectory(db).findJoinableSession(CODE_A, {
      reason: 'test',
    });

    assert.equal(match, null);
  });

  test('sees a run in every state a student could still be joining', async () => {
    for (const status of ['scheduled', 'lobby', 'running', 'paused']) {
      const db = new FakeDatabase();
      seedRun(db, { status });

      const match = await new JoinCodeDirectory(db).findJoinableSession(CODE_A, {
        reason: 'test',
      });

      assert.notEqual(match, null, `a ${status} run should be joinable`);
    }
  });

  test('answers a yes or a no when asked whether a code is free', async () => {
    const db = new FakeDatabase();
    seedRun(db);
    const directory = new JoinCodeDirectory(db);

    assert.equal(await directory.isJoinCodeTaken(CODE_A, { reason: 'test' }), true);
    assert.equal(await directory.isJoinCodeTaken('WXY234', { reason: 'test' }), false);
  });
});
