/**
 * The states a run, a team and a student can be in (EXPD-018).
 *
 * All three lists are the matching enum in
 * `apps/api/db/migrations/0001_core_data_model.sql`, in the same order and
 * with the same spellings, because these values are stored in columns of
 * those types and a value this package invented would be refused by the
 * database.
 *
 * They are only the words. Which change may follow which is somebody else's:
 * a run's lifecycle is EXPD-019, a team's is EXPD-041, and migration 0001
 * says so where it declares the types.
 */

/** The states one run of an expedition passes through. */
export const SESSION_STATUSES = [
  /** Made, but the lobby is not open yet. */
  'scheduled',
  /** Open for students to join. Nobody is playing. */
  'lobby',
  /** Being played. */
  'running',
  /** Being played, with the clock stopped (EXPD-058). */
  'paused',
  /** Over. */
  'ended',
  /** Called off before it was played. */
  'cancelled',
] as const;

/** One of the states a run can be in. */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * The runs a join code can still reach.
 *
 * The same four states migration 0001 puts in
 * `expedition_session_live_join_code_idx`, which is what makes a join code
 * unique among the runs a student could join *right now* rather than for all
 * time. Once a run leaves this list its code goes back in the pool, so the
 * two lists have to stay the same list.
 */
export const JOINABLE_SESSION_STATUSES = [
  'scheduled',
  'lobby',
  'running',
  'paused',
] as const satisfies readonly SessionStatus[];

/** Returns true when a run with this status can still be joined. */
export function isJoinableSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === 'string' &&
    (JOINABLE_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

/** The states one team passes through. */
export const TEAM_STATUSES = [
  /** Being made up. Members can still be added and moved. */
  'forming',
  /** Made up, and waiting for the run to start. */
  'ready',
  /** Playing. */
  'playing',
  /** Reached a finish node, or ran out of time. */
  'finished',
  /** Taken out of the run. */
  'withdrawn',
] as const;

/** One of the states a team can be in. */
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/**
 * The teams that still count against the run's limits.
 *
 * A withdrawn team is a team that was taken out, so it does not use up one of
 * the places `TeamRules.maxTeams` allows.
 */
export const COUNTED_TEAM_STATUSES = [
  'forming',
  'ready',
  'playing',
  'finished',
] as const satisfies readonly TeamStatus[];

/** The states one student in one run passes through. */
export const PARTICIPANT_STATUSES = [
  /** Named ahead of time, and has not typed the code yet. */
  'invited',
  /** Typed the code. In the run, and not necessarily on a team. */
  'joined',
  /** Playing. */
  'active',
  /** Left of their own accord. */
  'left',
  /** Taken out of the run by a teacher. */
  'removed',
] as const;

/** One of the states a student can be in within a run. */
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

/**
 * The students who are still in the run.
 *
 * What "how many students are in this run" counts, and what a team's size is
 * measured against. Somebody who has left and somebody who was removed are
 * both out, and neither holds a place open.
 */
export const PRESENT_PARTICIPANT_STATUSES = [
  'invited',
  'joined',
  'active',
] as const satisfies readonly ParticipantStatus[];

/** Returns true when a student with this status is still in the run. */
export function isPresentParticipantStatus(
  value: unknown,
): value is ParticipantStatus {
  return (
    typeof value === 'string' &&
    (PRESENT_PARTICIPANT_STATUSES as readonly string[]).includes(value)
  );
}
