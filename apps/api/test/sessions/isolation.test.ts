/**
 * Who may touch a run, and whose run they may touch (EXPD-019).
 *
 * Two promises, and neither of them is the handler's. One school cannot see
 * or stop another school's lesson, whatever id it guesses. And the three
 * permissions EXPD-004 wrote for running a class — `session:read`,
 * `session:write`, `session:control` — really are three: a role that holds
 * one does not thereby hold the others, and a student's phone holds none of
 * the ones that matter here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer } from '../http/support.ts';
import {
  as,
  deviceToken,
  EXPEDITION_A,
  EXPEDITION_B,
  harness,
  ORG_A,
  ORG_B,
  RUN_A,
  RUN_B,
  runRow,
  seedExpedition,
  seedRun,
  sessionApp,
  token,
  VERSION_B,
} from './support.ts';

/** Every address this ticket adds, as a method and a path. */
const ROUTES = [
  { method: 'GET', path: `/sessions/${RUN_A}` },
  { method: 'POST', path: `/sessions/${RUN_A}/start` },
  { method: 'POST', path: `/sessions/${RUN_A}/pause` },
  { method: 'POST', path: `/sessions/${RUN_A}/resume` },
  { method: 'POST', path: `/sessions/${RUN_A}/end` },
] as const;

/** Two schools, each with an expedition and a run of it. */
async function bothSchools(): Promise<{
  request: (path: string, init?: RequestInit) => Promise<Answer>;
  db: FakeDatabase;
  close: () => Promise<void>;
}> {
  const db = new FakeDatabase();
  seedExpedition(db, {});
  seedExpedition(db, {
    expeditionId: EXPEDITION_B,
    versionId: VERSION_B,
    organisationId: ORG_B,
  });
  seedRun(db, { status: 'running', startedAt: new Date(Date.now() - 600_000) });
  seedRun(db, {
    sessionId: RUN_B,
    expeditionId: EXPEDITION_B,
    versionId: VERSION_B,
    organisationId: ORG_B,
    joinCode: 'PRT789',
    status: 'running',
    startedAt: new Date(Date.now() - 600_000),
  });

  const app = await listen(sessionApp(db));
  return {
    db,
    request: (path, init) => send(app, path, init ?? {}),
    close: () => app.close(),
  };
}

describe('another school’s run', () => {
  test('is not found, at every address', async () => {
    const both = await bothSchools();
    try {
      for (const route of ROUTES) {
        const answer = await both.request(
          route.path.replace(RUN_A, RUN_B),
          as(token(ORG_A), { method: route.method }),
        );

        assert.equal(answer.status, 404, `${route.method} ${route.path}`);
      }
    } finally {
      await both.close();
    }
  });

  test('is not stopped by the attempt', async () => {
    const both = await bothSchools();
    try {
      await both.request(`/sessions/${RUN_B}/end`, as(token(ORG_A), { method: 'POST' }));

      const row = both.db.rowsIn('expedition_session').find((one) => one['id'] === RUN_B);
      assert.equal(row?.['status'], 'running');
    } finally {
      await both.close();
    }
  });

  test('is not on the list', async () => {
    const both = await bothSchools();
    try {
      const answer = await both.request('/sessions', as(token(ORG_A)));
      const ids = (answer.body['sessions'] as Record<string, unknown>[]).map(
        (one) => one['id'],
      );

      assert.deepEqual(ids, [RUN_A]);
      assert.equal(answer.body['total'], 1);
    } finally {
      await both.close();
    }
  });

  test('cannot have a run made of its expedition', async () => {
    const both = await bothSchools();
    try {
      const answer = await both.request(
        '/sessions',
        as(token(ORG_A), { method: 'POST', body: { expeditionId: EXPEDITION_B } }),
      );

      assert.equal(answer.status, 404);
    } finally {
      await both.close();
    }
  });
});

describe('the three permissions running a class needs', () => {
  test('a facilitator may schedule, control and read', async () => {
    const harnessed = await harness();
    try {
      const bearer = token(ORG_A, { role: 'facilitator' });

      const made = await harnessed.request(
        '/sessions',
        as(bearer, { method: 'POST', body: { expeditionId: EXPEDITION_A } }),
      );
      assert.equal(made.status, 201);

      const id = String(made.body['id']);
      assert.equal(
        (await harnessed.request(`/sessions/${id}/start`, as(bearer, { method: 'POST' })))
          .status,
        200,
      );
    } finally {
      await harnessed.close();
    }
  });

  test('a role with nothing granted may do none of it', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: new Date() });
      const bearer = token(ORG_A, { role: 'org-member' });

      for (const route of ROUTES) {
        const answer = await harnessed.request(
          route.path,
          as(bearer, { method: route.method }),
        );

        assert.equal(answer.status, 403, `${route.method} ${route.path}`);
      }
    } finally {
      await harnessed.close();
    }
  });

  test('no token at all is refused', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: new Date() });

      const answer = await harnessed.request(`/sessions/${RUN_A}/end`, {
        method: 'POST',
      });

      assert.equal(answer.status, 401);
      assert.equal(runRow(harnessed, RUN_A)['status'], 'running');
    } finally {
      await harnessed.close();
    }
  });
});

describe('a student’s phone', () => {
  test('cannot start, pause, resume or end a lesson', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: new Date() });

      for (const route of ROUTES) {
        const answer = await harnessed.request(
          route.path,
          as(deviceToken(ORG_A), { method: route.method }),
        );

        assert.equal(answer.status, 403, `${route.method} ${route.path}`);
      }
    } finally {
      await harnessed.close();
    }
  });

  test('cannot list the school’s runs, though it holds session:read', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: new Date() });

      const answer = await harnessed.request('/sessions', as(deviceToken(ORG_A)));

      assert.equal(answer.status, 403);
    } finally {
      await harnessed.close();
    }
  });

  test('cannot schedule one either', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        '/sessions',
        as(deviceToken(ORG_A), {
          method: 'POST',
          body: { expeditionId: EXPEDITION_A },
        }),
      );

      assert.equal(answer.status, 403);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the two routers on /sessions', () => {
  test('do not take each other’s addresses', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'lobby' });
      const bearer = token(ORG_A);

      const code = await harnessed.request(`/sessions/${RUN_A}/join-code`, as(bearer));
      const teams = await harnessed.request(`/sessions/${RUN_A}/teams`, as(bearer));
      const run = await harnessed.request(`/sessions/${RUN_A}`, as(bearer));

      assert.equal(code.status, 200, 'EXPD-018 still answers its own address');
      assert.equal(teams.status, 200, 'EXPD-018 still answers its own address');
      assert.equal(run.status, 200, 'EXPD-019 answers the run itself');
    } finally {
      await harnessed.close();
    }
  });

  test('a path neither claims is still a 404', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        `/sessions/${RUN_A}/rewind`,
        as(token(ORG_A), { method: 'POST' }),
      );

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });
});
