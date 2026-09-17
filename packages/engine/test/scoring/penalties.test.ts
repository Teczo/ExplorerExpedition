/**
 * The three rules that take points away, and what a hint costs.
 *
 * A penalty is the half of scoring a class will argue about, so what is
 * tested is that each one is charged once, for the thing it names, and never
 * past the floor. The hint token cost is here too: it is the one charge a
 * team chooses to pay, and it arrives on its own rather than with a verdict.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyScoreChange, createTeamScore } from '../../src/scoring/index.ts';
import {
  at,
  expedition,
  hintId,
  missionId,
  playedMission,
  ruleId,
  teamOn,
  verdictOf,
  worth,
} from './support.ts';

describe('the attempt penalty', () => {
  const wrongAnswer = {
    id: ruleId('wrong'),
    type: 'attempt-penalty' as const,
    target: { kind: 'all' as const },
    pointsPerFailedAttempt: 15,
  };

  it('charges for a wrong answer and nothing else', () => {
    for (const [outcome, expected] of [
      ['incorrect', 85],
      ['correct', 100 + 30],
      ['expired', 100],
    ] as const) {
      const result = applyScoreChange({
        kind: 'mission',
        score: teamOn(100),
        verdict: verdictOf(outcome),
        progress: playedMission(),
        mission: worth({ basePoints: 30 }),
        scoring: expedition([wrongAnswer]),
        at: at(30),
      });

      assert.equal(result.applied, true);
      if (!result.applied) {
        return;
      }
      assert.equal(result.score.total, expected, `for a ${outcome} answer`);
    }
  });

  it('charges again for the next wrong answer on the same mission', () => {
    const first = applyScoreChange({
      kind: 'mission',
      score: teamOn(100),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth({ basePoints: 30 }),
      scoring: expedition([wrongAnswer]),
      at: at(30),
    });
    assert.equal(first.applied, true);
    if (!first.applied) {
      return;
    }

    // A team handed the mission back may get it wrong again, and that is a
    // second wrong answer rather than the same one arriving twice.
    const second = applyScoreChange({
      kind: 'mission',
      score: first.score,
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth({ basePoints: 30 }),
      scoring: expedition([wrongAnswer]),
      at: at(90),
    });
    assert.equal(second.applied, true);
    if (!second.applied) {
      return;
    }
    assert.equal(second.score.total, 70);
    assert.equal(second.score.failedAttempts, 2);
  });

  it('charges only on the missions it names', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(100),
      verdict: verdictOf('incorrect'),
      progress: playedMission('alpha'),
      mission: worth({ basePoints: 30 }),
      scoring: expedition([
        {
          ...wrongAnswer,
          target: { kind: 'missions', missionInstanceIds: [missionId('bravo')] },
        },
      ]),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 100);
    // Not charged, still counted: the tie break counts wrong answers.
    assert.equal(result.score.failedAttempts, 1);
  });
});

describe('the late penalty', () => {
  const late = {
    id: ruleId('late'),
    type: 'late-penalty' as const,
    graceSeconds: 60,
    pointsPerMinute: 10,
  };

  /** Scores one finished mission handed in this far past the limit. */
  function lateBy(lateBySeconds: number | undefined): number {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(500),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 0 }),
      scoring: expedition([late]),
      at: at(30),
      ...(lateBySeconds === undefined ? {} : { lateBySeconds }),
    });
    if (!result.applied) {
      throw new Error(result.refusal.message);
    }
    return result.score.total;
  }

  it('costs nothing inside the grace period, or when nobody said', () => {
    assert.equal(lateBy(undefined), 500);
    assert.equal(lateBy(0), 500);
    assert.equal(lateBy(60), 500);
  });

  it('charges a part minute past the grace period as a whole one', () => {
    assert.equal(lateBy(61), 490);
    assert.equal(lateBy(120), 490);
    assert.equal(lateBy(121), 480);
  });

  it('does not charge a wrong answer for being late as well', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(500),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth({ basePoints: 0 }),
      scoring: expedition([late]),
      lateBySeconds: 600,
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 500);
  });
});

describe('what a hint costs', () => {
  const hintRule = {
    id: ruleId('hints'),
    type: 'hint-penalty' as const,
    target: { kind: 'all' as const },
    pointsPerHint: 20,
  };

  it('charges when the team opens it, and says which hint it was', () => {
    const result = applyScoreChange({
      kind: 'hint',
      score: teamOn(100),
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring: expedition([hintRule]),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 80);
    assert.equal(result.events[0]?.reason, 'hint-penalty');
    assert.equal(result.events[0]?.hintId, 'hint-1');
    assert.equal(result.events[0]?.missionInstanceId, 'alpha');
    assert.equal(result.events[0]?.scoringRuleId, 'hints');
  });

  it('refuses to charge for the same hint twice', () => {
    const first = applyScoreChange({
      kind: 'hint',
      score: teamOn(100),
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring: expedition([hintRule]),
      at: at(30),
    });
    assert.equal(first.applied, true);
    if (!first.applied) {
      return;
    }

    const again = applyScoreChange({
      kind: 'hint',
      score: first.score,
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring: expedition([hintRule]),
      at: at(31),
    });

    assert.equal(again.applied, false);
    if (again.applied) {
      return;
    }
    assert.equal(again.refusal.code, 'hint-already-spent');
    assert.equal(again.refusal.hintId, 'hint-1');
    assert.equal(again.score.total, 80, 'nothing moved');
    assert.deepEqual(
      again.score.events,
      first.score.events,
      'nothing was written down',
    );
  });

  it('counts a hint the rules charge nothing for', () => {
    const result = applyScoreChange({
      kind: 'hint',
      score: teamOn(100),
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring: expedition([]),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 100);
    assert.deepEqual(result.events, []);
    // The `fewest-hints-used` tie break counts hints, not points.
    assert.deepEqual([...result.score.spentHintIds], ['hint-1']);
  });

  it('is not held down by a mission cap, because a hint is not part of the mission', () => {
    const result = applyScoreChange({
      kind: 'hint',
      score: teamOn(10),
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring: expedition([hintRule], { minimumTotal: 0 }),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 0);
    assert.deepEqual(result.events[0]?.limit, {
      kind: 'minimum-total',
      wouldHaveBeen: -20,
    });
  });
});

describe('a teacher moving the score by hand', () => {
  it('writes one line, in the words the teacher used', () => {
    const result = applyScoreChange({
      kind: 'adjustment',
      score: teamOn(100),
      points: -25,
      note: 'Crossed the road without looking.',
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 75);
    assert.equal(result.events[0]?.reason, 'manual-adjustment');
    assert.equal(result.events[0]?.note, 'Crossed the road without looking.');
  });

  it('stops at the floor, the same as any other penalty', () => {
    const result = applyScoreChange({
      kind: 'adjustment',
      score: teamOn(10),
      points: -50,
      note: 'A mistake in the marking.',
      scoring: expedition([], { minimumTotal: 0 }),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 0);
  });

  it('adds points as readily as it takes them', () => {
    const result = applyScoreChange({
      kind: 'adjustment',
      score: createTeamScore(),
      points: 50,
      note: 'The QR code had come off the post.',
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 50);
  });
});
