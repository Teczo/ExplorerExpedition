/**
 * What a client reads back after playing a mission (EXPD-020).
 *
 * Every endpoint here answers with the same shape, because every one of them
 * is the same thing from a phone's point of view: something happened to one
 * mission, and here is where that leaves the team. The engine decided all of
 * it; this file only writes it down in camel case.
 */

import type {
  CompletionVerdict,
  MissionInstanceId,
  MissionProgress,
  MissionState,
  MissionTrigger,
  ProgressionEvent,
  ProgressionSnapshot,
  ScoreEvent,
} from '@explorer/shared-types';

import type {
  AttemptStatus,
  MissionAttemptRow,
  SubmissionRow,
  SubmissionStatus,
} from '../repositories/rows.ts';

/** Where the team stands on the mission, after the change. */
export interface MissionView {
  /** The `MissionInstance.id` from the definition document. */
  readonly id: string;
  readonly state: MissionState;
  readonly attemptsUsed: number;
  /**
   * Every trigger the rules would accept now (EXPD-010).
   *
   * What the student app draws its buttons from, so a team is never shown one
   * that would be refused the moment it is pressed.
   */
  readonly allowedTriggers: readonly MissionTrigger[];
}

/** One try, as a client reads it. */
export interface AttemptView {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  /** When the mission's own time limit runs out. Null when it is untimed. */
  readonly deadlineAt: string | null;
  readonly completedAt: string | null;
  /** What the try was worth, once it was scored. Null until then. */
  readonly awardedPoints: number | null;
}

/** One submission, as a client reads it. The payload is not echoed back. */
export interface SubmissionView {
  readonly id: string;
  readonly status: SubmissionStatus;
  /** Handed in after the run's time was up. */
  readonly isLate: boolean;
  readonly submittedAt: string;
  readonly receivedAt: string;
}

/** A hint the team opened. */
export interface HintView {
  readonly id: string;
  readonly text: string;
  readonly order: number;
  /** What the author says it costs in tokens. Counting tokens is EXPD-046. */
  readonly tokenCost: number;
  /** True when the team had opened it before, so nothing was charged. */
  readonly alreadyOpened: boolean;
}

/** What one change did to the team's score. */
export interface ScoreChangeView {
  /** The team's total after the change. */
  readonly total: number;
  /** Every score event the change wrote, oldest first. Empty when none. */
  readonly events: readonly ScoreEvent[];
}

/** What one change did to what the team may play. */
export interface ProgressionView {
  /** Every door the change opened, oldest first. Empty when none. */
  readonly events: readonly ProgressionEvent[];
  readonly unlockedMissionIds: readonly MissionInstanceId[];
  readonly visibleMissionIds: readonly MissionInstanceId[];
  readonly finished: boolean;
}

/** The answer every endpoint here gives. */
export interface PlayView {
  readonly mission: MissionView;
  /** The try the change was about. Null for a hint on a mission not started. */
  readonly attempt: AttemptView | null;
  /** Present when work was handed in or decided on. */
  readonly submission?: SubmissionView;
  /** Present when work was judged: what the engine concluded, and how. */
  readonly verdict?: CompletionVerdict;
  /** Present when a hint was opened. */
  readonly hint?: HintView;
  readonly score: ScoreChangeView;
  readonly progression: ProgressionView;
}

export function toMissionView(
  progress: MissionProgress,
  allowedTriggers: readonly MissionTrigger[],
): MissionView {
  return {
    id: progress.missionInstanceId,
    state: progress.state,
    attemptsUsed: progress.attemptsUsed,
    allowedTriggers,
  };
}

export function toAttemptView(row: MissionAttemptRow): AttemptView {
  return {
    id: row.id,
    number: row.attempt_number,
    status: row.status,
    startedAt: iso(row.started_at),
    deadlineAt: row.deadline_at === null ? null : iso(row.deadline_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    awardedPoints: row.awarded_points,
  };
}

export function toSubmissionView(row: SubmissionRow): SubmissionView {
  return {
    id: row.id,
    status: row.status,
    isLate: row.is_late,
    submittedAt: iso(row.submitted_at),
    receivedAt: iso(row.received_at),
  };
}

export function toProgressionView(
  events: readonly ProgressionEvent[],
  snapshot: ProgressionSnapshot,
): ProgressionView {
  return {
    events,
    unlockedMissionIds: snapshot.unlockedMissionIds,
    visibleMissionIds: snapshot.visibleMissionIds,
    finished: snapshot.finished,
  };
}

/** A `timestamptz` as ISO 8601 in UTC, whatever the driver handed back. */
function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
