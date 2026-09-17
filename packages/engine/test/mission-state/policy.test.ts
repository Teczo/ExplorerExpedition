/**
 * The two dials, and where they are read from.
 *
 * `allowSkip` decides whether a team may walk away from a mission, and
 * `maxAttempts` decides how many tries they get. Both come out of documents
 * EXPD-002 defines, and the reading of them is the only place the state
 * machine looks at an expedition at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toId,
  type ExpeditionRules,
  type MissionInstance,
  type MissionInstanceId,
  type ProgressionMode,
} from '@explorer/shared-types';

import {
  allowedMissionTriggers,
  applyMissionTransition,
  createMissionProgress,
  DEFAULT_MISSION_STATE_POLICY,
  hasAttemptLeft,
  missionStatePolicyFor,
} from '../../src/mission-state/index.ts';

const MISSION: MissionInstanceId = toId('mission-1');
const AT = '2026-09-17T09:00:00.000Z';

function mission(maxAttempts: number | null): MissionInstance {
  return {
    id: MISSION,
    missionTypeId: 'bird-count',
    missionTypeVersion: '1.0.0',
    title: 'Count the birds',
    brief: 'How many do you see?',
    config: {},
    scoring: { basePoints: 10, allowPartialCredit: false },
    attempts: { maxAttempts },
    verification: 'automatic',
    hints: [],
    media: [],
  };
}

function rules(progression: ProgressionMode, allowSkip: boolean): ExpeditionRules {
  return {
    progression,
    allowSkip,
    teams: { size: { min: 2, max: 5 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
    timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
    hints: { enabled: false, tokensPerTeam: 0 },
    submissions: {
      requireReviewForAll: false,
      latePolicy: 'accept',
      allowOfflineQueue: true,
    },
  };
}

describe('what a mission runs under when nobody says', () => {
  it('gives unlimited tries and lets nobody skip', () => {
    assert.deepEqual(DEFAULT_MISSION_STATE_POLICY, { maxAttempts: null, allowSkip: false });
  });

  it('is what the machine uses when it is passed no policy', () => {
    const result = applyMissionTransition(
      createMissionProgress(MISSION, { state: 'available' }),
      { trigger: 'skip', actor: 'team', at: AT },
    );
    assert.equal(result.applied, false);
    assert.equal(result.applied === false && result.refusal.code, 'skip-not-allowed');
  });
});

describe('reading a policy off the documents', () => {
  it('takes the attempt limit from the mission', () => {
    assert.equal(missionStatePolicyFor(mission(3), rules('open', false)).maxAttempts, 3);
    assert.equal(missionStatePolicyFor(mission(null), rules('open', false)).maxAttempts, null);
  });

  it('takes skipping from the expedition rules', () => {
    assert.equal(missionStatePolicyFor(mission(1), rules('strict', true)).allowSkip, true);
    assert.equal(missionStatePolicyFor(mission(1), rules('strict', false)).allowSkip, false);
  });

  it('ignores the flag in free-roam, where nothing was blocking the team', () => {
    assert.equal(missionStatePolicyFor(mission(1), rules('free-roam', false)).allowSkip, true);
    assert.equal(missionStatePolicyFor(mission(1), rules('free-roam', true)).allowSkip, true);
  });
});

describe('skipping', () => {
  it('is refused when the expedition does not allow it', () => {
    const policy = missionStatePolicyFor(mission(null), rules('strict', false));
    const result = applyMissionTransition(
      createMissionProgress(MISSION, { state: 'available' }),
      { trigger: 'skip', actor: 'team', at: AT },
      policy,
    );
    assert.equal(result.applied, false);
    assert.equal(result.applied === false && result.refusal.code, 'skip-not-allowed');
  });

  it('is not offered to a team that may not do it', () => {
    const policy = missionStatePolicyFor(mission(null), rules('strict', false));
    const offered = allowedMissionTriggers(
      createMissionProgress(MISSION, { state: 'available' }),
      policy,
    );
    assert.deepEqual(offered, ['relock', 'start']);
  });

  it('works from a mission the team has already opened', () => {
    const policy = missionStatePolicyFor(mission(null), rules('open', true));
    const result = applyMissionTransition(
      createMissionProgress(MISSION, { state: 'in-progress' }),
      { trigger: 'skip', actor: 'team', at: AT },
      policy,
    );
    assert.equal(result.applied, true);
    assert.equal(result.progress.state, 'skipped');
  });

  it('is never offered on a mission the team cannot see', () => {
    const policy = missionStatePolicyFor(mission(null), rules('open', true));
    assert.deepEqual(
      allowedMissionTriggers(createMissionProgress(MISSION, { state: 'locked' }), policy),
      ['unlock'],
    );
  });
});

describe('counting tries left', () => {
  it('always has one when there is no limit', () => {
    assert.equal(hasAttemptLeft(99, { maxAttempts: null, allowSkip: false }), true);
  });

  it('runs out exactly at the limit', () => {
    const policy = { maxAttempts: 2, allowSkip: false };
    assert.equal(hasAttemptLeft(0, policy), true);
    assert.equal(hasAttemptLeft(1, policy), true);
    assert.equal(hasAttemptLeft(2, policy), false);
  });
});
