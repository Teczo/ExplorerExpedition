/**
 * How long an afternoon of this takes.
 *
 * The second of the three jobs the harness has. An author writing an
 * expedition for a double period wants a number, and the only honest way to
 * get one is to play the thing. What is tested here is that the number moves
 * when the expedition does, that it is built only from the teams that
 * actually reached a finish, and that an expedition nobody finished still
 * says something about its own length.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { medianOf, simulateExpedition, simulatedTeam } from '../../src/simulation/index.ts';
import { rulesOf, straightLine } from './support.ts';

describe('the duration a run reports', () => {
  it('counts every team it ran and every one that finished', () => {
    const report = simulateExpedition({ definition: straightLine(), teamCount: 5, seed: 'count' });

    assert.equal(report.duration.teamsRun, 5);
    assert.equal(report.duration.teamsFinished, 5);
  });

  it('brackets the quickest and slowest teams', () => {
    const report = simulateExpedition({ definition: straightLine(), teamCount: 5, seed: 'spread' });
    const { shortestSeconds, longestSeconds, medianSeconds, meanSeconds } = report.duration;

    assert.ok(shortestSeconds !== undefined && longestSeconds !== undefined);
    assert.ok(shortestSeconds <= longestSeconds);
    assert.ok(medianSeconds !== undefined && medianSeconds >= shortestSeconds);
    assert.ok(medianSeconds <= longestSeconds);
    assert.ok(meanSeconds !== undefined && meanSeconds >= shortestSeconds);
    assert.ok(meanSeconds <= longestSeconds);

    assert.deepEqual(
      report.teams.map((team) => team.elapsedSeconds).sort((left, right) => left - right)[0],
      shortestSeconds,
    );
  });

  it('gets longer when the expedition gets longer', () => {
    const team = simulatedTeam('steady', { skill: 1, givesUp: 0, paceSeconds: 120, travelSeconds: 60 });
    const short = simulateExpedition({
      definition: straightLine({ rules: rulesOf({ progression: 'strict' }) }),
      teams: [team],
      seed: 'length',
    });
    const long = simulateExpedition({
      definition: straightLine({
        rules: rulesOf({ progression: 'strict' }),
        missions: { timeLimitSeconds: 3600 },
      }),
      teams: [{ ...team, paceSeconds: 600 }],
      seed: 'length',
    });

    assert.ok(
      (long.duration.medianSeconds ?? 0) > (short.duration.medianSeconds ?? 0),
      'a slower team should take longer',
    );
  });

  it('counts the time a teacher spends reviewing into what a team took', () => {
    const definition = straightLine({
      rules: rulesOf({ progression: 'strict', requireReviewForAll: true }),
    });
    const team = simulatedTeam('reviewed', { skill: 1, givesUp: 0 });

    const quick = simulateExpedition({ definition, teams: [team], seed: 'review', reviewSeconds: 0 });
    const slow = simulateExpedition({ definition, teams: [team], seed: 'review', reviewSeconds: 900 });

    assert.equal(
      (slow.duration.medianSeconds ?? 0) - (quick.duration.medianSeconds ?? 0),
      3 * 900,
    );
  });

  it('says how far the teams got when none of them finished', () => {
    const report = simulateExpedition({
      definition: straightLine(),
      teams: [simulatedTeam('duffers', { skill: 0, givesUp: 0 })],
      seed: 'unfinished',
      limits: { maxStepsPerTeam: 30 },
    });

    assert.equal(report.duration.teamsFinished, 0);
    assert.equal(report.duration.medianSeconds, undefined);
    assert.equal(report.duration.shortestSeconds, undefined);
    assert.ok((report.duration.unfinishedSeconds ?? 0) > 0);
  });

  it('says nothing at all about an expedition nobody played', () => {
    const report = simulateExpedition({ definition: straightLine(), teamCount: 0, seed: 'none' });

    assert.deepEqual(report.duration, { teamsRun: 0, teamsFinished: 0 });
    assert.deepEqual(report.teams, []);
  });
});

describe('the middle of a list of numbers', () => {
  it('is the middle one when there is an odd number of them', () => {
    assert.equal(medianOf([9, 1, 5]), 5);
  });

  it('is the mean of the middle two when there is an even number', () => {
    assert.equal(medianOf([1, 2, 4, 9]), 3);
  });

  it('is nothing at all when there are none', () => {
    assert.equal(medianOf([]), undefined);
  });
});
