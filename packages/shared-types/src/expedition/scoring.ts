/**
 * How points are earned and lost.
 *
 * This file describes the *shape* of a scoring setup. Working out what a team
 * actually scored is the scoring engine's job (EXPD-012), and writing the
 * score events down is EXPD-014. Neither belongs here.
 *
 * Points are always whole numbers. The schema has no fractional scores, so no
 * client ever has to decide how to round one.
 */

import type { MissionInstanceId, ScoringRuleId, Seconds } from './common.ts';

/** What a single mission is worth. */
export interface MissionScoring {
  /** Points awarded for finishing the mission. Must not be negative. */
  basePoints: number;
  /**
   * Whether a partly correct answer can earn part of the points.
   *
   * When true the mission type decides how much. When false the mission is
   * worth `basePoints` or nothing.
   */
  allowPartialCredit: boolean;
  /**
   * The most this mission can ever be worth, bonuses included.
   *
   * Left out when there is no cap. When set it must be at least `basePoints`.
   */
  maxPoints?: number;
}

/** Which missions a rule applies to. */
export type ScoringRuleTarget =
  /** Every mission in the expedition. */
  | { kind: 'all' }
  /** Only the missions listed. */
  | { kind: 'missions'; missionInstanceIds: MissionInstanceId[] };

/**
 * One expedition-wide rule that adds or removes points.
 *
 * Each rule is a tagged object. A reader switches on `type` and gets the
 * fields that belong to that type, and no others.
 */
export type ScoringRule =
  /** Extra points for finishing a mission quickly. */
  | {
      id: ScoringRuleId;
      type: 'speed-bonus';
      target: ScoringRuleTarget;
      /** The time a team has to beat, measured from opening the mission. */
      withinSeconds: Seconds;
      /** Points added when they beat it. Must be positive. */
      points: number;
    }
  /** Extra points for the first team to finish a mission. */
  | {
      id: ScoringRuleId;
      type: 'first-to-complete-bonus';
      target: ScoringRuleTarget;
      points: number;
    }
  /** Extra points for finishing several missions in a row without a failure. */
  | {
      id: ScoringRuleId;
      type: 'streak-bonus';
      /** How many in a row are needed. Must be at least two. */
      length: number;
      points: number;
    }
  /** Extra points for finishing every mission the rule targets. */
  | {
      id: ScoringRuleId;
      type: 'completion-bonus';
      target: ScoringRuleTarget;
      points: number;
    }
  /** Points removed for each hint a team spends a token on. */
  | {
      id: ScoringRuleId;
      type: 'hint-penalty';
      target: ScoringRuleTarget;
      /** Points removed per hint. Must be positive, and is subtracted. */
      pointsPerHint: number;
    }
  /** Points removed for each wrong answer. */
  | {
      id: ScoringRuleId;
      type: 'attempt-penalty';
      target: ScoringRuleTarget;
      /** Points removed per failed attempt. Must be positive. */
      pointsPerFailedAttempt: number;
    }
  /** Points removed for finishing after the expedition's time limit. */
  | {
      id: ScoringRuleId;
      type: 'late-penalty';
      /** How long after the limit before the penalty starts. */
      graceSeconds: Seconds;
      /** Points removed for every minute past the grace period. */
      pointsPerMinute: number;
    };

/** The `type` of a scoring rule. */
export type ScoringRuleType = ScoringRule['type'];

/** Every scoring rule type, in the order they are listed above. */
export const SCORING_RULE_TYPES = [
  'speed-bonus',
  'first-to-complete-bonus',
  'streak-bonus',
  'completion-bonus',
  'hint-penalty',
  'attempt-penalty',
  'late-penalty',
] as const;

/** How two teams on the same score are separated. */
export type LeaderboardTieBreak =
  /** The team that finished sooner is placed higher. */
  | 'earliest-finish'
  /** The team that finished more missions is placed higher. */
  | 'most-missions-completed'
  /** The team that spent fewer hint tokens is placed higher. */
  | 'fewest-hints-used'
  /** The team that had fewer wrong answers is placed higher. */
  | 'fewest-failed-attempts';

/** Who can see the leaderboard, and when. */
export type LeaderboardVisibility =
  /** Everyone sees it update as the expedition runs. */
  | 'live'
  /** Only the teacher sees it until the expedition ends. */
  | 'teacher-only'
  /** Nobody sees it until the expedition ends. */
  | 'final-only'
  /** There is no leaderboard. */
  | 'hidden';

/** How the leaderboard behaves (EXPD-022, EXPD-045). */
export interface LeaderboardConfig {
  visibility: LeaderboardVisibility;
  /**
   * How ties are broken, tried in order.
   *
   * When every tie break leaves two teams equal, they share a place.
   */
  tieBreaks: LeaderboardTieBreak[];
}

/** The whole scoring setup for one expedition. */
export interface ScoringConfig {
  /**
   * Expedition-wide rules that adjust the total. May be empty.
   *
   * Rules are applied in the order they appear. That order matters when a
   * mission has a `maxPoints` cap, because a cap applies to whatever the
   * running total is at that point.
   */
  rules: ScoringRule[];
  /**
   * The lowest score a team can end on.
   *
   * Penalties stop taking points away once a team reaches it. Usually zero.
   */
  minimumTotal: number;
  leaderboard: LeaderboardConfig;
}

/** Every leaderboard tie break. */
export const LEADERBOARD_TIE_BREAKS = [
  'earliest-finish',
  'most-missions-completed',
  'fewest-hints-used',
  'fewest-failed-attempts',
] as const;

/** Every leaderboard visibility. */
export const LEADERBOARD_VISIBILITIES = [
  'live',
  'teacher-only',
  'final-only',
  'hidden',
] as const;
