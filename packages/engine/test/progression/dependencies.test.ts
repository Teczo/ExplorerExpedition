/**
 * What stands in front of a mission, with no team in it.
 *
 * The same question progression answers for one team, asked of the document
 * instead. What is tested here is that both kinds of dependency are found —
 * the stop before and the mission a condition names — that an optional stop
 * is not one, and that a condition's missions are found however deeply they
 * are buried.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  missionsNamedByCondition,
  missionsRequiredBefore,
  nodeHoldingMission,
} from '../../src/progression/dependencies.ts';
import {
  checkpoint,
  edge,
  finish,
  mission,
  missionId,
  policyOf,
  start,
} from './support.ts';

describe('the missions a condition names', () => {
  it('finds the one a mission-completed condition is about', () => {
    assert.deepEqual(
      missionsNamedByCondition({
        type: 'mission-completed',
        missionInstanceId: missionId('alpha'),
      }),
      [missionId('alpha')],
    );
  });

  it('finds every one a count condition lists', () => {
    assert.deepEqual(
      missionsNamedByCondition({
        type: 'missions-completed-at-least',
        count: 2,
        missionInstanceIds: [missionId('alpha'), missionId('bravo')],
      }),
      [missionId('alpha'), missionId('bravo')],
    );
  });

  it('finds them inside a group, and names each one once', () => {
    const found = missionsNamedByCondition({
      type: 'all-of',
      conditions: [
        { type: 'mission-completed', missionInstanceId: missionId('alpha') },
        {
          type: 'any-of',
          conditions: [
            { type: 'mission-score-at-least', missionInstanceId: missionId('alpha'), points: 10 },
            { type: 'not', condition: { type: 'mission-completed', missionInstanceId: missionId('bravo') } },
          ],
        },
        { type: 'total-score-at-least', points: 100 },
      ],
    });

    assert.deepEqual(found, [missionId('alpha'), missionId('bravo')]);
  });

  it('finds nothing in a condition that is not about a mission', () => {
    assert.deepEqual(missionsNamedByCondition({ type: 'always' }), []);
    assert.deepEqual(missionsNamedByCondition(undefined), []);
  });
});

describe('what stands in front of a mission', () => {
  it('counts the mission on the stop before it', () => {
    const policy = policyOf(
      [start(), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
    );

    assert.deepEqual(missionsRequiredBefore(policy, missionId('bravo')), [
      missionId('alpha'),
    ]);
    assert.deepEqual(missionsRequiredBefore(policy, missionId('alpha')), []);
  });

  it('counts a mission a condition on the way in names', () => {
    const policy = policyOf(
      [start(), checkpoint('gate'), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'gate'),
        edge('gate', 'node-bravo', {
          condition: { type: 'mission-completed', missionInstanceId: missionId('alpha') },
        }),
        edge('node-bravo', 'finish'),
      ],
    );

    assert.deepEqual(missionsRequiredBefore(policy, missionId('bravo')), [
      missionId('alpha'),
    ]);
  });

  it('does not count a mission a team may walk past', () => {
    const policy = policyOf(
      [start(), mission('alpha', { optional: true }), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
    );

    assert.deepEqual(missionsRequiredBefore(policy, missionId('bravo')), []);
  });

  it('still counts an optional mission a condition names', () => {
    const policy = policyOf(
      [start(), mission('alpha', { optional: true }), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo', {
          condition: { type: 'mission-completed', missionInstanceId: missionId('alpha') },
        }),
        edge('node-bravo', 'finish'),
      ],
    );

    assert.deepEqual(missionsRequiredBefore(policy, missionId('bravo')), [
      missionId('alpha'),
    ]);
  });

  it('has nothing to say about a mission this expedition does not place', () => {
    const policy = policyOf([start(), finish()], [edge('start', 'finish')]);

    assert.deepEqual(missionsRequiredBefore(policy, missionId('alpha')), []);
    assert.equal(nodeHoldingMission(policy, missionId('alpha')), undefined);
  });

  it('finds the stop that holds one', () => {
    const policy = policyOf(
      [start(), mission('alpha'), finish()],
      [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
    );

    assert.equal(nodeHoldingMission(policy, missionId('alpha'))?.id, 'node-alpha');
  });
});
