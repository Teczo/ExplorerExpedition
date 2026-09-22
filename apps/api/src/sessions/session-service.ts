/**
 * What a lifecycle endpoint actually does (EXPD-019).
 *
 * The rules of the ticket live here, and there are five of them.
 *
 *   **A run is made against a published revision, and pinned to it.** You
 *   cannot put a draft in front of a class. The revision the run is pinned to
 *   is the one that was newest when it was made, and publishing another one
 *   the next morning does not move a lesson that is under way.
 *
 *   **One table says which state may follow which.** `SESSION_TRANSITIONS` in
 *   `@explorer/shared-types`, read here through `sessionStatusAfter`. No
 *   method below has its own opinion about whether a run may be paused; each
 *   one asks the table, and a refusal is `409` with the state the run is
 *   actually in.
 *
 *   **Pausing stops the clock, it does not move the end.** A resume adds the
 *   pause it just ended to `paused_seconds_total`, and everything that counts
 *   time takes that total back out. A run paused for twenty minutes finishes
 *   twenty minutes later than it would have, and no team loses a second of
 *   play. `session-clock.ts` is where that arithmetic lives.
 *
 *   **Time given on the day is the run's, not the document's.** The limit a
 *   class plays to is the pinned revision's
 *   `rules.timing.totalTimeLimitSeconds` plus the run's
 *   `extended_seconds_total`. The document is frozen, and a teacher waiting
 *   for a late coach is not editing it.
 *
 *   **Ending is final, and ending a run that never started is cancelling
 *   it.** There is no reopening: a class that wants to play again gets a new
 *   run, with a new code and a clean sheet, which is what a second lesson is.
 *
 * Every write is one transaction, and the audit entry (EXPD-006) is inside
 * it, so a change and the record of who made it cannot exist without each
 * other. Every write also reads the run `FOR UPDATE` first, which is what
 * makes two teachers pressing *pause* at the same moment produce one pause
 * rather than two.
 *
 * One thing this file does not do: it does not end a run whose time is up.
 * `clock.expired` says so and the run goes on being `running` until somebody
 * ends it. There is no timer in the API, and a lesson that ended itself while
 * every phone was in a tunnel would be the worse behaviour. Turning `expired`
 * into an ending is Director Mode's (EXPD-055) or a live trigger's
 * (EXPD-057).
 *
 * And one thing it deliberately leaves alone: the teams. Starting a run does
 * not move a team from `forming` to `playing`, and ending one does not mark
 * anybody `finished`. Which change may follow which for a *team* is EXPD-041,
 * exactly as `statuses.ts` says, and a lifecycle that quietly rewrote team
 * rows would be that ticket built here by the back door.
 */

import {
  isFinalSessionStatus,
  sessionStatusAfter,
  SESSION_TRANSITIONS,
  type SessionCommand,
  type SessionStatus,
  type TimingRules,
  type UserPrincipal,
} from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound } from '../http/errors.ts';
import { ExpeditionRepository } from '../expeditions/expedition-repository.ts';
import { allocateJoinCode } from '../participation/join-codes.ts';
import type { JoinCodeDirectory } from '../participation/join-code-directory.ts';
import type { ExpeditionSessionRow } from '../repositories/rows.ts';
import {
  currentPauseSeconds,
  sessionClock,
  type SessionClock,
} from './session-clock.ts';
import {
  SessionRepository,
  type SessionPage,
  type SessionTransition,
} from './session-repository.ts';
import { DEFAULT_TIMING_RULES, timingRulesOf } from './timing-rules.ts';
import { toSessionView, type SessionListView, type SessionView } from './views.ts';

/** The most a run's name may be. Migration 0001 stores it as free text. */
export const MAX_SESSION_NAME = 120;

/** The most runs one list will return, however large a limit is asked for. */
export const MAX_SESSION_PAGE = 100;

/** The number of runs a list returns when no limit is asked for. */
export const DEFAULT_SESSION_PAGE = 25;

/**
 * The most time one extension may add.
 *
 * Four hours, which is longer than any lesson and shorter than any mistake
 * worth catching. A teacher who really needs more presses the button twice,
 * and the second press is a second line in the audit log — which is the
 * behaviour wanted from a number that decides when thirty children stop
 * playing.
 */
export const MAX_EXTENSION_SECONDS = 14_400;

/** What making a run needs. */
export interface CreateSessionInput {
  readonly expeditionId: string;
  /** What the teacher calls it, such as `Year 6 — Tuesday`. */
  readonly name?: string;
  /**
   * When the teacher means to run it.
   *
   * Nothing acts on it: no job opens a lobby and no job starts a run, because
   * a lesson starts when a teacher says so and not when a calendar does. What
   * it decides is the state the run opens in — see `openingStatus`.
   */
  readonly scheduledStartAt?: Date;
}

/** What extending a run needs. */
export interface ExtendSessionInput {
  readonly seconds: number;
  /** Why, in the teacher's own words. Goes on the audit entry. */
  readonly reason?: string;
}

/** What one staff request may do to a run's lifecycle. */
export class SessionService {
  readonly #db: Queryable;
  readonly #sessions: SessionRepository;
  readonly #expeditions: ExpeditionRepository;
  readonly #directory: JoinCodeDirectory;
  readonly #audit: AuditLog;
  readonly #principal: UserPrincipal;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Queryable;
    readonly tenant: TenantRepository;
    /** Join codes across every organisation. Allocating one is not scoped. */
    readonly directory: JoinCodeDirectory;
    /**
     * The log every write here appends to.
     *
     * It already names the caller: `auditScope` built it from the principal,
     * so there is nothing for this class to be told about who is calling and
     * no way for it to name somebody else.
     */
    readonly audit: AuditLog;
    /** The caller, for `host_user_id` and `created_by`. */
    readonly principal: UserPrincipal;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#sessions = new SessionRepository(options.tenant);
    this.#expeditions = new ExpeditionRepository(options.tenant);
    this.#directory = options.directory;
    this.#audit = options.audit;
    this.#principal = options.principal;
    this.#now = options.now ?? (() => new Date());
  }

  // --- Reading ------------------------------------------------------------

  /**
   * One page of this organisation's runs, newest first.
   *
   * Three statements whatever the page holds: the count, the page, and one
   * read of the revisions everything on it is pinned to. Every run on the
   * page is dated from the same `now`, so a dashboard drawing thirty clocks
   * is not drawing them from thirty different moments.
   */
  async list(page: SessionPage): Promise<SessionListView> {
    const { limit, offset, ...filter } = page;
    const total = await this.#sessions.countSessions(filter);
    const rows = await this.#sessions.listSessions(page);
    const rules = await this.#timingByVersion(this.#sessions, rows);

    const now = this.#now();
    const sessions = rows.map((row) =>
      toSessionView(
        row,
        clockOf(row, rules.get(row.expedition_version_id) ?? DEFAULT_TIMING_RULES, now),
        nextStatusesOf(row),
      ),
    );

    return { sessions, total, limit, offset };
  }

  /** One run, with its clock worked out as of now. */
  async read(sessionId: string): Promise<SessionView> {
    const session = await this.#requireSession(this.#sessions, sessionId);
    return this.#viewOf(this.#sessions, session, this.#now());
  }

  // --- Making one ---------------------------------------------------------

  /**
   * Schedules a run of an expedition.
   *
   * Three things are decided here and never again. The revision, which is the
   * newest published one and is pinned from this moment. The code, which is
   * allocated against every joinable run rather than against this
   * organisation's, because the index it has to satisfy is not scoped to one.
   * And the state it opens in: a run made for a time still to come waits in
   * `scheduled`, and a run made for now opens its lobby straight away. Both
   * are joinable and both can be started, so the difference is what a teacher
   * sees on a dashboard rather than what a student can do.
   *
   * An expedition with nothing published is refused, and the message says so
   * rather than saying the expedition does not exist: the teacher is looking
   * at it, and "publish it first" is the whole answer.
   */
  async create(input: CreateSessionInput): Promise<SessionView> {
    const name = (input.name ?? '').trim();
    const scheduledStartAt = input.scheduledStartAt ?? null;

    return inTransaction(this.#db, async (tx) => {
      const sessions = this.#sessions.withConnection(tx);
      const expeditions = this.#expeditions.withConnection(tx);

      const expedition = await expeditions.findExpedition(input.expeditionId);
      if (expedition === null) {
        throw notFound('expedition');
      }

      const version = await expeditions.findPublishedVersion(expedition.id);
      if (version === null) {
        throw new ApiError('conflict', {
          message:
            'This expedition has no published revision, so there is nothing ' +
            'for a class to play. Publish it first.',
          detail: `expedition ${expedition.id} has no published version`,
        });
      }

      const directory = this.#directory.withConnection(tx);
      const joinCode = await allocateJoinCode((candidate) =>
        directory.isJoinCodeTaken(candidate, {
          reason:
            'schedule: a join code has to be unique across every joinable run, ' +
            'not only this organisation’s',
        }),
      );

      const session = await sessions.insertSession({
        expeditionId: expedition.id,
        expeditionVersionId: version.id,
        name,
        joinCode,
        status: openingStatus(scheduledStartAt, this.#now()),
        scheduledStartAt,
        hostUserId: this.#principal.userId,
        createdBy: this.#principal.userId,
      });

      await this.#audit.withConnection(tx).record('session.scheduled', {
        entityId: session.id,
        after: {
          expedition_id: session.expedition_id,
          expedition_version_id: session.expedition_version_id,
          status: session.status,
          scheduled_start_at: scheduledStartAt,
        },
      });

      return this.#viewOf(sessions, session, this.#now());
    });
  }

  // --- The five things a teacher does to one ------------------------------

  /**
   * Begins play.
   *
   * The clock starts now, whatever `scheduled_start_at` said: a lesson starts
   * when the teacher says so. A run that is already running is refused rather
   * than restarted, because a second start would move `started_at` forwards
   * and hand every team back the time they had already used.
   */
  async start(sessionId: string): Promise<SessionView> {
    return this.#command(sessionId, 'start', 'session.started', (session, now) => ({
      status: 'running',
      startedAt: session.started_at ?? now,
    }));
  }

  /**
   * Stops the clock, leaving the run where it is.
   *
   * Nothing else stops. A team that is halfway through a mission stays
   * halfway through it, and what a paused run lets a student's app do is
   * EXPD-047's question rather than this one's. What pausing promises here is
   * only this: the seconds that pass from now until the resume are not
   * counted against anybody's time.
   */
  async pause(sessionId: string): Promise<SessionView> {
    return this.#command(sessionId, 'pause', 'session.paused', (_session, now) => ({
      status: 'paused',
      pausedAt: now,
    }));
  }

  /**
   * Starts the clock again.
   *
   * The pause that has just ended is added to `paused_seconds_total` and
   * `paused_at` is cleared, in the same statement as the status — migration
   * 0001 pairs the two, so they cannot move one at a time.
   */
  async resume(sessionId: string): Promise<SessionView> {
    return this.#command(sessionId, 'resume', 'session.resumed', (session, now) => ({
      status: 'running',
      pausedAt: null,
      pausedSecondsTotal:
        session.paused_seconds_total + currentPauseSeconds(session.paused_at, now),
    }));
  }

  /**
   * Stops the run for good.
   *
   * A run that was never started is `cancelled` rather than `ended`: it was
   * called off, and a result nobody played for should not be filed beside the
   * ones that were. Either way the code goes back in the pool, because
   * migration 0001's unique index covers the joinable states only.
   *
   * Ending a paused run folds the pause that is still open into the total
   * first, so a run that was paused when it was stopped reports the same
   * elapsed time as one that was resumed a moment before it was stopped.
   */
  async end(sessionId: string): Promise<SessionView> {
    return this.#command(sessionId, 'end', 'session.ended', (session, now) => {
      const started = session.started_at !== null;
      return {
        status: started ? 'ended' : 'cancelled',
        endedAt: now,
        ...(session.paused_at === null
          ? {}
          : {
              pausedAt: null,
              pausedSecondsTotal:
                session.paused_seconds_total +
                currentPauseSeconds(session.paused_at, now),
            }),
      };
    });
  }

  /**
   * Gives every team in a run more time.
   *
   * Only a run being played can be extended — before the start there is
   * nothing counting down, and after the end there is nothing to give time
   * to. Only a run with a limit can be extended either: adding ten minutes to
   * a run that ends when the teacher says so would be a number nothing reads,
   * and answering `409` says that out loud rather than storing it.
   *
   * There is no action in EXPD-006's vocabulary for extending a run, so this
   * is recorded as `session.overridden` — which is what it is: a teacher
   * changing, on the day, a number the author wrote. Widening the vocabulary
   * is EXPD-006's to do rather than this ticket's, the same line EXPD-018
   * drew over reissuing a code.
   */
  async extend(sessionId: string, input: ExtendSessionInput): Promise<SessionView> {
    return inTransaction(this.#db, async (tx) => {
      const sessions = this.#sessions.withConnection(tx);
      const session = await this.#requireSession(sessions, sessionId, {
        forUpdate: true,
      });
      const rules = await this.#timingOf(sessions, session);

      this.#assertCanTake(session, 'extend');

      if (rules.totalTimeLimitSeconds === undefined) {
        throw new ApiError('conflict', {
          message:
            'This expedition has no time limit, so there is no clock to add ' +
            'time to. It runs until you end it.',
          detail: `run ${session.id} plays a revision with no totalTimeLimitSeconds`,
        });
      }

      const before = session.extended_seconds_total;
      const after = before + input.seconds;
      const extended = await sessions.setExtendedSeconds(session.id, after);

      await this.#audit.withConnection(tx).record('session.overridden', {
        entityId: session.id,
        before: { extended_seconds_total: before },
        after: { extended_seconds_total: after },
        ...(input.reason === undefined || input.reason === ''
          ? {}
          : { note: input.reason }),
      });

      return this.#viewOf(sessions, extended ?? session, this.#now());
    });
  }

  // --- The pieces the methods above share ---------------------------------

  /**
   * The shape every state change has.
   *
   * Read the run and lock it, ask the table whether the change is allowed,
   * write the status and the times together, write the audit entry — all in
   * one transaction. Each method above supplies only the part that is its
   * own: which times move, and what to call the entry.
   */
  async #command(
    sessionId: string,
    command: SessionCommand,
    action: 'session.started' | 'session.paused' | 'session.resumed' | 'session.ended',
    transitionOf: (session: ExpeditionSessionRow, now: Date) => SessionTransition,
  ): Promise<SessionView> {
    return inTransaction(this.#db, async (tx) => {
      const sessions = this.#sessions.withConnection(tx);
      const session = await this.#requireSession(sessions, sessionId, {
        forUpdate: true,
      });

      this.#assertCanTake(session, command);

      const now = this.#now();
      const transition = transitionOf(session, now);
      const moved = await sessions.applyTransition(session.id, transition);

      await this.#audit.withConnection(tx).record(action, {
        entityId: session.id,
        before: {
          status: session.status,
          started_at: session.started_at,
          paused_at: session.paused_at,
          paused_seconds_total: session.paused_seconds_total,
          ended_at: session.ended_at,
        },
        after: {
          status: transition.status,
          started_at: transition.startedAt ?? session.started_at,
          paused_at:
            transition.pausedAt === undefined ? session.paused_at : transition.pausedAt,
          paused_seconds_total:
            transition.pausedSecondsTotal ?? session.paused_seconds_total,
          ended_at: transition.endedAt ?? session.ended_at,
        },
      });

      return this.#viewOf(sessions, moved ?? session, now);
    });
  }

  /**
   * Refuses a command the run cannot take, and says what state it is in.
   *
   * A run that is over is told apart from one that is simply in the wrong
   * state, because the two are different problems for a teacher: one is "you
   * already stopped this" and the other is "press start first".
   */
  #assertCanTake(session: ExpeditionSessionRow, command: SessionCommand): void {
    const next = sessionStatusAfter(session.status, command, {
      started: session.started_at !== null,
    });
    if (next !== null) {
      return;
    }

    throw new ApiError('conflict', {
      message: isFinalSessionStatus(session.status)
        ? 'That run is over. A class that wants to play again needs a new run.'
        : `A run that is ${describe(session.status)} cannot be ${PAST[command]}.`,
      detail: `run ${session.id} is ${session.status}; ${command} is not a move it can make`,
    });
  }

  /** One run and its clock, as a client reads it. */
  async #viewOf(
    sessions: SessionRepository,
    session: ExpeditionSessionRow,
    now: Date,
  ): Promise<SessionView> {
    const rules = await this.#timingOf(sessions, session);
    return toSessionView(session, clockOf(session, rules, now), nextStatusesOf(session));
  }

  /** The timing the run's pinned revision lays down. */
  async #timingOf(
    sessions: SessionRepository,
    session: ExpeditionSessionRow,
  ): Promise<TimingRules> {
    const version = await sessions.findPinnedVersion(session.expedition_version_id);
    return timingRulesOf(version === null ? null : version.definition);
  }

  /** The same, for a page of runs, in one read rather than one each. */
  async #timingByVersion(
    sessions: SessionRepository,
    rows: readonly ExpeditionSessionRow[],
  ): Promise<Map<string, TimingRules>> {
    const ids = [...new Set(rows.map((row) => row.expedition_version_id))];
    const versions = await sessions.findPinnedVersions(ids);
    return new Map(
      versions.map((version) => [version.id, timingRulesOf(version.definition)]),
    );
  }

  /**
   * One run, or `404`.
   *
   * Another organisation's run answers `404` rather than `403`, for the
   * reason EXPD-017 gives: "you may not touch that" would be telling
   * Riverbank Academy that Portside School has a run with that id.
   */
  async #requireSession(
    sessions: SessionRepository,
    sessionId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionSessionRow> {
    const session = await sessions.findSession(sessionId, options);
    if (session === null) {
      throw notFound('run');
    }
    return session;
  }
}

/** The clock of one run, read through the columns `session-clock.ts` wants. */
export function clockOf(
  session: ExpeditionSessionRow,
  rules: TimingRules,
  now: Date,
): SessionClock {
  return sessionClock(
    {
      status: session.status,
      startedAt: session.started_at,
      pausedAt: session.paused_at,
      pausedSecondsTotal: session.paused_seconds_total,
      extendedSecondsTotal: session.extended_seconds_total,
      endedAt: session.ended_at,
    },
    rules,
    now,
  );
}

/** The states a run may move to next. */
export function nextStatusesOf(
  session: ExpeditionSessionRow,
): readonly SessionStatus[] {
  return SESSION_TRANSITIONS[session.status];
}

/**
 * The state a new run opens in.
 *
 * A run made for a time still to come waits in `scheduled`; one made for now,
 * or with no time given at all, opens its lobby. Nothing moves a run from the
 * first to the second, because nothing here runs on a schedule — the two
 * states are both joinable and both can be started, so the difference is what
 * a teacher sees on a dashboard rather than what a student can do.
 */
export function openingStatus(
  scheduledStartAt: Date | null,
  now: Date,
): SessionStatus {
  return scheduledStartAt !== null && scheduledStartAt.getTime() > now.getTime()
    ? 'scheduled'
    : 'lobby';
}

/** Turns a page's query into the numbers a repository takes. */
export function sessionPage(query: {
  readonly status?: SessionStatus;
  readonly expeditionId?: string;
  readonly limit?: number;
  readonly offset?: number;
}): SessionPage {
  return {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.expeditionId === undefined ? {} : { expeditionId: query.expeditionId }),
    limit: Math.min(query.limit ?? DEFAULT_SESSION_PAGE, MAX_SESSION_PAGE),
    offset: query.offset ?? 0,
  };
}

/** A run's state, in the words a message to a teacher uses. */
function describe(status: SessionStatus): string {
  switch (status) {
    case 'scheduled':
      return 'scheduled and has not started';
    case 'lobby':
      return 'waiting in its lobby';
    case 'running':
      return 'already running';
    case 'paused':
      return 'paused';
    default:
      return status;
  }
}

/** What a command reads as once it has happened, for a refusal message. */
const PAST: Readonly<Record<SessionCommand, string>> = {
  start: 'started',
  pause: 'paused',
  resume: 'resumed',
  extend: 'given more time',
  end: 'ended',
};
