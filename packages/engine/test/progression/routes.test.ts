/**
 * Team-specific routes.
 *
 * One graph, two ways through it. What is tested here is that a team walks
 * the edges their route is named on and the ones that are for everybody, that
 * the stops down somebody else's route are marked as somebody else's rather
 * than as locked, and that a team on no route at all still gets through an
 * expedition that has routes in it but does not use them on every edge.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EdgeAudience } from '@explorer/shared-types';

import { audienceCoversTeam, isRouteSpecific } from '../../src/progression/routes.ts';
import { evaluateProgression } from '../../src/progression/evaluate.ts';
import {
  checkpoint,
  edge,
  finish,
  mission,
  missionId,
  policyOf,
  routeId,
  situationOf,
  start,
} from './support.ts';

/**
 * start → split, then the walkers go to the lake and the cyclists to the hill,
 * and both come back to the same finish.
 */
const twoWays = policyOf(
  [start(), checkpoint('split'), mission('lake'), mission('hill'), finish()],
  [
    edge('start', 'split'),
    edge('split', 'node-lake', { routes: ['walkers'] }),
    edge('split', 'node-hill', { routes: ['cyclists'] }),
    edge('node-lake', 'finish'),
    edge('node-hill', 'finish'),
  ],
  { routes: ['walkers', 'cyclists'] },
);

describe('an edge audience', () => {
  it('lets everybody through when it names nobody', () => {
    assert.equal(audienceCoversTeam(undefined, []), true);
    assert.equal(audienceCoversTeam({ kind: 'all' }, []), true);
  });

  it('wants one of the routes it names', () => {
    const audience: EdgeAudience = {
      kind: 'routes',
      routeIds: [routeId('walkers'), routeId('runners')],
    };

    assert.equal(audienceCoversTeam(audience, [routeId('runners')]), true);
    assert.equal(audienceCoversTeam(audience, [routeId('cyclists')]), false);
    assert.equal(audienceCoversTeam(audience, []), false);
  });

  it('is for nobody when it names no route at all', () => {
    assert.equal(audienceCoversTeam({ kind: 'routes', routeIds: [] }, [routeId('walkers')]), false);
  });

  it('says whether it is for some teams rather than all of them', () => {
    assert.equal(isRouteSpecific(undefined), false);
    assert.equal(isRouteSpecific({ kind: 'all' }), false);
    assert.equal(isRouteSpecific({ kind: 'routes', routeIds: [routeId('walkers')] }), true);
  });
});

describe('team-specific routes', () => {
  it('sends a team down the route they are on', () => {
    const walkers = evaluateProgression({
      policy: twoWays,
      situation: situationOf({ routes: ['walkers'] }),
    });

    assert.deepEqual(walkers.unlockedMissionIds, [missionId('lake')]);
  });

  it('sends the other half of the class the other way', () => {
    const cyclists = evaluateProgression({
      policy: twoWays,
      situation: situationOf({ routes: ['cyclists'] }),
    });

    assert.deepEqual(cyclists.unlockedMissionIds, [missionId('hill')]);
  });

  it('marks the other route as somebody else’s rather than as locked', () => {
    const walkers = evaluateProgression({
      policy: twoWays,
      situation: situationOf({ routes: ['walkers'] }),
    });
    const hill = walkers.missions.find((entry) => entry.missionInstanceId === 'hill');

    assert.equal(hill?.offRoute, true);
    assert.equal(hill?.reached, false);
    assert.deepEqual(hill?.blockedBy, [
      { edgeId: 'split->node-hill', from: 'split', reason: 'off-route' },
    ]);

    const lake = walkers.missions.find((entry) => entry.missionInstanceId === 'lake');
    assert.equal(lake?.offRoute, false);
  });

  it('lets a team on both routes take either', () => {
    const both = evaluateProgression({
      policy: twoWays,
      situation: situationOf({ routes: ['walkers', 'cyclists'] }),
    });

    assert.deepEqual(both.unlockedMissionIds, [missionId('lake'), missionId('hill')]);
  });

  it('leaves a team on no route with only the edges that are for everybody', () => {
    const nobody = evaluateProgression({ policy: twoWays, situation: situationOf() });

    assert.deepEqual(nobody.unlockedMissionIds, []);
    assert.equal(nobody.nodes.find((node) => node.nodeId === 'split')?.reached, true);
  });

  it('brings both routes back to the same finish', () => {
    for (const [route, done] of [
      ['walkers', 'lake'],
      ['cyclists', 'hill'],
    ] as const) {
      const snapshot = evaluateProgression({
        policy: twoWays,
        situation: situationOf({ routes: [route], states: { [done]: 'complete' } }),
      });

      assert.equal(snapshot.finished, true, `${route} should reach the finish`);
    }
  });
});
