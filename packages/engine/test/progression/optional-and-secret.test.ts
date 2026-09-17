/**
 * The two things an author may say about a stop.
 *
 * Optional says a team may walk past the mission without finishing it. Secret
 * says they are not told it is there until it opens. What is tested here is
 * that each does only its own job: an optional mission never holds anybody up
 * and is still there to be done, and a secret one is hidden while it is
 * locked and shown from the moment it is not — without either changing what
 * unlocks what.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateProgression } from '../../src/progression/evaluate.ts';
import {
  edge,
  finish,
  mission,
  missionId,
  policyOf,
  situationOf,
  start,
} from './support.ts';

describe('optional missions', () => {
  /** start → alpha (optional) → bravo → finish. */
  const policy = policyOf(
    [start(), mission('alpha', { optional: true }), mission('bravo'), finish()],
    [
      edge('start', 'node-alpha'),
      edge('node-alpha', 'node-bravo'),
      edge('node-bravo', 'finish'),
    ],
  );

  it('does not hold up the stops behind it', () => {
    const snapshot = evaluateProgression({ policy, situation: situationOf() });

    assert.deepEqual(snapshot.unlockedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
    ]);
  });

  it('is still a mission the team may do', () => {
    const snapshot = evaluateProgression({ policy, situation: situationOf() });
    const alpha = snapshot.missions[0];

    assert.equal(alpha?.optional, true);
    assert.equal(alpha?.unlocked, true);
    assert.equal(alpha?.visible, true);
  });

  it('clears its stop the moment the team arrives, whatever they do about it', () => {
    const untouched = evaluateProgression({ policy, situation: situationOf() });
    assert.equal(untouched.nodes[1]?.cleared, true);

    const done = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });
    assert.equal(done.nodes[1]?.cleared, true);
  });

  it('lets a team finish the expedition without touching it', () => {
    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ states: { bravo: 'complete' } }),
    });

    assert.equal(snapshot.finished, true);
  });

  it('does not make a condition that names it come true', () => {
    const gated = policyOf(
      [start(), mission('alpha', { optional: true }), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo', {
          condition: { type: 'mission-completed', missionInstanceId: missionId('alpha') },
        }),
        edge('node-bravo', 'finish'),
      ],
    );

    const walkedPast = evaluateProgression({ policy: gated, situation: situationOf() });
    assert.deepEqual(walkedPast.unlockedMissionIds, [missionId('alpha')]);

    const done = evaluateProgression({
      policy: gated,
      situation: situationOf({ states: { alpha: 'complete' } }),
    });
    assert.deepEqual(done.unlockedMissionIds, [missionId('alpha'), missionId('bravo')]);
  });
});

describe('secret missions', () => {
  /** start → alpha → finish, with a secret bravo hanging off a rich team. */
  const policy = policyOf(
    [start(), mission('alpha'), mission('bravo', { secret: true }), finish()],
    [
      edge('start', 'node-alpha'),
      edge('node-alpha', 'node-bravo', {
        condition: { type: 'total-score-at-least', points: 100 },
      }),
      edge('node-alpha', 'finish'),
    ],
  );

  it('is not shown while it is locked', () => {
    const snapshot = evaluateProgression({ policy, situation: situationOf() });
    const bravo = snapshot.missions[1];

    assert.equal(bravo?.secret, true);
    assert.equal(bravo?.visible, false);
    assert.equal(bravo?.unlocked, false);
    assert.deepEqual(snapshot.visibleMissionIds, [missionId('alpha')]);
  });

  it('appears the moment its condition holds', () => {
    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({ states: { alpha: 'complete' }, totalPoints: 120 }),
    });
    const bravo = snapshot.missions[1];

    assert.equal(bravo?.visible, true);
    assert.equal(bravo?.unlocked, true);
    assert.deepEqual(snapshot.visibleMissionIds, [missionId('alpha'), missionId('bravo')]);
  });

  it('stays visible once the team has finished it', () => {
    const snapshot = evaluateProgression({
      policy,
      situation: situationOf({
        states: { alpha: 'complete', bravo: 'complete' },
        totalPoints: 220,
      }),
    });

    assert.equal(snapshot.missions[1]?.visible, true);
  });

  it('leaves a mission nobody kept quiet about on the board, locked', () => {
    const plain = policyOf(
      [start(), mission('alpha'), mission('bravo'), finish()],
      [
        edge('start', 'node-alpha'),
        edge('node-alpha', 'node-bravo'),
        edge('node-bravo', 'finish'),
      ],
    );

    const snapshot = evaluateProgression({ policy: plain, situation: situationOf() });
    const bravo = snapshot.missions[1];

    assert.equal(bravo?.visible, true);
    assert.equal(bravo?.unlocked, false);
    assert.equal(bravo?.state, 'locked');
  });

  it('hides nothing that the graph opens from the start', () => {
    const openFromTheStart = policyOf(
      [start(), mission('alpha', { secret: true }), finish()],
      [edge('start', 'node-alpha'), edge('node-alpha', 'finish')],
    );

    const snapshot = evaluateProgression({
      policy: openFromTheStart,
      situation: situationOf(),
    });

    assert.equal(snapshot.missions[0]?.visible, true);
  });
});
