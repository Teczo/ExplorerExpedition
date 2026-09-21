/**
 * The table a run's own lifecycle lives in (EXPD-019).
 *
 * `expedition_session`, written and read, plus one read of
 * `expedition_version` for the rules the run is pinned to. The students, the
 * teams and the memberships belong to EXPD-018 and are reached through
 * `ParticipationRepository`; making and publishing an expedition belongs to
 * EXPD-017 and is reached through `ExpeditionRepository`. This file exists so
 * that the lifecycle has one place its statements are written, not so that it
 * has its own copy of everybody else's.
 *
 * Every call goes through a `TenantRepository`, so the organisation predicate
 * is on every statement whether this file remembers it or not (EXPD-004).
 * There is no method here that takes an organisation, because there is
 * nowhere for one to come from but the token.
 *
 * One shape decides almost everything below: migration 0001's three CHECK
 * constraints tie `status` to the times beside it.
 *
 *     (status = 'paused')                  = (paused_at IS NOT NULL)
 *     (status IN ('ended', 'cancelled'))   = (ended_at IS NOT NULL)
 *     status IN ('running', 'paused')     → started_at IS NOT NULL   (0005)
 *
 * A status and the time that goes with it therefore have to move in the same
 * statement, and `applyTransition` is the only method that writes a status
 * for exactly that reason. Writing one and then the other would be two
 * statements, and the first of them would be refused.
 */

import type { SessionStatus } from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  ExpeditionSessionRow,
  ExpeditionVersionRow,
} from '../repositories/rows.ts';

/** What making a run needs. */
export interface NewSession {
  readonly expeditionId: string;
  /** The revision it is pinned to. Fixed for the life of the run. */
  readonly expeditionVersionId: string;
  readonly name: string;
  readonly joinCode: string;
  /** `lobby` for a run made to be played now, `scheduled` for one made for later. */
  readonly status: SessionStatus;
  readonly scheduledStartAt: Date | null;
  /** The teacher running it. Also the one Director Mode belongs to (EXPD-055). */
  readonly hostUserId: string;
  readonly createdBy: string;
}

/**
 * A status and every time that has to move with it.
 *
 * Each field is optional and each one that is present is written, including
 * the ones written as NULL — clearing `paused_at` is how a resume ends a
 * pause, and it is as much a part of the change as the status is.
 */
export interface SessionTransition {
  readonly status: SessionStatus;
  readonly startedAt?: Date;
  readonly pausedAt?: Date | null;
  readonly pausedSecondsTotal?: number;
  readonly endedAt?: Date | null;
}

/** How to page through a list of runs. */
export interface SessionPage {
  readonly status?: SessionStatus;
  /** Only the runs of one expedition. Absent means every expedition's. */
  readonly expeditionId?: string;
  readonly limit: number;
  readonly offset: number;
}

/** The runs of one organisation. */
export class SessionRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /** The same repository against a different connection, such as a transaction. */
  withConnection(db: Queryable): SessionRepository {
    return new SessionRepository(this.#tenant.withConnection(db));
  }

  /** One page of runs, newest first. */
  async listSessions(page: SessionPage): Promise<ExpeditionSessionRow[]> {
    return this.#tenant.find<ExpeditionSessionRow>('expedition_session', {
      where: filterOf(page),
      orderBy: [
        { column: 'created_at', direction: 'desc' },
        { column: 'id', direction: 'desc' },
      ],
      limit: page.limit,
      offset: page.offset,
    });
  }

  /** How many runs the same filter matches, for the page count. */
  async countSessions(page: Omit<SessionPage, 'limit' | 'offset'>): Promise<number> {
    return this.#tenant.count('expedition_session', filterOf(page));
  }

  /** One run, or null when this organisation has no such row. */
  async findSession(
    id: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.findOne<ExpeditionSessionRow>('expedition_session', {
      where: { id },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /**
   * Adds a run.
   *
   * The five clock columns are written as an empty clock rather than left to
   * the column defaults. They have the same defaults, so this changes
   * nothing the database would have done — what it buys is that the row the
   * INSERT hands back is a whole run, with no column that reads as absent
   * until somebody reads it again.
   */
  async insertSession(input: NewSession): Promise<ExpeditionSessionRow> {
    return this.#tenant.insert<ExpeditionSessionRow>('expedition_session', {
      expedition_id: input.expeditionId,
      expedition_version_id: input.expeditionVersionId,
      name: input.name,
      join_code: input.joinCode,
      status: input.status,
      host_user_id: input.hostUserId,
      scheduled_start_at: input.scheduledStartAt,
      started_at: null,
      paused_at: null,
      paused_seconds_total: 0,
      extended_seconds_total: 0,
      ended_at: null,
      created_by: input.createdBy,
    });
  }

  /**
   * Moves a run to another state, and every time that goes with it.
   *
   * One statement, because the constraints listed at the top of this file
   * would refuse it as two. Whether the move is allowed at all is
   * `sessionStatusAfter` in `@explorer/shared-types`, checked by the service
   * before this is called: this method writes what it is given.
   */
  async applyTransition(
    id: string,
    transition: SessionTransition,
  ): Promise<ExpeditionSessionRow | null> {
    const values: Record<string, string | number | Date | null> = {
      status: transition.status,
    };
    if (transition.startedAt !== undefined) {
      values['started_at'] = transition.startedAt;
    }
    if (transition.pausedAt !== undefined) {
      values['paused_at'] = transition.pausedAt;
    }
    if (transition.pausedSecondsTotal !== undefined) {
      values['paused_seconds_total'] = transition.pausedSecondsTotal;
    }
    if (transition.endedAt !== undefined) {
      values['ended_at'] = transition.endedAt;
    }

    return this.#tenant.updateById<ExpeditionSessionRow>(
      'expedition_session',
      id,
      values,
    );
  }

  /**
   * The revision a run is pinned to, document and all.
   *
   * Read for one thing: `rules.timing` is what the clock is held to. It is a
   * large read for a small answer, and it is still the right one — the
   * alternative is a copy of the timing on the run, and a copy is a thing
   * that can disagree with the document it was copied from. The same
   * reasoning, and the same read, as `ParticipationRepository` makes for
   * `rules.teams`.
   */
  async findPinnedVersion(
    expeditionVersionId: string,
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findById<ExpeditionVersionRow>(
      'expedition_version',
      expeditionVersionId,
    );
  }

  /**
   * The revisions a page of runs is pinned to, in one read.
   *
   * A list of runs shows a clock beside each one, and a clock needs the
   * revision's limit — so without this a page of twenty-five runs would be
   * twenty-six statements. Two runs of the same expedition share a revision,
   * so the caller hands over the set rather than the list.
   */
  async findPinnedVersions(
    expeditionVersionIds: readonly string[],
  ): Promise<ExpeditionVersionRow[]> {
    if (expeditionVersionIds.length === 0) {
      return [];
    }
    return this.#tenant.find<ExpeditionVersionRow>('expedition_version', {
      where: { id: expeditionVersionIds },
    });
  }

  /**
   * Writes the total time a run has been given.
   *
   * The whole total rather than the amount added, because the service has
   * already read the row `FOR UPDATE` inside the transaction and adding in
   * SQL would need a statement `TenantRepository` does not build. The lock is
   * what makes two teachers pressing the button at once add up to both
   * extensions rather than to one.
   */
  async setExtendedSeconds(
    id: string,
    seconds: number,
  ): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.updateById<ExpeditionSessionRow>('expedition_session', id, {
      extended_seconds_total: seconds,
    });
  }
}

/** The filter a list and its count share, so the two cannot disagree. */
function filterOf(page: Omit<SessionPage, 'limit' | 'offset'>): Record<string, string> {
  return {
    ...(page.status === undefined ? {} : { status: page.status }),
    ...(page.expeditionId === undefined ? {} : { expedition_id: page.expeditionId }),
  };
}

/** Builds the repository from the one the middleware made. */
export function sessionRepository(tenant: TenantRepository): SessionRepository {
  return new SessionRepository(tenant);
}
