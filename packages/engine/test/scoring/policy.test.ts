/**
 * Which document each scoring setting is read from.
 *
 * Scoring reads from two places and they answer two different questions, so
 * the point of gathering them is that there is one place to look when they
 * disagree. What is tested is that each setting comes off the document that
 * holds it, that an `all` target really means every mission in the
 * expedition, and that a caller who passes nothing gets a mission worth
 * nothing rather than one worth a number nobody chose.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_EXPEDITION_SCORING_POLICY,
  DEFAULT_MISSION_SCORING_POLICY,
  applyScoreChange,
  createTeamScore,
  expeditionScoringPolicyFor,
  missionScoringPolicyFor,
  missionsTargetedBy,
  targetCoversMission,
} from '../../src/scoring/index.ts';
import {
  at,
  definitionOf,
  expedition,
  missionId,
  missionInstanceOf,
  playedMission,
  ruleId,
  verdictOf,
} from './support.ts';

describe('what a mission is worth', () => {
  it('is read off the mission', () => {
    const policy = missionScoringPolicyFor(
      missionInstanceOf('alpha', {
        basePoints: 75,
        allowPartialCredit: true,
        maxPoints: 120,
      }),
    );

    assert.deepEqual(policy, {
      basePoints: 75,
      allowPartialCredit: true,
      maxPoints: 120,
    });
  });

  it('has no cap when the mission names none', () => {
    const policy = missionScoringPolicyFor(
      missionInstanceOf('alpha', { basePoints: 75, allowPartialCredit: false }),
    );
    assert.equal(policy.maxPoints, null);
  });
});

describe("the expedition's half", () => {
  const scoring = {
    rules: [
      {
        id: ruleId('quick'),
        type: 'speed-bonus' as const,
        target: { kind: 'all' as const },
        withinSeconds: 60,
        points: 25,
      },
    ],
    minimumTotal: -50,
    leaderboard: { visibility: 'live' as const, tieBreaks: [] },
  };

  it('is read off the expedition, rules in the order the document lists them', () => {
    const policy = expeditionScoringPolicyFor(
      definitionOf(
        [
          missionInstanceOf('alpha', { basePoints: 10, allowPartialCredit: false }),
          missionInstanceOf('bravo', { basePoints: 10, allowPartialCredit: false }),
        ],
        scoring,
      ),
    );

    assert.equal(policy.minimumTotal, -50);
    assert.deepEqual([...policy.rules], scoring.rules);
    assert.deepEqual([...policy.missionInstanceIds], ['alpha', 'bravo']);
  });

  it('takes the missions from the definition, because that is what `all` means', () => {
    const policy = expeditionScoringPolicyFor(
      definitionOf(
        [missionInstanceOf('alpha', { basePoints: 10, allowPartialCredit: false })],
        scoring,
      ),
    );

    assert.equal(targetCoversMission({ kind: 'all' }, missionId('alpha')), true);
    assert.equal(targetCoversMission({ kind: 'all' }, missionId('zulu')), true);
    assert.deepEqual([...missionsTargetedBy({ kind: 'all' }, policy)], ['alpha']);
    assert.deepEqual(
      [
        ...missionsTargetedBy(
          { kind: 'missions', missionInstanceIds: [missionId('bravo')] },
          policy,
        ),
      ],
      ['bravo'],
    );
  });

  it('names only the missions a targeted rule lists', () => {
    const target = {
      kind: 'missions' as const,
      missionInstanceIds: [missionId('alpha')],
    };
    assert.equal(targetCoversMission(target, missionId('alpha')), true);
    assert.equal(targetCoversMission(target, missionId('bravo')), false);
  });
});

describe('what a caller who passes nothing gets', () => {
  it('is a mission worth nothing and an expedition with no rules', () => {
    assert.deepEqual(DEFAULT_MISSION_SCORING_POLICY, {
      basePoints: 0,
      allowPartialCredit: false,
      maxPoints: null,
    });
    assert.deepEqual(DEFAULT_EXPEDITION_SCORING_POLICY, {
      rules: [],
      minimumTotal: 0,
      missionInstanceIds: [],
    });
  });

  it('scores a right answer at nothing rather than guessing a number', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('correct'),
      progress: playedMission(),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, 0);
    assert.deepEqual(result.events, []);
  });

  it('lets the floor go below nought when the expedition says so', () => {
    const result = applyScoreChange({
      kind: 'mission',
      score: createTeamScore(),
      verdict: verdictOf('incorrect'),
      progress: playedMission(),
      scoring: expedition(
        [
          {
            id: ruleId('wrong'),
            type: 'attempt-penalty',
            target: { kind: 'all' },
            pointsPerFailedAttempt: 30,
          },
        ],
        { minimumTotal: -50 },
      ),
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.score.total, -30);
  });
});
