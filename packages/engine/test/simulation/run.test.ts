/**
 * Playing an expedition.
 *
 * What is tested here is that a run really plays the game: teams walk the
 * graph in the order the mode says, missions end in states the state machine
 * could have put them in, points come out of the scoring rules, a mission's
 * own clock can beat a slow team, a teacher's review holds a mission up until
 * it is decided, and a team that is allowed to walk away sometimes does.
 *
 * None of it asserts an exact number of seconds. Those come out of a
 * generator, and a test that pinned them would break the moment a dial moved
 * without anything being wrong. What is pinned is what the rules say has to
 * hold whatever the generator rolled.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  simulateExpedition,
  simulatedTeam,
  type SimulatedTeamResult,
} from '../../src/simulation/index.ts';
import {
  edge,
  expeditionOf,
  finish,
  missionId,
  missionNode,
  missionOf,
  rulesOf,
  scoringOf,
  start,
  straightLine,
} from './support.ts';

/** Every mission state a team's run ended in, in document order. */
function statesOf(team: SimulatedTeamResult): string[] {
  return team.missions.map((mission) => mission.state);
}

describe('a run of a straightforward expedition', () => {
  const report = simulateExpedition({
    definition: straightLine(),
    teamCount: 3,
    seed: 'the-lake',
  });

  it('plays every team to a finish', () => {
    assert.equal(report.teams.length, 3);
    for (const team of report.teams) {
      assert.equal(team.finished, true, `${team.teamId} did not finish`);
      assert.equal(team.stop, 'finished');
    }
  });

  it('finds nothing wrong with it', () => {
    assert.deepEqual(report.findings, []);
    assert.equal(report.playable, true);
  });

  it('takes every team some time to play it', () => {
    for (const team of report.teams) {
      assert.ok(team.elapsedSeconds > 0, `${team.teamId} finished instantly`);
    }
  });

  it('pays each team for every mission they finished', () => {
    for (const team of report.teams) {
      assert.deepEqual(team.completedMissionIds, [
        missionId('alpha'),
        missionId('bravo'),
        missionId('charlie'),
      ]);
      assert.equal(team.totalPoints, 30);
    }
  });

  it('leaves a record of every try behind each of those states', () => {
    for (const team of report.teams) {
      for (const mission of team.missions) {
        assert.equal(mission.state, 'complete');
        assert.ok(mission.attemptsUsed >= 1);
        assert.ok(mission.secondsSpent > 0);
      }
    }
  });

  it('turns nothing away', () => {
    for (const team of report.teams) {
      assert.deepEqual(team.refusals, []);
    }
  });
});

describe('the progression mode', () => {
  it('sends a strict team through the missions one at a time', () => {
    const report = simulateExpedition({
      definition: straightLine({ rules: rulesOf({ progression: 'strict' }) }),
      teamCount: 1,
      seed: 'strict',
    });
    const team = report.teams[0];
    assert.ok(team !== undefined);

    const opened = team.missions.map((mission) => mission.startedAtSeconds ?? -1);
    assert.deepEqual([...opened].sort((left, right) => left - right), opened);
    for (const mission of team.missions) {
      assert.ok(mission.endedAtSeconds !== undefined);
    }
  });

  it('lets a free-roam team play everything and still finish', () => {
    const report = simulateExpedition({
      definition: straightLine({ rules: rulesOf({ progression: 'free-roam' }) }),
      teamCount: 2,
      seed: 'free',
    });

    for (const team of report.teams) {
      // Every stop is reached from the start in free-roam, the finish
      // included, so a team is done when there is nothing left to play —
      // never before they have played anything.
      assert.equal(team.stop, 'finished');
      assert.ok(team.elapsedSeconds > 0);
      for (const mission of team.missions) {
        assert.ok(['complete', 'failed', 'skipped'].includes(mission.state), mission.state);
      }
    }
  });

  it('keeps a team to the route they were put on', () => {
    const definition = expeditionOf({
      missions: [missionOf('river'), missionOf('hill')],
      nodes: [start(), missionNode('river'), missionNode('hill'), finish()],
      edges: [
        edge('start', 'node-river', { routes: ['water'] }),
        edge('start', 'node-hill', { routes: ['land'] }),
        edge('node-river', 'finish'),
        edge('node-hill', 'finish'),
      ],
      rules: rulesOf({ routes: ['water', 'land'] }),
    });

    const report = simulateExpedition({ definition, teamCount: 2, seed: 'routes' });
    const [water, land] = report.teams;

    assert.deepEqual(water?.unreachedMissionIds, [missionId('hill')]);
    assert.deepEqual(land?.unreachedMissionIds, [missionId('river')]);
    assert.equal(report.playable, true);
  });
});

describe('what stops a team finishing a mission', () => {
  it('fails a mission whose clock is shorter than the team is quick', () => {
    const report = simulateExpedition({
      definition: straightLine({ missions: { timeLimitSeconds: 5, maxAttempts: 2 } }),
      teamCount: 2,
      seed: 'timer',
    });

    for (const team of report.teams) {
      assert.deepEqual(statesOf(team), ['failed', 'failed', 'failed']);
      assert.deepEqual(team.completedMissionIds, []);
      // A mission that is over never blocks the way, however it ended, so the
      // team still walks to the finish (EXPD-013).
      assert.equal(team.finished, true);
    }
    assert.ok(
      report.findings.some((finding) => finding.code === 'mission-never-completed'),
    );
  });

  it('fails a mission once a team has used every try it allows', () => {
    const report = simulateExpedition({
      definition: straightLine({ missions: { maxAttempts: 1 } }),
      teams: [simulatedTeam('duffers', { skill: 0, givesUp: 0 })],
      seed: 'attempts',
    });
    const team = report.teams[0];

    assert.deepEqual(statesOf(team as SimulatedTeamResult), ['failed', 'failed', 'failed']);
    for (const mission of team?.missions ?? []) {
      assert.equal(mission.attemptsUsed, 1);
    }
  });

  it('gives up on a mission when the expedition lets a team skip', () => {
    const report = simulateExpedition({
      definition: straightLine({ rules: rulesOf({ allowSkip: true }) }),
      teams: [simulatedTeam('quitters', { skill: 0, givesUp: 1 })],
      seed: 'skip',
    });
    const team = report.teams[0];

    assert.deepEqual(statesOf(team as SimulatedTeamResult), ['skipped', 'skipped', 'skipped']);
    assert.equal(team?.totalPoints, 0);
    assert.equal(team?.finished, true);
  });
});

describe('a teacher in the loop', () => {
  const report = simulateExpedition({
    definition: straightLine({
      rules: rulesOf({ requireReviewForAll: true }),
      missions: { maxAttempts: 1 },
    }),
    teamCount: 2,
    seed: 'review',
    reviewSeconds: 600,
  });

  it('holds every mission up until somebody decides', () => {
    for (const team of report.teams) {
      for (const mission of team.missions) {
        assert.ok(
          ['complete', 'failed'].includes(mission.state),
          `${String(mission.missionInstanceId)} was left ${mission.state}`,
        );
      }
    }
  });

  it('charges the wait to the team that is waiting', () => {
    for (const team of report.teams) {
      // Three missions, one review each, ten minutes a review.
      assert.ok(team.elapsedSeconds >= 3 * 600, String(team.elapsedSeconds));
    }
  });
});

describe('what a run is worth', () => {
  it('pays the speed bonus to a team that was quick enough', () => {
    const report = simulateExpedition({
      definition: straightLine({
        scoring: scoringOf([
          {
            id: 'quick' as never,
            type: 'speed-bonus',
            points: 5,
            withinSeconds: 100_000,
            target: { kind: 'all' },
          },
        ]),
      }),
      teams: [simulatedTeam('flyers', { skill: 1, givesUp: 0 })],
      seed: 'speed',
    });

    assert.equal(report.teams[0]?.totalPoints, 3 * (10 + 5));
  });

  it('pays first-to-complete to the team that got there first in simulated time', () => {
    const report = simulateExpedition({
      definition: straightLine({
        scoring: scoringOf([
          {
            id: 'first' as never,
            type: 'first-to-complete-bonus',
            points: 50,
            target: { kind: 'all' },
          },
        ]),
      }),
      teams: [
        simulatedTeam('quick', { skill: 1, paceSeconds: 30, travelSeconds: 10, givesUp: 0 }),
        simulatedTeam('slow', { skill: 1, paceSeconds: 600, travelSeconds: 300, givesUp: 0 }),
      ],
      seed: 'first',
    });

    const [quick, slow] = report.teams;
    assert.equal(quick?.totalPoints, 3 * (10 + 50));
    assert.equal(slow?.totalPoints, 3 * 10);
  });

  it('charges a team for the hint they open', () => {
    // The hint is on the second mission on purpose. A penalty cannot take a
    // team below the expedition's floor (EXPD-012), and a team who opens a
    // hint before they have earned anything is already on it.
    const definition = expeditionOf({
      missions: [
        missionOf('alpha'),
        missionOf('bravo', {
          hints: [{ id: 'hint' as never, text: 'Look up.', order: 1, tokenCost: 1 }],
        }),
      ],
      nodes: [start(), missionNode('alpha'), missionNode('bravo'), finish()],
      edges: [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
      rules: rulesOf({ progression: 'strict', hints: true }),
      scoring: scoringOf([
        {
          id: 'hints' as never,
          type: 'hint-penalty',
          pointsPerHint: 4,
          target: { kind: 'all' },
        },
      ]),
    });

    const report = simulateExpedition({
      definition,
      teams: [simulatedTeam('curious', { skill: 1, usesHints: 1, givesUp: 0 })],
      seed: 'hints',
    });
    const team = report.teams[0];

    assert.equal(team?.totalPoints, 10 - 4 + 10);
    assert.equal(
      team?.missions.reduce((sum, mission) => sum + mission.hintsOpened, 0),
      1,
    );
  });
});
