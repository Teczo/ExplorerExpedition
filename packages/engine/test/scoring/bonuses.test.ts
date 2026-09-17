/**
 * The four rules that add points.
 *
 * Speed, being first, a run of right answers, and finishing the lot. What is
 * tested is when each one fires and, just as much, when it does not: a bonus
 * that pays on a wrong answer, on a mission it was not aimed at, or twice for
 * one thing is a leaderboard nobody can argue with afterwards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TeamScore } from '@explorer/shared-types';

import { applyScoreChange, createTeamScore } from '../../src/scoring/index.ts';
import {
  at,
  expedition,
  missionId,
  playedMission,
  ruleId,
  unopenedMission,
  verdictOf,
  worth,
} from './support.ts';

const quick = {
  id: ruleId('quick'),
  type: 'speed-bonus' as const,
  target: { kind: 'all' as const },
  withinSeconds: 60,
  points: 25,
};

describe('the speed bonus', () => {
  it('pays a team that beat the time', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      at: at(45),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 35);
    assert.equal(result.events[1]?.reason, 'speed-bonus');
    assert.equal(result.events[1]?.scoringRuleId, 'quick');
  });

  it('pays a team that used every second of it', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      at: at(60),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 35);
  });

  it('does not pay a team that took a second too long', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      at: at(61),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 10);
  });

  it('measures from the start in the mission history, and takes one given instead', () => {
    const given = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      // No start in the history at all, so only the caller can say.
      progress: unopenedMission(),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      tookSeconds: 12,
      at: at(9000),
    });
    const unmeasurable = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: unopenedMission(),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      at: at(9000),
    });

    assert.equal(given.applied, true);
    assert.equal(unmeasurable.applied, true);
    if (!given.applied || !unmeasurable.applied) {
      return;
    }
    assert.equal(given.score.total, 35);
    // A bonus nobody can measure is not awarded.
    assert.equal(unmeasurable.score.total, 10);
  });

  it('does not pay on a wrong answer, or on a mission it was not aimed at', () => {
    const wrong = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('incorrect'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([quick]),
      at: at(5),
    });
    const elsewhere = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([
        { ...quick, target: { kind: 'missions', missionInstanceIds: [missionId('bravo')] } },
      ]),
      at: at(5),
    });

    assert.equal(wrong.applied, true);
    assert.equal(elsewhere.applied, true);
    if (!wrong.applied || !elsewhere.applied) {
      return;
    }
    assert.equal(wrong.score.total, 0);
    assert.equal(elsewhere.score.total, 10);
  });
});

describe('the first-to-complete bonus', () => {
  const first = {
    id: ruleId('first'),
    type: 'first-to-complete-bonus' as const,
    target: { kind: 'all' as const },
    points: 40,
  };

  it('pays only the team the caller says was first', () => {
    const won = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([first]),
      firstToComplete: true,
      at: at(30),
    });
    const after = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([first]),
      at: at(30),
    });

    assert.equal(won.applied, true);
    assert.equal(after.applied, true);
    if (!won.applied || !after.applied) {
      return;
    }
    assert.equal(won.score.total, 50);
    // Not said, so not claimed. A bonus every team claims is worse than one
    // nobody does.
    assert.equal(after.score.total, 10);
  });
});

describe('the streak bonus', () => {
  const run = {
    id: ruleId('run'),
    type: 'streak-bonus' as const,
    length: 3,
    points: 60,
  };

  /** Finishes one mission and hands back where the team stands after it. */
  function finish(score: TeamScore, name: string): TeamScore {
    const result = applyScoreChange({
      kind: 'mission',
      score,
      verdict: verdictOf('correct'),
      progress: playedMission(name),
      mission: worth({ basePoints: 0 }),
      scoring: expedition([run], { missions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
      at: at(30),
    });
    if (!result.applied) {
      throw new Error(result.refusal.message);
    }
    return result.score;
  }

  it('pays when the run reaches the length, and again at every multiple', () => {
    let score = createTeamScore();
    score = finish(score, 'a');
    assert.equal(score.total, 0);
    score = finish(score, 'b');
    assert.equal(score.total, 0);
    score = finish(score, 'c');
    assert.equal(score.total, 60, 'three in a row pays');
    score = finish(score, 'd');
    score = finish(score, 'e');
    assert.equal(score.total, 60);
    score = finish(score, 'f');
    assert.equal(score.total, 120, 'six in a row is the thing done twice');
  });

  it('is broken by a wrong answer and by a mission that timed out', () => {
    for (const failure of ['incorrect', 'expired'] as const) {
      let score = createTeamScore();
      score = finish(score, 'a');
      score = finish(score, 'b');
      assert.equal(score.streak, 2);

      const broken = applyScoreChange({
        kind: 'mission',
        score,
        verdict: verdictOf(failure),
        progress: playedMission('c'),
        mission: worth({ basePoints: 0 }),
        scoring: expedition([run], { missions: ['a', 'b', 'c', 'd', 'e'] }),
        at: at(30),
      });
      assert.equal(broken.applied, true);
      if (!broken.applied) {
        return;
      }
      assert.equal(broken.score.streak, 0);
      assert.equal(broken.score.longestStreak, 2);

      const next = finish(broken.score, 'd');
      assert.equal(next.streak, 1);
      assert.equal(next.total, 0, 'the run starts again from one');
    }
  });
});

describe('the completion bonus', () => {
  const allDone = {
    id: ruleId('all-done'),
    type: 'completion-bonus' as const,
    target: { kind: 'all' as const },
    points: 200,
  };

  it('pays when the last mission it names is finished, and pays once', () => {
    const scoring = expedition([allDone], { missions: ['alpha', 'bravo'] });

    const half = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha'),
      mission: worth({ basePoints: 10 }),
      scoring,
      at: at(30),
    });
    assert.equal(half.applied, true);
    if (!half.applied) {
      return;
    }
    assert.equal(half.score.total, 10, 'one of two is not the lot');

    const done = applyScoreChange({
      kind: 'mission',
      score: half.score,
      verdict: verdictOf('correct'),
      progress: playedMission('bravo'),
      mission: worth({ basePoints: 10 }),
      scoring,
      at: at(60),
    });
    assert.equal(done.applied, true);
    if (!done.applied) {
      return;
    }
    assert.equal(done.score.total, 220);
    assert.deepEqual([...done.score.awardedRuleIds], ['all-done']);

    // A third mission finishing afterwards does not pay it again.
    const again = applyScoreChange({
      kind: 'mission',
      score: done.score,
      verdict: verdictOf('correct'),
      progress: playedMission('charlie'),
      mission: worth({ basePoints: 10 }),
      scoring,
      at: at(90),
    });
    assert.equal(again.applied, true);
    if (!again.applied) {
      return;
    }
    assert.equal(again.score.total, 230);
  });

  it('counts only the missions it names', () => {
    const scoring = expedition(
      [
        {
          ...allDone,
          target: { kind: 'missions', missionInstanceIds: [missionId('alpha')] },
        },
      ],
      { missions: ['alpha', 'bravo', 'charlie'] },
    );

    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha'),
      mission: worth({ basePoints: 10 }),
      scoring,
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 210);
  });

  it('does not pay for an expedition with no missions in it', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha'),
      mission: worth({ basePoints: 10 }),
      scoring: expedition([allDone], { missions: [] }),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 10);
  });
});
