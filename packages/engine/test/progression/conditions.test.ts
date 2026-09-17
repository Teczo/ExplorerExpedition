/**
 * Whether one unlock condition holds.
 *
 * The nine kinds of condition, one at a time, against a team that has done
 * some things and not others. What is tested here is that each reads the part
 * of the situation it is about and no other part, that the three that combine
 * conditions combine them the way the schema says — an empty `all-of` being
 * true and an empty `any-of` false included — and that a mission a team gave
 * up on never counts as one they finished.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UnlockCondition } from '@explorer/shared-types';

import { evaluateUnlockCondition } from '../../src/progression/conditions.ts';
import { missionId, situationOf } from './support.ts';

describe('unlock conditions', () => {
  it('lets anybody through an edge with no condition on it', () => {
    assert.equal(evaluateUnlockCondition(undefined, situationOf()), true);
    assert.equal(evaluateUnlockCondition({ type: 'always' }, situationOf()), true);
  });

  it('holds a mission-completed condition to a mission that was completed', () => {
    const condition = {
      type: 'mission-completed',
      missionInstanceId: missionId('alpha'),
    } as const;

    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ states: { alpha: 'complete' } })),
      true,
    );
    assert.equal(
      evaluateUnlockCondition(
        condition,
        situationOf({ states: { alpha: 'in-progress' } }),
      ),
      false,
    );
    assert.equal(evaluateUnlockCondition(condition, situationOf()), false);
  });

  it('does not count a mission a team failed or skipped as one they finished', () => {
    const condition = {
      type: 'mission-completed',
      missionInstanceId: missionId('alpha'),
    } as const;

    for (const state of ['failed', 'skipped'] as const) {
      assert.equal(
        evaluateUnlockCondition(condition, situationOf({ states: { alpha: state } })),
        false,
        `${state} should not unlock what finishing would have`,
      );
    }
  });

  it('measures a mission score against what that mission earned', () => {
    const condition = {
      type: 'mission-score-at-least',
      missionInstanceId: missionId('alpha'),
      points: 50,
    } as const;

    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ missionPoints: { alpha: 50 } })),
      true,
      'at the number is at least the number',
    );
    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ missionPoints: { alpha: 49 } })),
      false,
    );
    assert.equal(
      evaluateUnlockCondition(
        condition,
        situationOf({ missionPoints: { bravo: 500 }, totalPoints: 500 }),
      ),
      false,
      'another mission’s points are not this one’s',
    );
  });

  it('measures a total against the team total', () => {
    const condition = { type: 'total-score-at-least', points: 100 } as const;

    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ totalPoints: 100 })),
      true,
    );
    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ totalPoints: 99 })),
      false,
    );
  });

  it('counts how many of the listed missions are finished', () => {
    const condition: UnlockCondition = {
      type: 'missions-completed-at-least',
      count: 2,
      missionInstanceIds: [missionId('alpha'), missionId('bravo'), missionId('charlie')],
    };

    assert.equal(
      evaluateUnlockCondition(
        condition,
        situationOf({ states: { alpha: 'complete', bravo: 'complete' } }),
      ),
      true,
    );
    assert.equal(
      evaluateUnlockCondition(
        condition,
        situationOf({ states: { alpha: 'complete', bravo: 'failed' } }),
      ),
      false,
    );
    assert.equal(
      evaluateUnlockCondition(
        condition,
        situationOf({ states: { delta: 'complete', echo: 'complete' } }),
      ),
      false,
      'missions the condition does not list do not count towards it',
    );
  });

  it('counts the same mission listed twice only once', () => {
    const condition: UnlockCondition = {
      type: 'missions-completed-at-least',
      count: 2,
      missionInstanceIds: [missionId('alpha'), missionId('alpha')],
    };

    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ states: { alpha: 'complete' } })),
      false,
    );
  });

  it('measures elapsed time against the clock it was told about', () => {
    const condition = { type: 'elapsed-time-at-least', seconds: 600 } as const;

    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ elapsedSeconds: 600 })),
      true,
    );
    assert.equal(
      evaluateUnlockCondition(condition, situationOf({ elapsedSeconds: 599 })),
      false,
    );
  });

  it('combines conditions the way all-of, any-of and not say', () => {
    const finished = {
      type: 'mission-completed',
      missionInstanceId: missionId('alpha'),
    } as const;
    const rich = { type: 'total-score-at-least', points: 100 } as const;
    const situation = situationOf({ states: { alpha: 'complete' }, totalPoints: 10 });

    assert.equal(
      evaluateUnlockCondition({ type: 'all-of', conditions: [finished, rich] }, situation),
      false,
    );
    assert.equal(
      evaluateUnlockCondition({ type: 'any-of', conditions: [finished, rich] }, situation),
      true,
    );
    assert.equal(evaluateUnlockCondition({ type: 'not', condition: rich }, situation), true);
    assert.equal(
      evaluateUnlockCondition({ type: 'not', condition: finished }, situation),
      false,
    );
  });

  it('reads an empty group the way the schema does', () => {
    assert.equal(
      evaluateUnlockCondition({ type: 'all-of', conditions: [] }, situationOf()),
      true,
      'every one of no conditions holds',
    );
    assert.equal(
      evaluateUnlockCondition({ type: 'any-of', conditions: [] }, situationOf()),
      false,
      'none of no conditions does',
    );
  });

  it('nests as deep as the schema allows, and no deeper', () => {
    const inner = { type: 'always' } as const;

    /** A condition wrapped in `depth` layers of `all-of`. */
    const wrapped = (depth: number): { type: 'all-of'; conditions: never[] } | typeof inner =>
      depth === 0
        ? inner
        : ({ type: 'all-of', conditions: [wrapped(depth - 1)] } as never);

    // Ten deep is the limit the schema sets and the validator enforces.
    assert.equal(evaluateUnlockCondition(wrapped(9), situationOf()), true);
    assert.equal(
      evaluateUnlockCondition(wrapped(10), situationOf()),
      false,
      'a document nobody could have saved keeps the stop shut',
    );
  });
});
