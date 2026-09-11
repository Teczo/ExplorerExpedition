/**
 * How an expedition is played.
 *
 * Rules cover the parts of play that are not tied to a single mission: how
 * teams are formed, when the clock runs, how far ahead a team may skip, and
 * what happens to a submission that arrives late.
 *
 * The engine reads these. Enforcing them is EXPD-010 and EXPD-019.
 */

import type { IntRange, Seconds } from './common.ts';

/** How freely a team may move through the graph. */
export type ProgressionMode =
  /**
   * One mission at a time, in graph order.
   *
   * A team sees the next stop only once the one before it is finished.
   */
  | 'strict'
  /**
   * Every stop whose edges are satisfied is open at once.
   *
   * A team may choose which of the open missions to do first.
   */
  | 'open'
  /**
   * Every mission is open from the start.
   *
   * Edges and their conditions are ignored during play. The graph is then
   * only a way of grouping missions for the author.
   */
  | 'free-roam';

/** When teams start playing. */
export type StartMode =
  /** Every team starts at the moment the teacher begins the expedition. */
  | 'synchronised'
  /** Each team starts when it finishes joining. */
  | 'on-join';

/** What ends the expedition. */
export type EndMode =
  /** It runs until the teacher stops it. */
  | 'teacher-ends'
  /** It ends for a team when that team reaches a finish node. */
  | 'first-finish-node'
  /** It ends for everybody when the time limit runs out. */
  | 'time-limit'
  /** It ends for everybody when every team has reached a finish node. */
  | 'all-teams-finished';

/** What happens to work handed in after time is up. */
export type LateSubmissionPolicy =
  /** It is not accepted at all. */
  | 'reject'
  /** It is accepted and scored in full. */
  | 'accept'
  /** It is accepted, and the late penalty scoring rule applies. */
  | 'accept-with-penalty';

/** How teams are made up. */
export interface TeamRules {
  /** How many students may be on one team. */
  size: IntRange;
  /**
   * The largest number of teams in one run.
   *
   * `null` means no limit beyond the organisation's seat count (EXPD-069).
   */
  maxTeams: number | null;
  /**
   * The role names a team may hand out, such as `navigator`.
   *
   * May be empty, which means the expedition uses no roles. What a role lets
   * a student do is EXPD-041.
   */
  roles: string[];
  /**
   * Whether every member has to be present before the team may start.
   */
  requireFullTeamToStart: boolean;
}

/** When the clock starts and stops. */
export interface TimingRules {
  startMode: StartMode;
  endMode: EndMode;
  /**
   * How long the whole expedition may run.
   *
   * Required when `endMode` is `time-limit`. Optional otherwise, where it acts
   * as a backstop.
   */
  totalTimeLimitSeconds?: Seconds;
  /**
   * A countdown shown to every team before play begins.
   *
   * Only used when `startMode` is `synchronised`.
   */
  countdownSeconds?: Seconds;
}

/** How hint tokens are handed out (EXPD-046). */
export interface HintRules {
  /** When false, hints are hidden and no mission hint can be opened. */
  enabled: boolean;
  /**
   * How many tokens each team begins with.
   *
   * Ignored when `enabled` is false.
   */
  tokensPerTeam: number;
  /**
   * How often a team is given one more token.
   *
   * Left out means tokens are never topped up.
   */
  refillEverySeconds?: Seconds;
}

/** How work is handed in and reviewed. */
export interface SubmissionRules {
  /**
   * Whether a teacher has to review every submission before it scores.
   *
   * A mission may ask for review on its own through its `verification` field.
   * Setting this to true turns review on for every mission regardless.
   */
  requireReviewForAll: boolean;
  latePolicy: LateSubmissionPolicy;
  /**
   * Whether a team may hand in work while its device has no signal, for the
   * app to send once signal returns (EXPD-048).
   */
  allowOfflineQueue: boolean;
}

/** Every rule that shapes how an expedition is played. */
export interface ExpeditionRules {
  progression: ProgressionMode;
  /**
   * Whether a team may skip a mission and move on without finishing it.
   *
   * A skipped mission scores nothing. Ignored when `progression` is
   * `free-roam`, because nothing is blocking the team in the first place.
   */
  allowSkip: boolean;
  teams: TeamRules;
  timing: TimingRules;
  hints: HintRules;
  submissions: SubmissionRules;
}

/** Every progression mode. */
export const PROGRESSION_MODES = ['strict', 'open', 'free-roam'] as const;

/** Every start mode. */
export const START_MODES = ['synchronised', 'on-join'] as const;

/** Every end mode. */
export const END_MODES = [
  'teacher-ends',
  'first-finish-node',
  'time-limit',
  'all-teams-finished',
] as const;

/** Every late submission policy. */
export const LATE_SUBMISSION_POLICIES = [
  'reject',
  'accept',
  'accept-with-penalty',
] as const;
