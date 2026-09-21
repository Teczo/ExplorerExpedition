/**
 * Putting students on teams, and giving them something to do (EXPD-018).
 *
 * One endpoint does both, because a role belongs to a membership and not to a
 * student: `PUT .../team` is the whole membership, so calling it again with a
 * different role changes the role and leaves the team alone.
 *
 * The two limits the ticket promises are here as well. A team cannot take
 * more students than the expedition allows, and a student is on one team at a
 * time — which is a claim about the stored rows and not only about the
 * answer, so most of these tests look at both.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  as,
  createTeam,
  harness,
  join,
  MISSING_ID,
  ORG_A,
  participantIdOf,
  RUN_A,
  token,
  type Harness,
} from './support.ts';
import type { FakeRow } from '../support/fake-database.ts';

/** Puts a student on a team, the way a teacher's browser does. */
async function assign(
  harnessed: Harness,
  participantId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return harnessed.request(
    `/sessions/${RUN_A}/participants/${participantId}/team`,
    as(token(ORG_A), { method: 'PUT', body }),
  );
}

/** The memberships that have not ended. */
function liveMemberships(harnessed: Harness): readonly FakeRow[] {
  return harnessed.db
    .rowsIn('team_member')
    .filter((row) => (row['left_at'] ?? null) === null);
}

describe('putting a student on a team', () => {
  test('answers with the student, now on it', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, student, { teamId: team });

      assert.equal(answer.status, 200);
      assert.equal(answer.body['teamId'], team);
      assert.equal(answer.body['role'], null);
      assert.equal(answer.body['isLeader'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('shows them on the team sheet', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed, { displayName: 'Sam' }));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: team });

      const sheet = await harnessed.request(
        `/sessions/${RUN_A}/teams`,
        as(token(ORG_A)),
      );
      const first = (sheet.body['teams'] as Record<string, unknown>[])[0];

      assert.equal(first?.['memberCount'], 1);
      assert.deepEqual(
        (first?.['members'] as Record<string, unknown>[]).map(
          (member) => member['displayName'],
        ),
        ['Sam'],
      );
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 for a team in another run', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));

      const answer = await assign(harnessed, student, { teamId: MISSING_ID });

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 for a student who is not in this run', async () => {
    const harnessed = await harness();
    try {
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, MISSING_ID, { teamId: team });

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses the student who would be one too many', async () => {
    const harnessed = await harness({ rules: { size: { min: 1, max: 2 } } });
    try {
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      for (const phone of ['phone-1', 'phone-2']) {
        const student = participantIdOf(await join(harnessed, { deviceId: phone }));
        assert.equal((await assign(harnessed, student, { teamId: team })).status, 200);
      }

      const third = participantIdOf(await join(harnessed, { deviceId: 'phone-3' }));
      const answer = await assign(harnessed, third, { teamId: team });

      assert.equal(answer.status, 409);
      assert.match(String(answer.body['message']), /holds 2 students/u);
      assert.equal(liveMemberships(harnessed).length, 2);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the role a student holds on a team', () => {
  test('is one the expedition hands out', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, student, {
        teamId: team,
        role: 'navigator',
      });

      assert.equal(answer.status, 200);
      assert.equal(answer.body['role'], 'navigator');
    } finally {
      await harnessed.close();
    }
  });

  test('is refused, with the list, when it is not one of them', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, student, {
        teamId: team,
        role: 'navigater',
      });

      assert.equal(answer.status, 422);
      assert.deepEqual(answer.body['details'], [
        { path: 'role', message: "This expedition's roles are navigator, scribe." },
      ]);
    } finally {
      await harnessed.close();
    }
  });

  test('is refused at all when the expedition hands out none', async () => {
    const harnessed = await harness({ rules: { roles: [] } });
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, student, {
        teamId: team,
        role: 'navigator',
      });

      assert.equal(answer.status, 422);
      assert.match(String((answer.body['details'] as { message: string }[])[0]?.message), /hands out no roles/u);
    } finally {
      await harnessed.close();
    }
  });

  test('changes without moving the student, because the body is the whole membership', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: team, role: 'navigator' });

      const answer = await assign(harnessed, student, { teamId: team, role: 'scribe' });

      assert.equal(answer.body['role'], 'scribe');
      assert.equal(answer.body['teamId'], team);
      assert.equal(liveMemberships(harnessed).length, 1);
    } finally {
      await harnessed.close();
    }
  });

  test('is taken away by leaving it out, which is what a PUT means', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: team, role: 'navigator' });

      const answer = await assign(harnessed, student, { teamId: team });

      assert.equal(answer.body['role'], null);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the member who speaks for the team', () => {
  test('is named by asking for it', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);

      const answer = await assign(harnessed, student, { teamId: team, isLeader: true });

      assert.equal(answer.body['isLeader'], true);
    } finally {
      await harnessed.close();
    }
  });

  test('is one at a time: naming a second stands the first down', async () => {
    const harnessed = await harness();
    try {
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      const first = participantIdOf(await join(harnessed, { deviceId: 'phone-1' }));
      const second = participantIdOf(await join(harnessed, { deviceId: 'phone-2' }));

      await assign(harnessed, first, { teamId: team, isLeader: true });
      await assign(harnessed, second, { teamId: team, isLeader: true });

      const leaders = liveMemberships(harnessed).filter(
        (row) => row['is_leader'] === true,
      );

      assert.equal(leaders.length, 1);
      assert.equal(leaders[0]?.['participant_id'], second);
    } finally {
      await harnessed.close();
    }
  });
});

describe('moving a student from one team to another', () => {
  test('leaves them on exactly one team', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const red = String((await createTeam(harnessed, 'Red')).body['id']);
      const blue = String((await createTeam(harnessed, 'Blue')).body['id']);

      await assign(harnessed, student, { teamId: red });
      const answer = await assign(harnessed, student, { teamId: blue });

      assert.equal(answer.body['teamId'], blue);
      assert.equal(liveMemberships(harnessed).length, 1);
      assert.equal(liveMemberships(harnessed)[0]?.['team_id'], blue);
    } finally {
      await harnessed.close();
    }
  });

  test('keeps the ended membership, so the run’s history is not rewritten', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const red = String((await createTeam(harnessed, 'Red')).body['id']);
      const blue = String((await createTeam(harnessed, 'Blue')).body['id']);

      await assign(harnessed, student, { teamId: red });
      await assign(harnessed, student, { teamId: blue });

      assert.equal(harnessed.db.rowsIn('team_member').length, 2);
    } finally {
      await harnessed.close();
    }
  });

  test('can send them back to the team they started on', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const red = String((await createTeam(harnessed, 'Red')).body['id']);
      const blue = String((await createTeam(harnessed, 'Blue')).body['id']);

      await assign(harnessed, student, { teamId: red });
      await assign(harnessed, student, { teamId: blue });
      const back = await assign(harnessed, student, { teamId: red });

      assert.equal(back.status, 200);
      assert.equal(back.body['teamId'], red);
      assert.equal(liveMemberships(harnessed).length, 1);
      // Still two rows: the one they came back to was reused, because
      // `UNIQUE (team_id, participant_id)` would refuse a second.
      assert.equal(harnessed.db.rowsIn('team_member').length, 2);
    } finally {
      await harnessed.close();
    }
  });

  test('is refused when the team they are moving to is full', async () => {
    const harnessed = await harness({ rules: { size: { min: 1, max: 1 } } });
    try {
      const red = String((await createTeam(harnessed, 'Red')).body['id']);
      const blue = String((await createTeam(harnessed, 'Blue')).body['id']);
      const first = participantIdOf(await join(harnessed, { deviceId: 'phone-1' }));
      const second = participantIdOf(await join(harnessed, { deviceId: 'phone-2' }));

      await assign(harnessed, first, { teamId: red });
      await assign(harnessed, second, { teamId: blue });

      const answer = await assign(harnessed, second, { teamId: red });

      assert.equal(answer.status, 409);
      // And they are still where they were, rather than on neither team.
      assert.equal(liveMemberships(harnessed).length, 2);
    } finally {
      await harnessed.close();
    }
  });
});

describe('taking a student off their team', () => {
  test('leaves them in the run, on no team', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: team });

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'DELETE' }),
      );

      assert.equal(answer.status, 200);
      assert.equal(answer.body['teamId'], null);
      assert.equal(answer.body['status'], 'joined');
      assert.equal(liveMemberships(harnessed).length, 0);
    } finally {
      await harnessed.close();
    }
  });

  test('is 409 when they were not on one', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'DELETE' }),
      );

      assert.equal(answer.status, 409);
    } finally {
      await harnessed.close();
    }
  });
});

describe('the record of who moved whom', () => {
  test('names the teacher, the student and both teams', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const red = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: red, role: 'navigator' });

      const entries = harnessed.db
        .rowsIn('audit_log')
        .filter((row) => row['action'] === 'participant.team-changed');

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['entity_type'], 'participant');
      assert.equal(entries[0]?.['entity_id'], student);
      assert.equal(entries[0]?.['actor_kind'], 'user');
      // `is_leader` is on neither side: EXPD-006 records the columns that
      // moved, and it was false before and false after.
      const changes = entries[0]?.['changes'] as Record<string, unknown>;
      assert.deepEqual(changes['before'], { team_id: null, role: null });
      assert.deepEqual(changes['after'], { team_id: red, role: 'navigator' });
    } finally {
      await harnessed.close();
    }
  });

  test('is written for taking somebody off a team as well', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await assign(harnessed, student, { teamId: team });
      await harnessed.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'DELETE' }),
      );

      const entries = harnessed.db
        .rowsIn('audit_log')
        .filter((row) => row['action'] === 'participant.team-changed');

      assert.equal(entries.length, 2);
    } finally {
      await harnessed.close();
    }
  });
});
