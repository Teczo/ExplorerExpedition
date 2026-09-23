/**
 * One run's board (EXPD-022).
 *
 *   GET /sessions/:id/leaderboard
 *
 * What it promises: the teams in the run, placed; display names and nothing
 * else about a child; each phone its own run's board and no other; and the
 * revision's `visibility` decides who sees it when.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  CAL,
  DEE,
  DEVICE_ID,
  FAY,
  HERONS,
  KINGFISHERS,
  MISSING_ID,
  ORG_B,
  OTTERS,
  RIA,
  RUN_B,
  RUN_DONE,
  RUN_LIVE,
  VOLES,
  harness,
  phone,
  staff,
  standingsOf,
} from './support.ts';

describe('a run\'s board', () => {
  test('places the teams, with the figures they were placed on', async () => {
    const h = await harness({ tieBreaks: ['most-missions-completed'] });
    try {
      const answer = await h.sessionBoard(staff());
      assert.equal(answer.status, 200);
      assert.equal(answer.body['sessionId'], RUN_LIVE);
      assert.equal(answer.body['sessionName'], 'Year 6 — Tuesday');
      assert.equal(answer.body['sessionStatus'], 'running');
      assert.equal(answer.body['visibility'], 'live');
      assert.deepEqual(answer.body['tieBreaks'], ['most-missions-completed']);
      assert.equal(answer.body['final'], false);
      assert.equal(answer.body['shown'], true);
      assert.equal(typeof answer.body['generatedAt'], 'string');

      assert.deepEqual(standingsOf(answer), [
        {
          rank: 1,
          teamId: OTTERS,
          teamName: 'Otters',
          totalScore: 40,
          missionsCompleted: 2,
          hintsUsed: 2,
          failedAttempts: 1,
          finished: true,
          finishSeconds: 1200,
          members: ['Asha', 'Ben'],
        },
        {
          rank: 2,
          teamId: HERONS,
          teamName: 'Herons',
          totalScore: 40,
          missionsCompleted: 1,
          hintsUsed: 0,
          failedAttempts: 3,
          finished: true,
          finishSeconds: 900,
          members: ['Cal'],
        },
      ]);
    } finally {
      await h.close();
    }
  });

  test('uses the tie breaks of the revision the run is pinned to', async () => {
    const cases = [
      [['earliest-finish'], HERONS],
      [['most-missions-completed'], OTTERS],
      [['fewest-hints-used'], HERONS],
      [['fewest-failed-attempts'], OTTERS],
    ] as const;
    for (const [tieBreaks, first] of cases) {
      const h = await harness({ tieBreaks: [...tieBreaks] });
      try {
        const standings = standingsOf(await h.sessionBoard(staff()));
        assert.equal(standings[0]?.['teamId'], first, `with ${tieBreaks[0]}`);
        assert.equal(standings[1]?.['rank'], 2);
      } finally {
        await h.close();
      }
    }
  });

  test('with no tie breaks, a level total is a shared place', async () => {
    const h = await harness({ tieBreaks: [] });
    try {
      const standings = standingsOf(await h.sessionBoard(staff()));
      assert.deepEqual(
        standings.map((row) => [row['rank'], row['teamName']]),
        [[1, 'Herons'], [1, 'Otters']],
      );
    } finally {
      await h.close();
    }
  });

  test('leaves out a withdrawn team', async () => {
    const h = await harness();
    try {
      const ids = standingsOf(await h.sessionBoard(staff())).map((row) => row['teamId']);
      assert.equal(ids.includes(VOLES), false);
    } finally {
      await h.close();
    }
  });

  test('a run that is over is marked final', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(staff(), RUN_DONE);
      assert.equal(answer.status, 200);
      assert.equal(answer.body['final'], true);
      assert.deepEqual(standingsOf(answer).map((row) => row['teamId']), [KINGFISHERS]);
    } finally {
      await h.close();
    }
  });
});

describe('display names only', () => {
  test('a member is a display name, and nothing else about a child is sent', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(phone(ASHA));
      assert.equal(answer.status, 200);
      for (const row of standingsOf(answer)) {
        for (const member of row['members'] as unknown[]) {
          assert.equal(typeof member, 'string');
        }
      }
      // No participant id, device, role or leader flag appears anywhere.
      for (const secret of [ASHA, CAL, DEVICE_ID, 'navigator', 'isLeader', 'participantId', 'deviceId', 'userId']) {
        assert.equal(answer.text.includes(secret), false, `${secret} should not be sent`);
      }
    } finally {
      await h.close();
    }
  });

  test('a student taken out of the run is not listed', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(staff());
      assert.equal(answer.text.includes('Fay'), false);
      assert.equal(answer.text.includes(FAY), false);
    } finally {
      await h.close();
    }
  });

  test('the only read of a participant row asks for the name and the status', async () => {
    const h = await harness();
    try {
      h.db.forgetStatements();
      await h.sessionBoard(staff());
      const reads = h.db.statements.filter((statement) => statement.text.includes('FROM "participant"'));
      assert.equal(reads.length, 1);
      assert.match(reads[0]?.text ?? '', /^SELECT "id", "display_name", "status" FROM "participant"/);
    } finally {
      await h.close();
    }
  });
});

describe('who may read which board', () => {
  test('a phone reads its own run\'s board', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(phone(CAL));
      assert.equal(answer.status, 200);
      assert.equal(standingsOf(answer).length, 2);
    } finally {
      await h.close();
    }
  });

  test('a phone cannot read another run\'s board, even in its own school', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(phone(ASHA), RUN_DONE);
      assert.equal(answer.status, 404);
      assert.equal(answer.text.includes('Kingfishers'), false);
    } finally {
      await h.close();
    }
  });

  test('another school\'s run is not found, for staff and for a phone', async () => {
    const h = await harness();
    try {
      const byStaff = await h.sessionBoard(staff(), RUN_B);
      assert.equal(byStaff.status, 404);
      assert.equal(byStaff.text.includes('Pike'), false);

      // A token for the right run, signed for the wrong school.
      const byPhone = await h.sessionBoard(phone(RIA, RUN_B), RUN_B);
      assert.equal(byPhone.status, 404);
    } finally {
      await h.close();
    }
  });

  test('Riverbank\'s own staff read Riverbank\'s board', async () => {
    const h = await harness();
    try {
      const answer = await h.sessionBoard(staff({ organisationId: ORG_B }), RUN_B);
      assert.equal(answer.status, 200);
      assert.deepEqual(standingsOf(answer).map((row) => row['teamName']), ['Pike']);
    } finally {
      await h.close();
    }
  });

  test('a run that does not exist is not found', async () => {
    const h = await harness();
    try {
      assert.equal((await h.sessionBoard(staff(), MISSING_ID)).status, 404);
    } finally {
      await h.close();
    }
  });

  test('no token is refused', async () => {
    const h = await harness();
    try {
      assert.equal((await h.sessionBoard('')).status, 401);
    } finally {
      await h.close();
    }
  });

  test('a signed-in member with no permissions is refused', async () => {
    const h = await harness();
    try {
      assert.equal((await h.sessionBoard(staff({ role: 'org-member' }))).status, 403);
    } finally {
      await h.close();
    }
  });

  test('a run id that is not an id is refused before anything is read', async () => {
    const h = await harness();
    try {
      assert.equal((await h.sessionBoard(staff(), 'not-an-id')).status, 422);
    } finally {
      await h.close();
    }
  });
});

describe('visibility', () => {
  /** [visibility, reader, run, shown] */
  const cases = [
    ['live', 'staff', RUN_LIVE, true],
    ['live', 'phone', RUN_LIVE, true],
    ['teacher-only', 'staff', RUN_LIVE, true],
    ['teacher-only', 'phone', RUN_LIVE, false],
    ['teacher-only', 'phone', RUN_DONE, true],
    ['final-only', 'staff', RUN_LIVE, false],
    ['final-only', 'phone', RUN_LIVE, false],
    ['final-only', 'staff', RUN_DONE, true],
    ['final-only', 'phone', RUN_DONE, true],
    ['hidden', 'staff', RUN_LIVE, false],
    ['hidden', 'staff', RUN_DONE, false],
    ['hidden', 'phone', RUN_DONE, false],
  ] as const;

  for (const [visibility, reader, runId, shown] of cases) {
    const when = runId === RUN_DONE ? 'after the run' : 'during the run';
    test(`${visibility}: a ${reader} ${shown ? 'sees' : 'does not see'} the board ${when}`, async () => {
      const h = await harness({ visibility });
      try {
        const bearer = reader === 'staff' ? staff() : phone(runId === RUN_DONE ? DEE : ASHA, runId);
        const answer = await h.sessionBoard(bearer, runId);
        assert.equal(answer.status, 200);
        assert.equal(answer.body['visibility'], visibility);
        assert.equal(answer.body['shown'], shown);
        if (shown) {
          assert.ok(standingsOf(answer).length > 0);
        } else {
          assert.deepEqual(standingsOf(answer), []);
          assert.equal(answer.text.includes('Otters'), false);
          assert.equal(answer.text.includes('Kingfishers'), false);
        }
      } finally {
        await h.close();
      }
    });
  }

  test('a board that cannot be shown reads no team at all', async () => {
    const h = await harness({ visibility: 'hidden' });
    try {
      h.db.forgetStatements();
      await h.sessionBoard(staff());
      assert.equal(h.db.statements.some((statement) => statement.text.includes('FROM "team"')), false);
    } finally {
      await h.close();
    }
  });
});
