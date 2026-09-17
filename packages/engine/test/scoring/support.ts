/**
 * What the scoring tests are played against.
 *
 * Nothing here is a real expedition. The scoring engine reads two small
 * policies and a verdict, and that is exactly what these build: a mission
 * worth some points, a list of rules, and a mission history with a `start` in
 * it so that a speed bonus has something to measure.
 */

import type {
  CompletionOutcome,
  CompletionVerdict,
  ExpeditionDefinition,
  HintId,
  MissionInstance,
  MissionInstanceId,
  MissionProgress,
  ScoreEvent,
  ScoringRule,
  ScoringRuleId,
  TeamScore,
} from '@explorer/shared-types';

import {
  applyMissionTransition,
  createMissionProgress,
} from '../../src/mission-state/index.ts';
import { DEFAULT_MISSION_STATE_POLICY } from '../../src/mission-state/policy.ts';
import {
  createTeamScore,
  type ExpeditionScoringPolicy,
  type MissionScoringPolicy,
} from '../../src/scoring/index.ts';

/** A time, so that a test never has to write one out. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 4, 12, 10, 0, seconds)).toISOString();
}

/** A mission id, tagged. */
export function missionId(name: string): MissionInstanceId {
  return name as MissionInstanceId;
}

/** A scoring rule id, tagged. */
export function ruleId(name: string): ScoringRuleId {
  return name as ScoringRuleId;
}

/** A hint id, tagged. */
export function hintId(name: string): HintId {
  return name as HintId;
}

/** What a mission is worth, with only the fields the engine reads. */
export function worth(
  options: {
    basePoints?: number;
    allowPartialCredit?: boolean;
    maxPoints?: number | null;
  } = {},
): MissionScoringPolicy {
  return {
    basePoints: options.basePoints ?? 100,
    allowPartialCredit: options.allowPartialCredit ?? false,
    maxPoints: options.maxPoints ?? null,
  };
}

/** The expedition's half: some rules, a floor, and the missions there are. */
export function expedition(
  rules: ScoringRule[] = [],
  options: { minimumTotal?: number; missions?: string[] } = {},
): ExpeditionScoringPolicy {
  return {
    rules,
    minimumTotal: options.minimumTotal ?? 0,
    missionInstanceIds: (options.missions ?? ['alpha', 'bravo']).map(missionId),
  };
}

/** A verdict, with only the fields the scoring engine reads. */
export function verdictOf(
  outcome: CompletionOutcome,
  options: { progress?: number } = {},
): CompletionVerdict {
  return {
    outcome,
    method: outcome === 'expired' ? 'timer' : 'behaviour',
    trigger:
      outcome === 'correct' ? 'accept' : outcome === 'expired' ? 'expire' : 'reject',
    review: outcome === 'needs-review' ? 'required' : 'none',
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  };
}

/**
 * A mission a team opened and has now been judged on.
 *
 * The history is what the scoring engine reads a speed bonus off, so the
 * `start` goes in at `at(0)` and the caller decides how much later the verdict
 * lands by the `at` it scores with.
 */
export function playedMission(
  name = 'alpha',
  startedAt = at(0),
): MissionProgress {
  const opened = applyMissionTransition(
    createMissionProgress(missionId(name), { state: 'available' }),
    { trigger: 'start', actor: 'team', at: startedAt },
    DEFAULT_MISSION_STATE_POLICY,
  );
  if (!opened.applied) {
    throw new Error(opened.refusal.message);
  }
  return opened.progress;
}

/** A mission nobody has opened, so there is no start to measure from. */
export function unopenedMission(name = 'alpha'): MissionProgress {
  return createMissionProgress(missionId(name), { state: 'available' });
}

/**
 * A team already on a total, with everything else where it starts.
 *
 * The total is put there by an opening event rather than set, because a total
 * that did not come from the stream behind it is one the engine will not
 * make, and a test should not be able to make one either.
 */
export function teamOn(total: number, over: Partial<TeamScore> = {}): TeamScore {
  const opening: ScoreEvent[] =
    total === 0
      ? []
      : [
          {
            reason: 'manual-adjustment',
            points: total,
            at: at(0),
            note: 'Where this team already was.',
          },
        ];
  return { ...createTeamScore(opening), ...over };
}

/** One mission placed in an expedition, for the policy readers to read. */
export function missionInstanceOf(
  name: string,
  scoring: MissionInstance['scoring'],
): MissionInstance {
  return {
    id: missionId(name),
    missionTypeId: 'code-match',
    missionTypeVersion: '1.0.0',
    title: 'A mission',
    brief: 'Do the thing.',
    config: {},
    scoring,
    attempts: { maxAttempts: null },
    verification: 'automatic',
    hints: [],
    media: [],
  };
}

/** A whole definition, holding only what the scoring policy reads off one. */
export function definitionOf(
  missions: MissionInstance[],
  scoring: ExpeditionDefinition['scoring'],
): ExpeditionDefinition {
  return {
    schemaVersion: '1.0.0',
    id: 'expedition' as ExpeditionDefinition['id'],
    definitionVersion: 1,
    status: 'published',
    metadata: {} as ExpeditionDefinition['metadata'],
    missions,
    graph: {} as ExpeditionDefinition['graph'],
    rules: {} as ExpeditionDefinition['rules'],
    scoring,
  };
}
