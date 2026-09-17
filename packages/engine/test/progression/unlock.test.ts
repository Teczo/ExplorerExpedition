/**
 * Walking the graph: what a team has reached, and what is holding the rest up.
 *
 * What is tested here is the shape of the walk itself. A team starts at the
 * start and gets no further than the first thing they have not done; finishing
 * it opens what comes next; a stop nobody has cleared says so, and says which
 * edge it is waiting on. Also that a mission which ended badly still lets the
 * team walk on, that a checkpoint is walked straight through, and that a
 * document the validator would have turned away does not hang the engine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateProgression } from '../../src/progression/evaluate.ts';
import {
  checkpoint,
  edge,
  finish,
  mission,
  missionId,
  policyOf,
  situationOf,
  start,
} from './support.ts';

/** start → alpha → bravo → finish, with nothing in the way but the missions. */
const line = policyOf(
  [start(), mission('alpha'), mission('bravo'), finish()],
  [
    edge('start', 'node-alpha'),
    edge('node-alpha', 'node-bravo'),
    edge('node-bravo', 'finish'),
  ],
);

describe('walking the graph', () => {
  it('opens the first mission and nothing behind it', () => {
    const snapshot = evaluateProgression({ policy: line, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, [missionId('alpha')]);
    assert.equal(snapshot.finished, false);
    assert.deepEqual(snapshot.reachedFinishNodeIds, []);
  });

  it('opens the next mission once the one before it is finished', () => {
    const snapshot = evaluateProgression({
      policy: line,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
    assert.equal(snapshot.finished, false);
  });

  it('finishes the expedition when the last stop is cleared', () => {
    const snapshot = evaluateProgression({
      policy: line,
      situation: situationOf({ states: { alpha: 'complete', bravo: 'complete' } }),
    });

    assert.equal(snapshot.finished, true);
    assert.deepEqual(snapshot.reachedFinishNodeIds, ['finish']);
  });

  it('says which edge a stop is waiting on, and why', () => {
    const snapshot = evaluateProgression({ policy: line, situation: situationOf() });
    const bravo = snapshot.nodes.find((node) => node.nodeId === 'node-bravo');

    assert.equal(bravo?.reached, false);
    assert.deepEqual(bravo?.blockedBy, [
      { edgeId: 'node-alpha->node-bravo', from: 'node-alpha', reason: 'not-cleared' },
    ]);
  });

  it('says when it is the condition rather than the stop that is holding a team', () => {
    const policy = policyOf(
      [start(), mission('alpha'), finish()],
      [
        edge('start', 'node-alpha', {
          condition: { type: 'total-score-at-least', points: 100 },
        }),
        edge('node-alpha', 'finish'),
      ],
    );

    const poor = evaluateProgression({ policy, situation: situationOf({ totalPoints: 40 }) });
    assert.deepEqual(poor.nodes[1]?.blockedBy, [
      { edgeId: 'start->node-alpha', from: 'start', reason: 'condition' },
    ]);
    assert.deepEqual(poor.unlockedMissionIds, []);

    const rich = evaluateProgression({
      policy,
      situation: situationOf({ totalPoints: 100 }),
    });
    assert.deepEqual(rich.nodes[1]?.blockedBy, []);
    assert.deepEqual(rich.unlockedMissionIds, [missionId('alpha')]);
  });

  it('lets a team walk on from a mission that ended badly', () => {
    for (const state of ['failed', 'skipped'] as const) {
      const snapshot = evaluateProgression({
        policy: line,
        situation: situationOf({ states: { alpha: state } }),
      });

      assert.equal(
        snapshot.missions.find((entry) => entry.missionInstanceId === 'bravo')?.unlocked,
        true,
        `a team with a ${state} mission behind them is not stuck in front of it`,
      );
    }
  });

  it('does not hand a team what finishing a mission would have unlocked', () => {
    const policy = policyOf(
      [start(), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo', {
          condition: { type: 'mission-completed', missionInstanceId: missionId('alpha') },
        }),
        edge('node-bravo', 'finish'),
      ],
    );

    const gaveUp = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'skipped' } }),
    });
    assert.deepEqual(gaveUp.unlockedMissionIds, [missionId('alpha')]);

    const finished = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });
    assert.deepEqual(finished.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
  });

  it('walks a team straight through a checkpoint', () => {
    const policy = policyOf(
      [start(), checkpoint('split'), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'split'),
        edge('split', 'node-alpha'),
        edge('split', 'node-bravo'),
        edge('node-alpha', 'finish'),
        edge('node-bravo', 'finish'),
      ],
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });
    const split = snapshot.nodes.find((node) => node.nodeId === 'split');

    assert.equal(split?.reached, true);
    assert.equal(split?.cleared, true);
    assert.deepEqual(snapshot.unlockedMissionIds, [missionId('alpha'), missionId('bravo')]);
  });

  it('reaches nothing when the expedition has no start', () => {
    const policy = policyOf(
      [mission('alpha'), finish()],
      [edge('node-alpha', 'finish')],
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, []);
    assert.equal(snapshot.nodes.every((node) => !node.reached), true);
  });

  it('answers an empty expedition with an empty snapshot', () => {
    const snapshot = evaluateProgression();

    assert.deepEqual(snapshot.nodes, []);
    assert.deepEqual(snapshot.missions, []);
    assert.equal(snapshot.finished, false);
  });

  it('drops an edge with an end this expedition does not have', () => {
    const policy = policyOf(
      [start(), mission('alpha'), finish()],
      [edge('start', 'node-alpha'), edge('node-alpha', 'nowhere'), edge('node-alpha', 'finish')],
    );

    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });

    assert.equal(snapshot.finished, true);
    assert.equal(snapshot.nodes.length, 3);
  });

  it('ends its walk on a graph that loops back on itself', () => {
    const policy = policyOf(
      [start(), checkpoint('one'), checkpoint('two'), finish()],
      [
        edge('start', 'one'),
        edge('one', 'two'),
        edge('two', 'one'),
        edge('two', 'finish'),
      ],
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.equal(snapshot.finished, true);
  });
});
