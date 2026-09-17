/**
 * The states one mission can be in for one team (EXPD-010).
 *
 * A *mission instance* (EXPD-002) is one task placed in one expedition. While
 * a class plays, every team has its own view of every mission: one team has
 * finished the museum puzzle, the team behind them has not seen it yet. This
 * file is the closed list of the eight things that view can say.
 *
 * It is here rather than in the engine because everything shows a mission
 * state. The mission board (EXPD-042) draws a badge from it, Director Mode
 * (EXPD-055) counts teams by it, and the API sends it down the realtime
 * channel (EXPD-023). None of those should need the engine to read a word.
 * The rules that say which state may follow which are the engine's, in
 * `@explorer/engine`, because those are game rules.
 *
 * These are *mission* states, not *attempt* states. One mission may be tried
 * several times, and `mission_attempt.status` in migration 0001 tracks one
 * try. A team that got a puzzle wrong twice has two attempt rows and one
 * mission state.
 */

/** Where one mission stands for one team. */
export type MissionState =
  /**
   * The team cannot see it yet.
   *
   * Every mission starts here except the ones the expedition opens with.
   * What opens it is an unlock condition on a graph edge (EXPD-002), and
   * working out whether that condition holds is EXPD-013.
   */
  | 'locked'
  /** The team can see it and may start it. Nothing has been tried yet. */
  | 'available'
  /**
   * The team has opened it and is working on it.
   *
   * A try is running. This is the state a mission's own `timeLimitSeconds`
   * counts down in, because the clock starts when the mission is opened.
   */
  | 'in-progress'
  /** The team has handed work in, and nobody has judged it yet. */
  | 'submitted'
  /**
   * A person has to look at it before it counts.
   *
   * Either the mission type could not decide on its own, or the mission asks
   * for a teacher either way (`verification`, EXPD-002). It sits in the
   * review queue (EXPD-056) until a teacher decides.
   */
  | 'awaiting-verification'
  /** The team got it. Final. */
  | 'complete'
  /**
   * The team did not get it, and has no try left. Final.
   *
   * Two things land here: a wrong answer with no attempts remaining, and a
   * mission whose time ran out while the team was working on it.
   */
  | 'failed'
  /**
   * The team chose to move on without finishing it. Final.
   *
   * Only possible when the expedition's rules allow it (`allowSkip`). A
   * skipped mission scores nothing.
   */
  | 'skipped';

/**
 * Every mission state, in the order they are listed above.
 *
 * The order is the order a team normally passes through them, so a dashboard
 * that groups teams by state can lay the columns out in this order and have
 * it read left to right.
 */
export const MISSION_STATES = [
  'locked',
  'available',
  'in-progress',
  'submitted',
  'awaiting-verification',
  'complete',
  'failed',
  'skipped',
] as const satisfies readonly MissionState[];

/**
 * The states a mission never leaves.
 *
 * A finished mission stays finished. Reopening one is a manual override by a
 * teacher (EXPD-058), which is its own ticket and its own decision to write
 * down; it is not something the rules of the game do on their own.
 */
export const TERMINAL_MISSION_STATES = [
  'complete',
  'failed',
  'skipped',
] as const satisfies readonly MissionState[];

/** Says whether a string is one of the states above. */
export function isMissionState(value: unknown): value is MissionState {
  return typeof value === 'string' && (MISSION_STATES as readonly string[]).includes(value);
}

/** Says whether a mission has finished, whatever the outcome was. */
export function isTerminalMissionState(state: MissionState): boolean {
  return (TERMINAL_MISSION_STATES as readonly MissionState[]).includes(state);
}

/**
 * Says whether the team is waiting on somebody else.
 *
 * True while a submission is being judged. The student app shows a mission
 * like this as pending rather than as something to act on, because there is
 * nothing the team can do about it.
 */
export function isPendingMissionState(state: MissionState): boolean {
  return state === 'submitted' || state === 'awaiting-verification';
}
