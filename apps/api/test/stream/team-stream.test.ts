/**
 * Appending to a team's stream, and reading it back (EXPD-014).
 *
 * `TeamStream` is built on a `TenantRepository`, so the isolation it inherits
 * is proved by EXPD-005 and is not re-proved here. What is proved here is what
 * the class itself decides: that a line takes the next number in its team's
 * stream across both tables, that the seal chains, that the head on `team` is
 * kept in step, that a stream read back out of rows is the one the engine
 * sealed, and that there is no way to change a line once it is written.
 *
 * The last of those is about something that is not there. There is no method
 * that edits a line and no method that removes one, and that is not an
 * omission to be fixed later — it is the ticket.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replayStream, verifyStream } from '@explorer/engine';
import {
  GENESIS_HASH,
  toId,
  type MissionInstanceId,
  type NodeId,
  type ProgressionEvent,
  type ScoreEvent,
} from '@explorer/shared-types';

import { inTransaction } from '../../src/db/queryable.ts';
import { AppendOnlyTableError } from '../../src/db/errors.ts';
import {
  TeamStream,
  UnlockedStreamAppendError,
  UnknownTeamError,
  teamStream,
} from '../../src/stream/team-stream.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { ORG_A, ORG_B, tenantFor } from '../support/organisations.ts';

const TEAM = '66666666-6666-4666-8666-666666666666';
const SESSION = '77777777-7777-4777-8777-777777777777';
const alpha = toId<'missionInstance'>('alpha') as MissionInstanceId;
const start = toId<'node'>('start') as NodeId;

/** A database with one team in it, and nothing written yet. */
function withTeam(organisationId = ORG_A): FakeDatabase {
  const db = new FakeDatabase();
  db.seed('team', {
    id: TEAM,
    organisation_id: organisationId,
    expedition_session_id: SESSION,
    name: 'Reds',
    total_score: 0,
    stream_length: 0,
    stream_head_hash: null,
  });
  return db;
}

/** That team's stream, for Portside School. */
function streamFor(db: FakeDatabase): TeamStream {
  return teamStream(tenantFor(db, ORG_A), {
    teamId: TEAM,
    expeditionSessionId: SESSION,
  });
}

const scored = (reason: ScoreEvent['reason'], points: number, at: string): ScoreEvent => ({
  reason,
  points,
  at,
  missionInstanceId: alpha,
});

const reached: ProgressionEvent = {
  reason: 'node-reached',
  at: '2026-05-12T10:00:00.000Z',
  nodeId: start,
};

describe('appending to a stream', () => {
  test('numbers the first line one, sealed against the opening value', async () => {
    const db = withTeam();
    const [line] = await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendProgression([reached]),
    );

    assert.equal(line?.sequence, 1);
    assert.equal(line?.previousHash, GENESIS_HASH);
  });

  test('carries one number line across both tables', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) => {
      const stream = streamFor(db).withConnection(tx);
      await stream.appendProgression([reached]);
      await stream.appendScore([scored('mission-complete', 100, '2026-05-12T10:01:00.000Z')]);
      await stream.appendProgression([
        { reason: 'node-cleared', at: '2026-05-12T10:01:00.000Z', nodeId: start },
      ]);
    });

    assert.deepEqual(
      db.rowsIn('progression_event').map((row) => row['stream_sequence']),
      [1, 3],
    );
    assert.deepEqual(
      db.rowsIn('score_event').map((row) => row['stream_sequence']),
      [2],
    );
  });

  test('seals each line against the one before it, across the two tables', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) => {
      const stream = streamFor(db).withConnection(tx);
      await stream.appendProgression([reached]);
      await stream.appendScore([scored('mission-complete', 100, '2026-05-12T10:01:00.000Z')]);
    });

    const first = db.rowsIn('progression_event')[0];
    const second = db.rowsIn('score_event')[0];
    assert.equal(second?.['previous_hash'], first?.['hash']);
  });

  test('keeps the head on the team row in step with the stream', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) => {
      const stream = streamFor(db).withConnection(tx);
      await stream.appendProgression([reached]);
      await stream.appendScore([scored('speed-bonus', 25, '2026-05-12T10:01:00.000Z')]);
    });

    const team = db.rowsIn('team')[0];
    const last = db.rowsIn('score_event')[0];
    assert.equal(team?.['stream_length'], 2);
    assert.equal(team?.['stream_head_hash'], last?.['hash']);
  });

  test('picks the numbering up from where the stored head says it got to', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendProgression([reached]),
    );
    // A second request, which holds none of the first one's lines in memory.
    const [line] = await inTransaction(db, async (tx) =>
      streamFor(db)
        .withConnection(tx)
        .appendScore([scored('mission-complete', 100, '2026-05-12T10:01:00.000Z')]),
    );

    assert.equal(line?.sequence, 2);
    assert.equal(line?.previousHash, db.rowsIn('progression_event')[0]?.['hash']);
  });

  test('takes the team row for update, so two writers queue rather than collide', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendProgression([reached]),
    );

    const locked = db.statements.filter(
      (statement) =>
        statement.text.startsWith('SELECT') &&
        statement.text.includes('"team"') &&
        statement.text.endsWith('FOR UPDATE'),
    );
    assert.equal(locked.length, 1);
  });

  test('refuses to write outside a transaction', async () => {
    const db = withTeam();
    await assert.rejects(
      () => streamFor(db).appendProgression([reached]),
      UnlockedStreamAppendError,
    );
    assert.deepEqual(db.rowsIn('progression_event'), []);
  });

  test('writes nothing when a change produced no events', async () => {
    // A wrong answer on an expedition with no `attempt-penalty` rule.
    const db = withTeam();
    const lines = await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendScore([]),
    );

    assert.deepEqual(lines, []);
    assert.deepEqual(db.rowsIn('score_event'), []);
    assert.equal(db.rowsIn('team')[0]?.['stream_length'], 0);
  });

  test('stamps every line with the team and the run it belongs to', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendScore([scored('mission-complete', 100, '2026-05-12T10:01:00.000Z')]),
    );

    const row = db.rowsIn('score_event')[0];
    assert.equal(row?.['team_id'], TEAM);
    assert.equal(row?.['expedition_session_id'], SESSION);
    assert.equal(row?.['organisation_id'], ORG_A);
  });

  test('keeps the row ids a caller passes beside the document ids the seal used', async () => {
    const db = withTeam();
    await inTransaction(db, async (tx) =>
      streamFor(db)
        .withConnection(tx)
        .appendScore([scored('mission-complete', 100, '2026-05-12T10:01:00.000Z')], {
          participantId: 'student-row',
          missionInstanceId: 'mission-row',
        }),
    );

    const row = db.rowsIn('score_event')[0];
    assert.equal(row?.['mission_instance_id'], 'mission-row');
    assert.equal(row?.['mission_instance_key'], alpha);
    assert.equal(row?.['participant_id'], 'student-row');
  });

  test('refuses a team that is not in this organisation', async () => {
    const db = withTeam(ORG_B);
    await assert.rejects(
      () => inTransaction(db, async (tx) => streamFor(db).withConnection(tx).appendProgression([reached])),
      UnknownTeamError,
    );
  });
});

describe('reading a stream back', () => {
  /** A short run, written down the way EXPD-020 will write one. */
  async function afternoon(db: FakeDatabase): Promise<void> {
    await inTransaction(db, async (tx) => {
      const stream = streamFor(db).withConnection(tx);
      await stream.appendProgression([
        reached,
        { reason: 'mission-unlocked', at: '2026-05-12T10:00:00.000Z', nodeId: start, missionInstanceId: alpha },
      ]);
      await stream.appendScore([
        scored('mission-complete', 100, '2026-05-12T10:05:00.000Z'),
        scored('speed-bonus', 25, '2026-05-12T10:05:00.000Z'),
      ]);
      await stream.appendProgression([
        { reason: 'expedition-finished', at: '2026-05-12T10:06:00.000Z', nodeId: toId<'node'>('finish') as NodeId },
      ]);
    });
  }

  test('gives the lines back in one order, oldest first', async () => {
    const db = withTeam();
    await afternoon(db);
    const lines = await streamFor(db).read();

    assert.deepEqual(lines.map((line) => line.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['progression', 'progression', 'score', 'score', 'progression'],
    );
  });

  test('gives back exactly what the engine sealed, so every seal still holds', async () => {
    const db = withTeam();
    await afternoon(db);
    const check = verifyStream(await streamFor(db).read());

    assert.equal(check.intact, true, JSON.stringify(check.defects));
    assert.equal(check.total, 125);
  });

  test('rebuilds the result the team ended on', async () => {
    const db = withTeam();
    await afternoon(db);
    const result = await streamFor(db).result();

    assert.equal(result.total, 125);
    assert.equal(result.finished, true);
    assert.deepEqual(result.unlockedMissionIds, [alpha]);
    assert.deepEqual(result.missions.map((each) => [each.missionInstanceId, each.points]), [
      [alpha, 125],
    ]);
  });

  test('reads an empty stream as a team that has done nothing', async () => {
    const db = withTeam();
    assert.deepEqual(await streamFor(db).read(), []);
    assert.equal((await streamFor(db).result()).total, 0);
  });

  test('says so when the kept total has drifted from the stream', async () => {
    const db = withTeam();
    await afternoon(db);
    // Somebody fixed the leaderboard by hand. The stream is what is right.
    await tenantFor(db, ORG_A).updateById('team', TEAM, { total_score: 340 });

    const check = await streamFor(db).verify();
    assert.equal(check.intact, false);
    assert.equal(check.defects[0]?.code, 'total-disagrees');
    assert.equal(check.defects[0]?.expected, '125');
  });

  test('agrees with a kept total that is the stream', async () => {
    const db = withTeam();
    await afternoon(db);
    await tenantFor(db, ORG_A).updateById('team', TEAM, { total_score: 125 });

    assert.equal((await streamFor(db).verify()).intact, true);
  });
});

describe('what a stream will not do', () => {
  test('has no method that changes a line', () => {
    const stream = streamFor(withTeam());
    for (const name of ['update', 'edit', 'delete', 'remove', 'correct']) {
      assert.equal(
        name in (stream as unknown as Record<string, unknown>),
        false,
        `TeamStream should have no ${name} method`,
      );
    }
  });

  test('refuses an update to either table below the class as well', async () => {
    const db = withTeam();
    await afternoon(db);
    const tenant = tenantFor(db, ORG_A);

    await assert.rejects(
      () => tenant.updateById('score_event', 'anything', { points: 500 }),
      AppendOnlyTableError,
    );
    await assert.rejects(
      () => tenant.updateById('progression_event', 'anything', { note: 'x' }),
      AppendOnlyTableError,
    );
  });

  /** The same run as above, so the refusal is tried against real rows. */
  async function afternoon(db: FakeDatabase): Promise<void> {
    await inTransaction(db, async (tx) =>
      streamFor(db).withConnection(tx).appendProgression([reached]),
    );
  }
});

describe('replaying a stream straight off the rows', () => {
  test('gives the same answer as replaying the lines in memory', async () => {
    const db = withTeam();
    const written = await inTransaction(db, async (tx) =>
      streamFor(db)
        .withConnection(tx)
        .appendScore([scored('mission-complete', 100, '2026-05-12T10:05:00.000Z')]),
    );

    assert.deepEqual(await streamFor(db).result(), replayStream(written));
  });
});
