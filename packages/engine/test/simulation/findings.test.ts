/**
 * What a run tells an author.
 *
 * These are the expeditions that pass every check made before one is played —
 * the document validator (EXPD-002) and the registry's own (EXPD-009) — and
 * still go wrong on the day. That is the whole reason the harness is the AI
 * builder's validation step (EXPD-066) rather than one more schema check.
 *
 * Each test builds one broken expedition and asks the run what it noticed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  simulateExpedition,
  simulatedTeam,
  type SimulationFindingCode,
  type SimulationReport,
} from '../../src/simulation/index.ts';
import {
  checkpoint,
  edge,
  expeditionOf,
  finish,
  missionId,
  missionNode,
  missionOf,
  rulesOf,
  start,
  straightLine,
} from './support.ts';

/** The codes a report came back with, in the order it put them in. */
function codesOf(report: SimulationReport): SimulationFindingCode[] {
  return report.findings.map((finding) => finding.code);
}

/** The one finding with this code, for a test that wants to read its words. */
function findingOf(report: SimulationReport, code: SimulationFindingCode) {
  return report.findings.find((finding) => finding.code === code);
}

describe('an expedition with no way through it', () => {
  it('says so when there is no finish to reach', () => {
    const report = simulateExpedition({
      definition: expeditionOf({
        missions: [missionOf('alpha')],
        nodes: [start(), missionNode('alpha')],
        edges: [edge('start', 'node-alpha')],
      }),
      teamCount: 2,
      seed: 'nofinish',
    });

    assert.ok(codesOf(report).includes('no-finish-node'));
    assert.ok(codesOf(report).includes('no-team-finished'));
    assert.equal(report.playable, false);
  });

  it('says so when there is no start to begin at', () => {
    const report = simulateExpedition({
      definition: expeditionOf({
        missions: [missionOf('alpha')],
        nodes: [missionNode('alpha'), finish()],
        edges: [edge('node-alpha', 'finish')],
      }),
      teamCount: 1,
      seed: 'nostart',
    });

    assert.ok(codesOf(report).includes('no-start-node'));
    assert.equal(report.playable, false);
  });

  it('does not want a start in free-roam, where nothing is in the way', () => {
    const report = simulateExpedition({
      definition: expeditionOf({
        missions: [missionOf('alpha')],
        nodes: [missionNode('alpha'), finish()],
        edges: [],
        rules: rulesOf({ progression: 'free-roam' }),
      }),
      teamCount: 1,
      seed: 'roam',
    });

    assert.ok(!codesOf(report).includes('no-start-node'));
  });
});

describe('a mission nothing opens the way to', () => {
  const report = simulateExpedition({
    definition: expeditionOf({
      missions: [missionOf('alpha'), missionOf('orphan')],
      nodes: [start(), missionNode('alpha'), missionNode('orphan'), finish()],
      edges: [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
    }),
    teamCount: 2,
    seed: 'orphan',
  });

  it('is an error once a team has walked the expedition to its end', () => {
    const finding = findingOf(report, 'mission-never-reached');

    assert.equal(finding?.severity, 'error');
    assert.equal(finding.missionInstanceId, missionId('orphan'));
    assert.equal(report.playable, false);
  });

  it('names the mission by its title rather than by its id', () => {
    assert.match(findingOf(report, 'mission-never-reached')?.message ?? '', /"orphan"/);
  });
});

describe('a mission nobody got near', () => {
  it('is only a warning when no team finished the expedition', () => {
    // These teams never get past the first mission, so the run has nothing to
    // say about whether the rest of the graph could have been walked.
    const report = simulateExpedition({
      definition: straightLine({ rules: rulesOf({ progression: 'strict' }) }),
      teams: [simulatedTeam('duffers', { skill: 0, givesUp: 0 })],
      seed: 'duffers',
    });
    const finding = findingOf(report, 'mission-never-reached');

    assert.equal(finding?.severity, 'warning');
    assert.match(finding.message, /No team got that far/);
  });
});

describe('a mission nobody can finish', () => {
  it('reports a timer no team can beat', () => {
    const report = simulateExpedition({
      definition: straightLine({ missions: { timeLimitSeconds: 1, maxAttempts: 1 } }),
      teamCount: 3,
      seed: 'tight',
    });

    assert.equal(
      report.findings.filter((finding) => finding.code === 'mission-never-completed').length,
      3,
    );
    // The expedition can still be walked from end to end, so it is not an
    // error: a mission that is over never blocks the way (EXPD-013).
    assert.equal(report.playable, true);
  });
});

describe('a stop nobody stands on', () => {
  it('reports a checkpoint hanging off the graph', () => {
    const report = simulateExpedition({
      definition: expeditionOf({
        missions: [missionOf('alpha')],
        nodes: [start(), missionNode('alpha'), checkpoint('lonely'), finish()],
        edges: [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
      }),
      teamCount: 1,
      seed: 'lonely',
    });
    const finding = findingOf(report, 'node-never-reached');

    assert.equal(finding?.severity, 'warning');
    assert.match(finding.message, /"lonely"/);
  });

  it('does not say it twice about a mission stop', () => {
    const report = simulateExpedition({
      definition: expeditionOf({
        missions: [missionOf('alpha'), missionOf('orphan')],
        nodes: [start(), missionNode('alpha'), missionNode('orphan'), finish()],
        edges: [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
      }),
      teamCount: 1,
      seed: 'once',
    });

    assert.equal(codesOf(report).filter((code) => code === 'node-never-reached').length, 0);
  });
});

describe('a mission type nothing can play', () => {
  const report = simulateExpedition({
    definition: straightLine({ missions: { missionTypeId: 'Not A Key' } }),
    teamCount: 1,
    seed: 'badkey',
  });

  it('is an error, and the expedition is not playable', () => {
    assert.ok(codesOf(report).includes('unknown-mission-type'));
    assert.equal(report.playable, false);
  });

  it('is said once for the type rather than once per mission', () => {
    assert.equal(
      codesOf(report).filter((code) => code === 'unknown-mission-type').length,
      1,
    );
  });

  it('leaves the team with nowhere to go', () => {
    assert.equal(report.teams[0]?.stop, 'stuck');
    assert.ok(codesOf(report).includes('team-stuck'));
  });
});

describe('a run that would never end', () => {
  it('gives up and says which budget it spent', () => {
    const report = simulateExpedition({
      definition: straightLine(),
      teams: [simulatedTeam('forever', { skill: 0, givesUp: 0 })],
      seed: 'forever',
      limits: { maxStepsPerTeam: 40 },
    });

    assert.equal(report.teams[0]?.stop, 'step-budget');
    assert.ok(codesOf(report).includes('step-budget-spent'));
    assert.equal(findingOf(report, 'step-budget-spent')?.severity, 'note');
  });

  it('gives up on a team still playing when the run runs out of time', () => {
    const report = simulateExpedition({
      definition: straightLine(),
      teams: [simulatedTeam('plodders', { skill: 0, givesUp: 0, paceSeconds: 600 })],
      seed: 'plod',
      limits: { maxSeconds: 3600 },
    });

    assert.equal(report.teams[0]?.stop, 'time-budget');
    assert.ok(codesOf(report).includes('time-budget-spent'));
  });
});

describe('the order findings come back in', () => {
  it('puts the errors first and the notes last', () => {
    const report = simulateExpedition({
      definition: straightLine({ missions: { missionTypeId: 'Not A Key' } }),
      teamCount: 2,
      seed: 'order',
    });
    const rank = { error: 0, warning: 1, note: 2 };
    const ranks = report.findings.map((finding) => rank[finding.severity]);

    assert.deepEqual([...ranks].sort((left, right) => left - right), ranks);
  });
});
