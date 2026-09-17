/**
 * The three progression modes.
 *
 * `strict` gives a team one mission at a time, `open` gives them everything
 * the graph has opened, and `free-roam` gives them the lot. What is tested
 * here is that each hands out what it says, that an optional mission is never
 * part of strict's queue, and that free-roam really does ignore the edges —
 * conditions, routes and secrets with them, which is the part worth knowing
 * before an author picks it.
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

/** A split with two missions on it, so that two stops can be open at once. */
const nodes = [
  start(),
  checkpoint('split'),
  mission('alpha'),
  mission('bravo'),
  finish(),
];
const edges = [
  edge('start', 'split'),
  edge('split', 'node-alpha'),
  edge('split', 'node-bravo'),
  edge('node-alpha', 'finish'),
  edge('node-bravo', 'finish'),
];

describe('strict', () => {
  const policy = policyOf(nodes, edges, { mode: 'strict' });

  it('opens one mission at a time, in the order the document lists them', () => {
    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, [missionId('alpha')]);
    assert.equal(snapshot.missions[1]?.reached, true, 'the stop is reached, but not its turn');
  });

  it('moves on to the next once the first is finished', () => {
    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
  });

  it('keeps a finished mission unlocked', () => {
    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'skipped' } }),
    });

    assert.equal(snapshot.missions[0]?.unlocked, true);
  });

  it('never puts an optional mission in the queue', () => {
    const withSideQuest = policyOf(
      [
        start(),
        checkpoint('split'),
        mission('alpha'),
        mission('extra', { optional: true }),
        finish(),
      ],
      [
        edge('start', 'split'),
        edge('split', 'node-alpha'),
        edge('split', 'node-extra'),
        edge('node-alpha', 'finish'),
      ],
      { mode: 'strict' },
    );

    const snapshot = evaluateProgression({
      policy: withSideQuest,
      situation: situationOf(),
    });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('extra'),
    ]);
  });
});

describe('open', () => {
  it('opens everything the graph has opened', () => {
    const snapshot = evaluateProgression({
      policy: policyOf(nodes, edges, { mode: 'open' }),
      situation: situationOf(),
    });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
  });

  it('still keeps shut what the graph has not opened', () => {
    const policy = policyOf(
      [start(), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
      { mode: 'open' },
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, [missionId('alpha')]);
  });
});

describe('free-roam', () => {
  it('opens every mission from the start', () => {
    const policy = policyOf(
      [start(), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha', {
          condition: { type: 'total-score-at-least', points: 1000 },
        }),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
      { mode: 'free-roam' },
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
    assert.equal(snapshot.finished, true, 'there is nothing left between them and the end');
    assert.deepEqual(snapshot.nodes[1]?.blockedBy, [], 'nothing is blocking anything');
  });

  it('ignores routes along with the edges that carry them', () => {
    const policy = policyOf(
      [start(), mission('lake'), mission('hill'), finish()],
      [
        edge('start', 'node-lake', { routes: ['walkers'] }),
        edge('start', 'node-hill', { routes: ['cyclists'] }),
        edge('node-lake', 'finish'),
        edge('node-hill', 'finish'),
      ],
      { mode: 'free-roam', routes: ['walkers', 'cyclists'] },
    );

    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ routes: ['walkers'] }),
    });

    assert.deepEqual(snapshot.unlockedMissionIds, [missionId('lake'), missionId('hill')]);
    assert.equal(snapshot.missions[1]?.offRoute, false);
  });

  it('keeps no secrets, because there is nothing left to hide behind', () => {
    const policy = policyOf(
      [start(), mission('alpha', { secret: true }), finish()],
      [
        edge('start', 'node-alpha', {
          condition: { type: 'elapsed-time-at-least', seconds: 3600 },
        }),
        edge('node-alpha', 'finish'),
      ],
      { mode: 'free-roam' },
    );

    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.visibleMissionIds, [missionId('alpha')]);
  });
});
