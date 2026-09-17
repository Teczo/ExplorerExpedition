/**
 * What a mission is worth on its own, and the two limits around it.
 *
 * Base points are the first thing scoring does and the thing everything else
 * is measured against. What is tested here is that a right answer earns what
 * the mission says, that a partly right one earns a share only when the
 * mission allows it, that a mission's cap and the expedition's floor each
 * trim what they are supposed to and say so, and that nothing ever comes out
 * as a fraction of a point.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyScoreChange, createTeamScore } from '../../src/scoring/index.ts';
import {
  at,
  expedition,
  playedMission,
  ruleId,
  teamOn,
  verdictOf,
  worth,
} from './support.ts';
describe('base points', () => {
  it('pays what the mission is worth for a right answer', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 120 }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 120);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.reason, 'mission-complete');
    assert.equal(result.events[0]?.points, 120);
    assert.equal(result.events[0]?.at, at(30));
    assert.equal(result.events[0]?.missionInstanceId, 'alpha');
    assert.equal(result.events[0]?.attemptNumber, 1);
  });

  it('pays nothing for a wrong answer, and nothing for one that timed out', () => {
    for (const outcome of ['incorrect', 'expired'] as const) {
      const result = applyScoreChange({
        kind: 'mission',
        score: createTeamScore(),
        verdict: verdictOf(outcome),
        progress: playedMission(),
        mission: worth({ basePoints: 120 }),
        scoring: expedition(),
        at: at(30),
      });

      assert.equal(result.applied, true);
      if (!result.applied) {
        return;
      }
      assert.equal(result.score.total, 0);
      assert.deepEqual(result.events, []);
    }
  });

  it('writes nothing down for a mission worth nothing', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 0 }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    // A score that did not move is not a score change.
    assert.deepEqual(result.events, []);
    // It still counts as finished, so it is never paid for twice.
    assert.deepEqual([...result.score.completedMissionIds], ['alpha']);
  });

  it('holds the total at the floor rather than under it', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(10),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth(),
      scoring: expedition(
        [
          {
            id: ruleId('wrong'),
            type: 'attempt-penalty',
            target: { kind: 'all' },
            pointsPerFailedAttempt: 40,
          },
        ],
        { minimumTotal: 0 },
      ),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 0);
    assert.equal(result.events[0]?.points, -10);
    assert.deepEqual(result.events[0]?.limit, {
      kind: 'minimum-total',
      wouldHaveBeen: -40,
    });
  });

  it('writes nothing down for a penalty on a team already at the floor', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(0),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth(),
      scoring: expedition(
        [
          {
            id: ruleId('wrong'),
            type: 'attempt-penalty',
            target: { kind: 'all' },
            pointsPerFailedAttempt: 40,
          },
        ],
        { minimumTotal: 0 },
      ),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 0);
    assert.deepEqual(result.events, []);
    // The wrong answer still counts, whatever it cost.
    assert.equal(result.score.failedAttempts, 1);
  });
});

describe('partial credit', () => {
  it('pays a share of the base points when the mission allows it', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct', { progress: 0.5 }),
      progress: playedMission(),
      mission: worth({ basePoints: 100, allowPartialCredit: true }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 50);
    assert.equal(result.events[0]?.reason, 'partial-credit');
  });

  it('pays the lot when the mission does not allow it', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct', { progress: 0.5 }),
      progress: playedMission(),
      mission: worth({ basePoints: 100, allowPartialCredit: false }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 100);
    assert.equal(result.events[0]?.reason, 'mission-complete');
  });

  it('pays the lot when the mission type said nothing about how much', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100, allowPartialCredit: true }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 100);
    assert.equal(result.events[0]?.reason, 'mission-complete');
  });

  it('rounds to a whole point, because the schema has no fractions', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct', { progress: 1 / 3 }),
      progress: playedMission(),
      mission: worth({ basePoints: 100, allowPartialCredit: true }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 33);
    assert.equal(Number.isInteger(result.score.total), true);
  });

  it('keeps a figure outside nought to one inside it', () => {
    for (const [progress, expected] of [
      [-1, 0],
      [2, 100],
      [Number.NaN, 100],
    ] as const) {
      const result = applyScoreChange({
        kind: 'mission',
        score: createTeamScore(),
        verdict: verdictOf('correct', { progress }),
        progress: playedMission(),
        mission: worth({ basePoints: 100, allowPartialCredit: true }),
        scoring: expedition(),
        at: at(30),
      });

      assert.equal(result.applied, true);
      if (!result.applied) {
        return;
      }
      assert.equal(result.score.total, expected);
    }
  });
});

describe("a mission's cap", () => {
  it('trims a bonus that would take the mission over it, and says so', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100, maxPoints: 120 }),
      scoring: expedition([
        {
          id: ruleId('quick'),
          type: 'speed-bonus',
          target: { kind: 'all' },
          withinSeconds: 600,
          points: 50,
        },
      ]),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 120);
    assert.equal(result.events[1]?.points, 20);
    assert.deepEqual(result.events[1]?.limit, {
      kind: 'mission-cap',
      wouldHaveBeen: 50,
    });
  });

  it('gives the room to whichever rule the document lists first', () => {
    const rules = [
      {
        id: ruleId('quick'),
        type: 'speed-bonus' as const,
        target: { kind: 'all' as const },
        withinSeconds: 600,
        points: 30,
      },
      {
        id: ruleId('first'),
        type: 'first-to-complete-bonus' as const,
        target: { kind: 'all' as const },
        points: 30,
      },
    ];

    const forwards = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100, maxPoints: 110 }),
      scoring: expedition([...rules]),
      firstToComplete: true,
      at: at(30),
    });
    const backwards = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100, maxPoints: 110 }),
      scoring: expedition([...rules].reverse()),
      firstToComplete: true,
      at: at(30),
    });

    assert.equal(forwards.applied, true);
    assert.equal(backwards.applied, true);
    if (!forwards.applied || !backwards.applied) {
      return;
    }
    // The same total either way, and a different rule got the ten points.
    assert.equal(forwards.score.total, 110);
    assert.equal(backwards.score.total, 110);
    assert.equal(forwards.events[1]?.scoringRuleId, 'quick');
    assert.equal(backwards.events[1]?.scoringRuleId, 'first');
  });

  it('never trims a penalty, because a cap is about what a mission is worth', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(500),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth({ basePoints: 100, maxPoints: 100 }),
      scoring: expedition([
        {
          id: ruleId('wrong'),
          type: 'attempt-penalty',
          target: { kind: 'all' },
          pointsPerFailedAttempt: 25,
        },
      ]),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 475);
    assert.equal(result.events[0]?.limit, undefined);
  });
});
