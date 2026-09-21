/**
 * The promise the whole harness rests on.
 *
 * A run has to be reproducible, or none of the three things it is for works:
 * a test that passes four times in five is not a test, a duration estimate
 * nobody can repeat is not an estimate, and the AI builder cannot tell an
 * author an expedition is broken if the same document passes next time.
 *
 * What is tested here is that promise and the two things that would quietly
 * break it: a run that depends on the wall clock, and a run where one team's
 * luck depends on how many other teams happened to be playing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { simulateExpedition } from '../../src/simulation/index.ts';
import { rulesOf, straightLine } from './support.ts';

describe('the same seed', () => {
  it('gives the same run, line for line', () => {
    const first = simulateExpedition({ definition: straightLine(), teamCount: 4, seed: 'same' });
    const second = simulateExpedition({ definition: straightLine(), teamCount: 4, seed: 'same' });

    assert.deepEqual(first, second);
  });

  it('gives the same run on an expedition with everything turned on', () => {
    const definition = straightLine({
      rules: rulesOf({ progression: 'strict', allowSkip: true, hints: true }),
      missions: { maxAttempts: 3, timeLimitSeconds: 600 },
    });

    assert.deepEqual(
      simulateExpedition({ definition, teamCount: 5, seed: 'busy' }),
      simulateExpedition({ definition, teamCount: 5, seed: 'busy' }),
    );
  });

  it('seals the same stream both times', () => {
    const first = simulateExpedition({ definition: straightLine(), teamCount: 2, seed: 'sealed' });
    const second = simulateExpedition({ definition: straightLine(), teamCount: 2, seed: 'sealed' });

    assert.deepEqual(
      first.teams.map((team) => team.stream.at(-1)?.hash),
      second.teams.map((team) => team.stream.at(-1)?.hash),
    );
  });
});

describe('a different seed', () => {
  it('gives a different run', () => {
    const first = simulateExpedition({ definition: straightLine(), teamCount: 4, seed: 'lake' });
    const second = simulateExpedition({ definition: straightLine(), teamCount: 4, seed: 'hill' });

    assert.notDeepEqual(
      first.teams.map((team) => team.elapsedSeconds),
      second.teams.map((team) => team.elapsedSeconds),
    );
  });
});

describe('the luck of one team', () => {
  it('does not change when another team joins the run', () => {
    const three = simulateExpedition({
      definition: straightLine(),
      teams: [
        { id: 'a', skill: 0.6, paceSeconds: 120, travelSeconds: 30, givesUp: 0, usesHints: 0, routeIds: [] },
        { id: 'b', skill: 0.6, paceSeconds: 120, travelSeconds: 30, givesUp: 0, usesHints: 0, routeIds: [] },
      ],
      seed: 'crowd',
    });
    const one = simulateExpedition({
      definition: straightLine(),
      teams: [
        { id: 'a', skill: 0.6, paceSeconds: 120, travelSeconds: 30, givesUp: 0, usesHints: 0, routeIds: [] },
      ],
      seed: 'crowd',
    });

    assert.equal(three.teams[0]?.elapsedSeconds, one.teams[0]?.elapsedSeconds);
    assert.deepEqual(
      three.teams[0]?.missions.map((mission) => mission.attemptsUsed),
      one.teams[0]?.missions.map((mission) => mission.attemptsUsed),
    );
  });
});

describe('the timestamps a run writes', () => {
  it('are measured from the start it was given and nowhere else', () => {
    const report = simulateExpedition({
      definition: straightLine(),
      teamCount: 1,
      seed: 'clock',
      startedAt: '2030-01-01T00:00:00.000Z',
    });

    assert.equal(report.startedAt, '2030-01-01T00:00:00.000Z');
    for (const entry of report.teams[0]?.stream ?? []) {
      assert.ok(entry.event.at >= '2030-01-01T00:00:00.000Z', entry.event.at);
      assert.ok(entry.event.at < '2030-01-02T00:00:00.000Z', entry.event.at);
    }
  });
});
