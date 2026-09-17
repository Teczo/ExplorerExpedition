/**
 * Which document each setting is read from, and what the engine is told.
 *
 * Progression reads three things off a definition and is told four things
 * about a team. What is tested here is that each is read or built from the
 * one place that holds it: the mode and the routes off the rules, the shape
 * off the graph, the mission states off the state machine's records, and what
 * each mission earned off the score's own event stream.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExpeditionDefinition, ScoreEvent } from '@explorer/shared-types';

import {
  DEFAULT_PROGRESSION_POLICY,
  progressionPolicyFor,
} from '../../src/progression/policy.ts';
import {
  missionPointsFrom,
  missionPointsIn,
  missionStateIn,
  teamSituation,
} from '../../src/progression/situation.ts';
import { createMissionProgress } from '../../src/mission-state/machine.ts';
import { createTeamScore } from '../../src/scoring/score.ts';
import { edge, finish, mission, missionId, routeId, start } from './support.ts';

/** A definition holding only what the progression policy reads off one. */
function definitionOf(over: Partial<ExpeditionDefinition>): ExpeditionDefinition {
  return {
    schemaVersion: '1.1.0',
    id: 'expedition' as ExpeditionDefinition['id'],
    definitionVersion: 1,
    status: 'published',
    metadata: {} as ExpeditionDefinition['metadata'],
    missions: [],
    graph: { nodes: [], edges: [] },
    rules: {} as ExpeditionDefinition['rules'],
    scoring: {} as ExpeditionDefinition['scoring'],
    ...over,
  };
}

describe('reading the policy off a definition', () => {
  it('takes the mode and the routes off the rules, and the shape off the graph', () => {
    const policy = progressionPolicyFor(
      definitionOf({
        graph: {
          nodes: [start(), mission('alpha'), finish()],
          edges: [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
        },
        rules: {
          progression: 'open',
          routes: [
            { id: routeId('walkers'), name: 'The walkers' },
            { id: routeId('cyclists'), name: 'The cyclists' },
          ],
        } as unknown as ExpeditionDefinition['rules'],
      }),
    );

    assert.equal(policy.mode, 'open');
    assert.deepEqual(policy.routeIds, ['walkers', 'cyclists']);
    assert.equal(policy.graph.nodes.length, 3);
    assert.equal(policy.graph.edges.length, 2);
  });

  it('falls back to the strictest mode and no routes', () => {
    const policy = progressionPolicyFor(definitionOf({}));

    assert.equal(policy.mode, 'strict');
    assert.deepEqual(policy.routeIds, []);
    assert.equal(DEFAULT_PROGRESSION_POLICY.mode, 'strict');
  });
});

describe('what the engine is told about a team', () => {
  it('reads the mission states off the state machine’s records', () => {
    const situation = teamSituation({
      missions: [
        createMissionProgress(missionId('alpha'), { state: 'complete' }),
        createMissionProgress(missionId('bravo'), { state: 'in-progress' }),
      ],
    });

    assert.equal(missionStateIn(situation, missionId('alpha')), 'complete');
    assert.equal(missionStateIn(situation, missionId('bravo')), 'in-progress');
  });

  it('reads a mission nobody has a record for as locked', () => {
    assert.equal(missionStateIn(teamSituation(), missionId('alpha')), 'locked');
    assert.equal(missionPointsIn(teamSituation(), missionId('alpha')), 0);
  });

  it('adds up what each mission earned off the score stream', () => {
    const events: ScoreEvent[] = [
      {
        reason: 'mission-complete',
        points: 100,
        at: '2026-05-12T10:00:00.000Z',
        missionInstanceId: missionId('alpha'),
      },
      {
        reason: 'hint-penalty',
        points: -20,
        at: '2026-05-12T10:01:00.000Z',
        missionInstanceId: missionId('alpha'),
      },
      {
        reason: 'manual-adjustment',
        points: 50,
        at: '2026-05-12T10:02:00.000Z',
        note: 'For the whole run.',
      },
    ];

    const points = missionPointsFrom(events);
    assert.equal(points.get(missionId('alpha')), 80);
    assert.equal(points.size, 1, 'a change about no mission counts towards no mission');

    const situation = teamSituation({ score: createTeamScore(events) });
    assert.equal(missionPointsIn(situation, missionId('alpha')), 80);
    assert.equal(situation.totalPoints, 130, 'the total is still every event');
  });

  it('takes the clock and the route from whoever owns them', () => {
    const situation = teamSituation({ elapsedSeconds: 600, routeIds: [routeId('walkers')] });

    assert.equal(situation.elapsedSeconds, 600);
    assert.deepEqual(situation.routeIds, ['walkers']);
  });

  it('starts a team that has done nothing at nothing', () => {
    const situation = teamSituation();

    assert.equal(situation.totalPoints, 0);
    assert.equal(situation.elapsedSeconds, 0);
    assert.deepEqual(situation.routeIds, []);
    assert.equal(situation.missionStates.size, 0);
  });
});
