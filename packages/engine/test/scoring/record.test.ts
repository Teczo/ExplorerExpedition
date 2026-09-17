/**
 * That the stream is the record.
 *
 * The ticket asks for one thing above all the others: every score change
 * writes a `ScoreEvent`. What is tested here is the shape of that promise —
 * that a total is always the sum of the events behind it, that a refused
 * change writes nothing and moves nothing, that a record handed in is never
 * edited, and that nothing the engine can mint is a word the database column
 * could not hold.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCORE_EVENT_REASONS } from '@explorer/shared-types';

import {
  applyScoreChange,
  createTeamScore,
  scoreTotal,
} from '../../src/scoring/index.ts';
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

const rules = [
  {
    id: ruleId('quick'),
    type: 'speed-bonus' as const,
    target: { kind: 'all' as const },
    withinSeconds: 600,
    points: 25,
  },
  {
    id: ruleId('hints'),
    type: 'hint-penalty' as const,
    target: { kind: 'all' as const },
    pointsPerHint: 20,
  },
  {
    id: ruleId('wrong'),
    type: 'attempt-penalty' as const,
    target: { kind: 'all' as const },
    pointsPerFailedAttempt: 15,
  },
];

describe('the total and the stream behind it', () => {
  it('adds up to the total, whatever happened on the way', () => {
    const scoring = expedition(rules, { minimumTotal: 0 });
    // Started off the floor, so that the early penalties really are charged
    // rather than trimmed away before they can move anything.
    let score = teamOn(200);

    const steps = [
      { kind: 'hint' as const, hint: 'hint-1' },
      { kind: 'mission' as const, mission: 'alpha', outcome: 'incorrect' as const },
      { kind: 'mission' as const, mission: 'alpha', outcome: 'correct' as const },
      { kind: 'adjustment' as const, points: -5 },
      { kind: 'mission' as const, mission: 'bravo', outcome: 'correct' as const },
    ];

    for (const step of steps) {
      const result =
        step.kind === 'hint'
          ? applyScoreChange({
              kind: 'hint',
              score,
              missionInstanceId: missionId('alpha'),
              hintId: hintId(step.hint),
              scoring,
              at: at(10),
            })
          : step.kind === 'adjustment'
            ? applyScoreChange({
                kind: 'adjustment',
                score,
                points: step.points,
                note: 'A note.',
                scoring,
                at: at(20),
              })
            : applyScoreChange({
                kind: 'mission',
                score,
                verdict: verdictOf(step.outcome),
                progress: playedMission(step.mission),
                mission: worth({ basePoints: 100 }),
                scoring,
                at: at(30),
              });

      assert.equal(result.applied, true, JSON.stringify(step));
      if (!result.applied) {
        return;
      }
      score = result.score;

      // The promise, checked after every single change rather than at the end.
      assert.equal(
        score.total,
        scoreTotal(score.events),
        `the total stopped matching the stream after ${JSON.stringify(step)}`,
      );
    }

    assert.equal(score.total, 410);
  });

  it('never writes an event worth nothing', () => {
    const scoring = expedition(rules, { minimumTotal: 0 });
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 0, maxPoints: 0 }),
      scoring,
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    for (const event of result.score.events) {
      assert.notEqual(event.points, 0);
    }
  });

  it('only ever says one of the ten words the column holds', () => {
    const scoring = expedition(rules, { minimumTotal: 0 });
    const hint = applyScoreChange({
      kind: 'hint',
      score: teamOn(500),
      missionInstanceId: missionId('alpha'),
      hintId: hintId('hint-1'),
      scoring,
      at: at(10),
    });
    const mission = applyScoreChange({
      kind: 'mission',
      score: teamOn(500),
      verdict: verdictOf('correct', { progress: 0.5 }),
      progress: playedMission(),
      mission: worth({ basePoints: 100, allowPartialCredit: true }),
      scoring,
      at: at(30),
    });
    const byHand = applyScoreChange({
      kind: 'adjustment',
      score: teamOn(500),
      points: 5,
      note: 'A note.',
      scoring,
      at: at(40),
    });

    for (const result of [hint, mission, byHand]) {
      assert.equal(result.applied, true);
      if (!result.applied) {
        return;
      }
      for (const event of result.events) {
        assert.ok(
          (SCORE_EVENT_REASONS as readonly string[]).includes(event.reason),
          `"${event.reason}" is not a reason the database can hold`,
        );
      }
    }
  });

  it('hands back a new record and leaves the one it was given alone', () => {
    const before = createTeamScore();
    const result = applyScoreChange({
      kind: 'mission',
      score: before,
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100 }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.notEqual(result.score, before);
    assert.equal(before.total, 0);
    assert.deepEqual(before.events, []);
    assert.deepEqual(before.completedMissionIds, []);
  });
});

describe('a change the rules will not make', () => {
  it('refuses a verdict nobody has decided yet', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('needs-review'),
      progress: playedMission(),
      mission: worth({ basePoints: 100 }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'not-decided');
    assert.equal(result.refusal.missionInstanceId, 'alpha');
    assert.equal(result.score.total, 0);
    assert.deepEqual(result.score.events, []);
  });

  it('refuses a second verdict on a mission already finished', () => {
    const first = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      mission: worth({ basePoints: 100 }),
      scoring: expedition(),
      at: at(30),
    });
    assert.equal(first.applied, true);
    if (!first.applied) {
      return;
    }

    for (const outcome of ['correct', 'incorrect', 'expired'] as const) {
      const again = applyScoreChange({
        kind: 'mission',
        score: first.score,
        verdict: verdictOf(outcome),
        progress: playedMission(),
        mission: worth({ basePoints: 100 }),
        scoring: expedition(),
        at: at(60),
      });

      assert.equal(again.applied, false, `a second ${outcome} verdict`);
      if (again.applied) {
        return;
      }
      assert.equal(again.refusal.code, 'already-scored');
      assert.equal(again.score.total, 100, 'nothing moved');
      assert.equal(again.score.events.length, 1, 'nothing was written down');
      assert.equal(again.score.streak, 1, 'no count moved either');
    }
  });

  it('applies a change that was worth nothing rather than refusing it', () => {
    // A wrong answer on an expedition with no attempt penalty costs nothing
    // and still breaks the team's streak. That is applied, not refused.
    const result = applyScoreChange({
      kind: 'mission',
      score: teamOn(100, { streak: 4, longestStreak: 4 }),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      mission: worth({ basePoints: 100 }),
      scoring: expedition(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.deepEqual(result.events, []);
    assert.equal(result.score.streak, 0);
    assert.equal(result.score.longestStreak, 4);
    assert.equal(result.score.failedAttempts, 1);
  });
});

describe('the engine keeps nothing of its own', () => {
  it('gives the same answer twice for the same request', () => {
    const change = {
      kind: 'mission' as const,
      score: teamOn(40, { streak: 2 }),
      verdict: verdictOf('correct'),
      progress: playedMission('alpha', at(0)),
      mission: worth({ basePoints: 100, maxPoints: 110 }),
      scoring: expedition(rules, { minimumTotal: 0 }),
      at: at(30),
    };

    assert.deepEqual(applyScoreChange(change), applyScoreChange(change));
  });
});
