/**
 * What the leaderboard endpoints answer with (EXPD-022).
 *
 * **Display names only.** A leaderboard is shown on a classroom screen and on
 * every phone in the run, so what it carries about a child is the name they
 * typed when they joined and nothing else: no participant id, no device, no
 * account, no role, no leader flag. A team is its name, its id and its
 * figures. The ids of teams and runs are the platform's own keys, not
 * anything about a person.
 *
 * A run's board lists the members of each team by display name, because
 * everybody reading it was in the same room. The expedition's board, which
 * puts several classes side by side, lists no children at all: a team there
 * is its name and the run it played in.
 */

import type {
  LeaderboardTieBreak,
  LeaderboardVisibility,
  SessionStatus,
} from '@explorer/shared-types';

/** One team's line on a board. */
export interface TeamStandingView {
  /** 1 is first. Teams that share a place share a number. */
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly totalScore: number;
  readonly missionsCompleted: number;
  readonly hintsUsed: number;
  readonly failedAttempts: number;
  readonly finished: boolean;
  /** Seconds from the start of the run to the team finishing. Null until it has. */
  readonly finishSeconds: number | null;
}

/** One team's line on a run's board. */
export interface SessionStandingView extends TeamStandingView {
  /** The members' display names, in the order they joined the team. */
  readonly members: readonly string[];
}

/** One run's board. */
export interface SessionLeaderboardView {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly sessionStatus: SessionStatus;
  /** Who may see this board, and when, as the pinned revision says. */
  readonly visibility: LeaderboardVisibility;
  readonly tieBreaks: readonly LeaderboardTieBreak[];
  /** True once the run is over. Its figures will not change again. */
  readonly final: boolean;
  /**
   * Whether this caller may see the board now.
   *
   * When false, `standings` is empty and the rest says why: a phone reading a
   * `teacher-only` or `final-only` board before the end, or any board that is
   * `hidden`.
   */
  readonly shown: boolean;
  /** When the figures were read. */
  readonly generatedAt: string;
  readonly standings: readonly SessionStandingView[];
}

/** One team's line on an expedition's board. */
export interface ExpeditionStandingView extends TeamStandingView {
  /** The run the team played in, as the teacher named it. */
  readonly sessionId: string;
  readonly sessionName: string;
}

/** An expedition's board: every finished run of it, side by side. */
export interface ExpeditionLeaderboardView {
  readonly expeditionId: string;
  /** How many runs the board is drawn from. */
  readonly sessionCount: number;
  /** The tie breaks of the newest revision among those runs. */
  readonly tieBreaks: readonly LeaderboardTieBreak[];
  readonly generatedAt: string;
  /** How many teams are on the board in all, not how many are on this page. */
  readonly total: number;
  readonly limit: number;
  readonly standings: readonly ExpeditionStandingView[];
}
