/**
 * What the two documents say about what a mission is worth (EXPD-012).
 *
 * Scoring reads from two places, and they answer two different questions.
 * `MissionInstance.scoring` says what one mission is worth on its own — its
 * base points, whether part of it can be earned, and the most it can ever add
 * up to. `ScoringConfig` on the expedition says everything that is not about
 * one mission — the rules that add and remove points across the run, and the
 * floor a team's total cannot go below.
 *
 * They are gathered into two small values for the same two reasons
 * `MissionStatePolicy` (EXPD-010) and `MissionCompletionPolicy` (EXPD-011)
 * gather theirs: the scoring engine has no business reading a mission's
 * title, its hints or its submission schema, and the simulation harness
 * (EXPD-015) wants to turn a `speed-bonus` up without building a whole
 * expedition to turn it on.
 *
 * **The engine reads these and never the documents.** Reading `basePoints`
 * off a `MissionInstance` in one place and off a policy in another is how the
 * two would come to disagree.
 *
 * Everything else in those documents belongs elsewhere. `leaderboard` is
 * EXPD-022's and EXPD-045's — how a score is shown and how two equal ones are
 * separated is not how either was earned. `HintRules.tokensPerTeam` is
 * EXPD-046's: how many tokens a team holds is an inventory, and what spending
 * one costs in points is the `hint-penalty` rule below.
 */

import type {
  ExpeditionDefinition,
  MissionInstance,
  MissionInstanceId,
  ScoringConfig,
  ScoringRule,
  ScoringRuleTarget,
} from '@explorer/shared-types';

/** What one mission is worth on its own. */
export interface MissionScoringPolicy {
  /** What finishing it earns. Never negative. */
  readonly basePoints: number;
  /**
   * Whether a partly right answer earns part of those points.
   *
   * When false the mission is worth `basePoints` or nothing, whatever the
   * mission type said about how much of it was done.
   */
  readonly allowPartialCredit: boolean;
  /**
   * The most this mission can ever add to the total, bonuses included.
   *
   * `null` when there is no cap, which is what `MissionScoring` means by
   * leaving `maxPoints` out.
   */
  readonly maxPoints: number | null;
}

/** Everything about scoring that is not about one mission. */
export interface ExpeditionScoringPolicy {
  /**
   * The expedition's scoring rules, in the order the document lists them.
   *
   * The order is part of the answer, not a detail of how they are stored: a
   * mission's cap applies to whatever the mission has added up to by the time
   * a rule fires, so a bonus listed before another can take the room the
   * second one wanted.
   */
  readonly rules: readonly ScoringRule[];
  /**
   * The lowest total a team can end on.
   *
   * Penalties stop taking points away once a team reaches it.
   */
  readonly minimumTotal: number;
  /**
   * Every mission in the expedition.
   *
   * Needed because a rule may target `all`, and "every mission" is a fact
   * about the expedition rather than about the rule. A `completion-bonus`
   * over `all` cannot know when a team has finished the lot without it.
   */
  readonly missionInstanceIds: readonly MissionInstanceId[];
}

/**
 * What a mission is worth when nobody says otherwise.
 *
 * Nothing. A caller that forgets to pass a policy gets a mission that pays no
 * points rather than one that quietly pays a number nobody chose, the same
 * caution the other two defaults take.
 */
export const DEFAULT_MISSION_SCORING_POLICY: MissionScoringPolicy = {
  basePoints: 0,
  allowPartialCredit: false,
  maxPoints: null,
};

/**
 * What an expedition scores under when nobody says otherwise.
 *
 * No rules, a floor of nought, and no missions to finish. Base points still
 * land; nothing adds to or takes from them.
 */
export const DEFAULT_EXPEDITION_SCORING_POLICY: ExpeditionScoringPolicy = {
  rules: [],
  minimumTotal: 0,
  missionInstanceIds: [],
};

/** Reads what one mission is worth out of the mission that holds it. */
export function missionScoringPolicyFor(mission: MissionInstance): MissionScoringPolicy {
  const scoring = mission.scoring;
  return {
    basePoints: scoring?.basePoints ?? 0,
    allowPartialCredit: scoring?.allowPartialCredit === true,
    maxPoints: scoring?.maxPoints ?? null,
  };
}

/**
 * Reads the expedition's half out of the document that holds it.
 *
 * It takes the whole definition rather than its `scoring` alone because the
 * list of missions is the other half of what an `all` target means, and that
 * list is `definition.missions`.
 */
export function expeditionScoringPolicyFor(
  definition: ExpeditionDefinition,
): ExpeditionScoringPolicy {
  const scoring: ScoringConfig | undefined = definition.scoring;
  return {
    rules: scoring?.rules ?? [],
    minimumTotal: scoring?.minimumTotal ?? 0,
    missionInstanceIds: (definition.missions ?? []).map((mission) => mission.id),
  };
}

/** Says whether a rule's target covers one mission. */
export function targetCoversMission(
  target: ScoringRuleTarget | undefined,
  missionInstanceId: MissionInstanceId,
): boolean {
  if (target === undefined || target.kind === 'all') {
    return true;
  }
  return target.missionInstanceIds.includes(missionInstanceId);
}

/**
 * The missions a rule's target names.
 *
 * An `all` target names every mission in the expedition, which is why the
 * policy carries that list.
 */
export function missionsTargetedBy(
  target: ScoringRuleTarget | undefined,
  policy: ExpeditionScoringPolicy,
): readonly MissionInstanceId[] {
  if (target === undefined || target.kind === 'all') {
    return policy.missionInstanceIds;
  }
  return target.missionInstanceIds;
}
