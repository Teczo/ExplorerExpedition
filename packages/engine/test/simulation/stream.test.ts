/**
 * Holding the engine to its own record.
 *
 * This is the test only the harness could write. EXPD-014 says a team's final
 * result can be rebuilt from their stream and disputed line by line; until
 * now nothing had played a whole expedition, so nothing had produced a stream
 * long enough to hold that claim to. A run does, and every line of it was
 * sealed by the engine's own sealer from events the engine's own scoring and
 * progression produced.
 *
 * So: play a real expedition, then check the record it left the way an
 * outsider would.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { replayStream, replayTeamScore, scoreEventsOf } from '../../src/stream/replay.ts';
import { verifyStream } from '../../src/stream/verify.ts';
import { replayMissionTransitions } from '../../src/mission-state/machine.ts';
import { createMissionProgress } from '../../src/mission-state/machine.ts';
import { simulateExpedition } from '../../src/simulation/index.ts';
import { rulesOf, scoringOf, straightLine } from './support.ts';

/** A run with enough going on in it to be worth checking. */
const report = simulateExpedition({
  definition: straightLine({
    rules: rulesOf({ progression: 'strict', allowSkip: true, hints: true }),
    scoring: scoringOf([
      {
        id: 'quick' as never,
        type: 'speed-bonus',
        points: 5,
        withinSeconds: 300,
        target: { kind: 'all' },
      },
      {
        id: 'wrong' as never,
        type: 'attempt-penalty',
        pointsPerFailedAttempt: 2,
        target: { kind: 'all' },
      },
    ]),
    missions: { basePoints: 20, maxAttempts: 4 },
  }),
  teamCount: 4,
  seed: 'the-record',
});

describe('the stream a run leaves behind', () => {
  it('is intact for every team', () => {
    for (const team of report.teams) {
      const checked = verifyStream(team.stream);

      assert.equal(checked.intact, true, `${team.teamId}: ${JSON.stringify(checked.defects)}`);
      assert.equal(checked.checked, team.stream.length);
    }
  });

  it('is numbered from one and never skips', () => {
    for (const team of report.teams) {
      assert.deepEqual(
        team.stream.map((entry) => entry.sequence),
        team.stream.map((_, index) => index + 1),
      );
    }
  });

  it('adds up to the total the run says the team ended on', () => {
    for (const team of report.teams) {
      assert.equal(replayStream(team.stream).total, team.totalPoints);
      assert.equal(replayTeamScore(team.stream).total, team.totalPoints);
    }
  });

  it('holds every score event the scoring engine produced, in order', () => {
    for (const team of report.teams) {
      assert.deepEqual(scoreEventsOf(team.stream), team.score.events);
    }
  });

  it('agrees with the run about which missions were finished', () => {
    for (const team of report.teams) {
      const replayed = replayStream(team.stream);

      assert.equal(replayed.finished, team.finished);
      for (const missionInstanceId of team.completedMissionIds) {
        assert.ok(
          replayed.unlockedMissionIds.includes(missionInstanceId),
          `${String(missionInstanceId)} was finished and never unlocked in the record`,
        );
      }
    }
  });

  it('never steps backwards in time', () => {
    for (const team of report.teams) {
      let last = '';
      for (const entry of team.stream) {
        assert.ok(entry.event.at >= last, `${entry.event.at} came after ${last}`);
        last = entry.event.at;
      }
    }
  });
});

describe('the mission histories a run leaves behind', () => {
  it('replay to exactly the states the run ended on', () => {
    for (const team of report.teams) {
      for (const progress of team.missionProgress) {
        const replayed = replayMissionTransitions(
          createMissionProgress(progress.missionInstanceId),
          progress.log,
          { maxAttempts: 4, allowSkip: true },
        );

        assert.equal(
          replayed.consistent,
          true,
          replayed.consistent ? '' : replayed.message,
        );
        assert.equal(replayed.progress.state, progress.state);
        assert.equal(replayed.progress.attemptsUsed, progress.attemptsUsed);
      }
    }
  });
});
