/**
 * An expedition's board (EXPD-022).
 *
 *   GET /expeditions/:id/leaderboard
 *
 * Every run of one expedition that was played to the end, placed together.
 * Staff only. It puts classes side by side, so no child is named on it at
 * all: a team is its name and the run it played in.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  DEE,
  ELI,
  EXPEDITION_A,
  EXPEDITION_B,
  KINGFISHERS,
  MISSING_ID,
  NEWTS,
  RUN_DONE,
  RUN_OLD,
  harness,
  phone,
  staff,
  standingsOf,
} from './support.ts';

describe('an expedition\'s board', () => {
  test('places the teams of every run that ended, and no run still going', async () => {
    const h = await harness();
    try {
      const answer = await h.expeditionBoard(staff());
      assert.equal(answer.status, 200);
      assert.equal(answer.body['expeditionId'], EXPEDITION_A);
      assert.equal(answer.body['sessionCount'], 2);
      assert.equal(answer.body['total'], 2);
      assert.equal(answer.body['limit'], 50);

      assert.deepEqual(standingsOf(answer), [
        {
          rank: 1,
          teamId: KINGFISHERS,
          teamName: 'Kingfishers',
          totalScore: 55,
          missionsCompleted: 1,
          hintsUsed: 0,
          failedAttempts: 0,
          finished: true,
          finishSeconds: 1800,
          sessionId: RUN_DONE,
          sessionName: 'Year 5 — Monday',
        },
        {
          rank: 2,
          teamId: NEWTS,
          teamName: 'Newts',
          totalScore: 10,
          missionsCompleted: 0,
          hintsUsed: 0,
          failedAttempts: 0,
          finished: false,
          finishSeconds: null,
          sessionId: RUN_OLD,
          sessionName: 'Year 4 — last term',
        },
      ]);
    } finally {
      await h.close();
    }
  });

  test('names no child', async () => {
    const h = await harness();
    try {
      const answer = await h.expeditionBoard(staff());
      for (const secret of ['Dee', 'Eli', DEE, ELI, 'members']) {
        assert.equal(answer.text.includes(secret), false, `${secret} should not be sent`);
      }
      assert.equal(h.db.statements.some((statement) => statement.text.includes('FROM "participant"')), false);
    } finally {
      await h.close();
    }
  });

  test('uses the tie breaks of the newest revision among the runs', async () => {
    const h = await harness({ tieBreaks: ['earliest-finish'], oldTieBreaks: ['fewest-hints-used'] });
    try {
      assert.deepEqual((await h.expeditionBoard(staff())).body['tieBreaks'], ['earliest-finish']);
    } finally {
      await h.close();
    }
  });

  test('leaves out a run whose revision hides its board', async () => {
    const h = await harness({ oldVisibility: 'hidden' });
    try {
      const answer = await h.expeditionBoard(staff());
      assert.equal(answer.body['sessionCount'], 1);
      assert.deepEqual(standingsOf(answer).map((row) => row['teamId']), [KINGFISHERS]);
    } finally {
      await h.close();
    }
  });

  test('takes a limit, and still says how many teams there are in all', async () => {
    const h = await harness();
    try {
      const answer = await h.expeditionBoard(staff(), EXPEDITION_A, '?limit=1');
      assert.equal(answer.status, 200);
      assert.equal(answer.body['total'], 2);
      assert.equal(answer.body['limit'], 1);
      assert.deepEqual(standingsOf(answer).map((row) => row['teamId']), [KINGFISHERS]);
    } finally {
      await h.close();
    }
  });

  test('refuses a limit out of range', async () => {
    const h = await harness();
    try {
      assert.equal((await h.expeditionBoard(staff(), EXPEDITION_A, '?limit=0')).status, 422);
      assert.equal((await h.expeditionBoard(staff(), EXPEDITION_A, '?limit=201')).status, 422);
    } finally {
      await h.close();
    }
  });
});

describe('who may read it', () => {
  test('a phone may not, even for its own expedition', async () => {
    const h = await harness();
    try {
      const answer = await h.expeditionBoard(phone(ASHA));
      assert.equal(answer.status, 403);
      assert.equal(answer.text.includes('Kingfishers'), false);
    } finally {
      await h.close();
    }
  });

  test('another school\'s expedition is not found', async () => {
    const h = await harness();
    try {
      const answer = await h.expeditionBoard(staff(), EXPEDITION_B);
      assert.equal(answer.status, 404);
      assert.equal(answer.text.includes('Pike'), false);
    } finally {
      await h.close();
    }
  });

  test('an expedition that does not exist is not found', async () => {
    const h = await harness();
    try {
      assert.equal((await h.expeditionBoard(staff(), MISSING_ID)).status, 404);
    } finally {
      await h.close();
    }
  });

  test('a signed-in member with no permissions is refused', async () => {
    const h = await harness();
    try {
      assert.equal((await h.expeditionBoard(staff({ role: 'org-member' }))).status, 403);
    } finally {
      await h.close();
    }
  });
});
