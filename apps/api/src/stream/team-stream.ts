/**
 * Writing and reading one team's event stream (EXPD-014).
 *
 * The record a final result is rebuilt from and argued with. The engine seals
 * the lines and checks them; this is what carries them across the system, and
 * what makes the three promises the ticket rests on true of stored rows and
 * not only of values in memory.
 *
 *   **It cannot be edited.** `score_event` and `progression_event` take an
 *   INSERT and nothing else. Migration 0004 attaches the triggers 0003 wrote,
 *   and `TenantRepository` refuses an UPDATE and a DELETE before a statement
 *   is built. There is no method here that changes a line, because there is
 *   no statement that would work.
 *
 *   **It is ordered.** Every line takes the next number in its team's stream,
 *   across both tables. The number and the seal come off `team`, under a row
 *   lock, in the same transaction as the insert — so two phones submitting at
 *   once queue behind each other rather than both claiming place 14. Ordering
 *   by a timestamp instead would not work: two lines can share a millisecond,
 *   and a submission queued offline (EXPD-048) is stamped an hour before the
 *   line that follows it.
 *
 *   **It cannot leave its organisation.** Built on a `TenantRepository`, so
 *   it inherits EXPD-004 whole and has no way to ask for another school's.
 *
 * ```ts
 * await inTransaction(db, async (tx) => {
 *   const stream = teamStream(tenant.withConnection(tx), { teamId, sessionId });
 *   await stream.appendScore(scored.events, { participantId });
 *   await stream.appendProgression(
 *     progressionEventsBetween(before, after, at),
 *   );
 * });
 * ```
 *
 * Appending outside a transaction is refused, because the lock is what makes
 * the numbering hold and a lock outside a transaction is released at once.
 */

import {
  progressionLine,
  replayStream,
  scoreLine,
  sealFrom,
  verifyStream,
} from '@explorer/engine';
import {
  GENESIS_HASH,
  type ProgressionEvent,
  type ScoreEvent,
  type StreamEntry,
  type StreamEvent,
  type StreamResult,
  type StreamVerification,
} from '@explorer/shared-types';
import type { StreamPosition } from '@explorer/engine';

import type { Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  ProgressionEventRow,
  ScoreEventRow,
  TeamStreamHeadRow,
} from '../repositories/rows.ts';
import {
  progressionEventColumns,
  scoreEventColumns,
  toProgressionEvent,
  toScoreEvent,
} from './rows.ts';

/** Which team's stream, and which run it belongs to. */
export interface TeamStreamScope {
  readonly teamId: string;
  readonly expeditionSessionId: string;
}

/** What else a score line names, beyond what the engine's event says. */
export interface ScoreLineContext {
  /** The student whose action caused it, when one did. */
  readonly participantId?: string | null;
  /** The `mission_instance` row the document id resolves to, when it is known. */
  readonly missionInstanceId?: string | null;
  /** The try it was about, as a row. */
  readonly missionAttemptId?: string | null;
  /** The answer it was about, as a row. */
  readonly submissionId?: string | null;
  /** The `hint` row the document id resolves to, when it is known. */
  readonly hintId?: string | null;
  /** The teacher who made it. Required on a `manual-adjustment` by 0001. */
  readonly createdBy?: string | null;
}

/** Thrown when a line would be written outside a transaction. */
export class UnlockedStreamAppendError extends Error {
  override readonly name = 'UnlockedStreamAppendError';

  constructor() {
    super(
      'A line can only be appended to a team stream inside a transaction. The ' +
        'number and the seal are read off the team row under FOR UPDATE, and a ' +
        'lock taken outside a transaction is released before the insert, which ' +
        'is how two lines end up claiming the same place. Wrap the call in ' +
        'inTransaction(db, ...) and build the stream on the transaction.',
    );
  }
}

/** Thrown when the team a stream was opened for is not in this organisation. */
export class UnknownTeamError extends Error {
  override readonly name = 'UnknownTeamError';

  constructor(teamId: string) {
    super(`No team ${teamId} in this organisation, so it has no stream.`);
  }
}

/**
 * The head of a stream as the `team` row keeps it.
 *
 * `StreamPosition` is the engine's half of it — the number and the seal the
 * next line is sealed against — and `totalScore` is the other cache on the
 * same row, read in the same breath so that checking one against the stream
 * does not cost a second query.
 */
export interface TeamStreamHead extends StreamPosition {
  readonly totalScore: number;
}

/**
 * One team's stream.
 *
 * There is no method that changes or removes a line, and no team or
 * organisation to pass to one: both are fixed when it is built.
 */
export class TeamStream {
  readonly #tenant: TenantRepository;
  readonly #scope: TeamStreamScope;
  readonly #locked: boolean;

  constructor(tenant: TenantRepository, scope: TeamStreamScope, locked = false) {
    this.#tenant = tenant;
    this.#scope = scope;
    this.#locked = locked;
  }

  /** Whose stream this is. */
  get teamId(): string {
    return this.#scope.teamId;
  }

  /**
   * The same stream against a transaction, which is the only way to write to
   * it.
   */
  withConnection(db: Queryable): TeamStream {
    return new TeamStream(this.#tenant.withConnection(db), this.#scope, true);
  }

  /** How long the stream is, and what the next line will seal against. */
  async head(options: { readonly forUpdate?: boolean } = {}): Promise<TeamStreamHead> {
    const row = await this.#tenant.findOne<TeamStreamHeadRow>('team', {
      where: { id: this.#scope.teamId },
      columns: ['id', 'total_score', 'stream_length', 'stream_head_hash'],
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
    if (row === null) {
      throw new UnknownTeamError(this.#scope.teamId);
    }
    return {
      sequence: Number(row.stream_length),
      hash: row.stream_head_hash ?? GENESIS_HASH,
      totalScore: row.total_score,
    };
  }

  /**
   * Appends the events one score change produced, and returns the lines.
   *
   * The events come straight off `applyScoreChange`, oldest first. An empty
   * list writes nothing and moves nothing — a wrong answer on an expedition
   * with no `attempt-penalty` rule is applied with nothing to write down.
   */
  async appendScore(
    events: readonly ScoreEvent[],
    context: ScoreLineContext = {},
  ): Promise<readonly StreamEntry[]> {
    return this.#append(
      events.map(scoreLine),
      events.map(() => context),
    );
  }

  /** Appends the doors that opened, and returns the lines. */
  async appendProgression(
    events: readonly ProgressionEvent[],
  ): Promise<readonly StreamEntry[]> {
    return this.#append(
      events.map(progressionLine),
      events.map(() => ({})),
    );
  }

  /**
   * Reads the whole stream back, oldest first.
   *
   * Both tables are read and merged on `stream_sequence`, which is one number
   * line across the two. What comes back is what the engine sealed, so
   * `verifyStream` over it either agrees with every seal or says which line
   * it does not.
   */
  async read(): Promise<readonly StreamEntry[]> {
    const where = {
      team_id: this.#scope.teamId,
      expedition_session_id: this.#scope.expeditionSessionId,
    };
    const orderBy = [{ column: 'stream_sequence', direction: 'asc' as const }];

    const [scores, progressions] = await Promise.all([
      this.#tenant.find<ScoreEventRow>('score_event', { where, orderBy }),
      this.#tenant.find<ProgressionEventRow>('progression_event', { where, orderBy }),
    ]);

    const lines: StreamEntry[] = [
      ...scores.map(
        (row): StreamEntry => ({
          kind: 'score',
          event: toScoreEvent(row),
          sequence: Number(row.stream_sequence),
          previousHash: row.previous_hash,
          hash: row.hash,
        }),
      ),
      ...progressions.map(
        (row): StreamEntry => ({
          kind: 'progression',
          event: toProgressionEvent(row),
          sequence: Number(row.stream_sequence),
          previousHash: row.previous_hash,
          hash: row.hash,
        }),
      ),
    ];

    return lines.sort((one, other) => one.sequence - other.sequence);
  }

  /**
   * Reads the stream and works out what it comes to.
   *
   * The whole of what a results screen (EXPD-059) needs, and the whole of
   * what a team disputing a total should be handed.
   */
  async result(): Promise<StreamResult> {
    return replayStream(await this.read());
  }

  /**
   * Reads the stream and checks it, against the team's kept total as well.
   *
   * `team.total_score` and `team.stream_length` are caches of the stream, the
   * way 0001 already says of the first. This is what catches one of them
   * having drifted, and the stream is what is right.
   */
  async verify(): Promise<StreamVerification> {
    const [lines, head] = await Promise.all([this.read(), this.head()]);
    return verifyStream(lines, { expectedTotal: head.totalScore });
  }

  /**
   * The one place a line is written.
   *
   * Reads the head under a row lock, seals every line against it, inserts
   * them, and writes the head back — all on the connection this stream was
   * built on, which has to be a transaction.
   */
  async #append(
    events: readonly StreamEvent[],
    contexts: readonly ScoreLineContext[],
  ): Promise<readonly StreamEntry[]> {
    if (events.length === 0) {
      return [];
    }
    if (!this.#locked) {
      throw new UnlockedStreamAppendError();
    }

    // The lock is taken here and held to the end of the transaction, so two
    // phones submitting at once queue rather than both claiming one place.
    const head = await this.head({ forUpdate: true });
    // Sealed exactly as the engine would have sealed them had the whole run
    // been in memory: same numbers, same seals, no stream to load first.
    const written = sealFrom(head, events);

    let index = 0;
    for (const entry of written) {
      const shared = {
        expedition_session_id: this.#scope.expeditionSessionId,
        team_id: this.#scope.teamId,
        stream_sequence: entry.sequence,
        previous_hash: entry.previousHash,
        hash: entry.hash,
      };

      if (entry.kind === 'score') {
        const context = contexts[index] ?? {};
        await this.#tenant.insert<ScoreEventRow>('score_event', {
          ...shared,
          ...scoreEventColumns(entry.event),
          participant_id: context.participantId ?? null,
          mission_instance_id: context.missionInstanceId ?? null,
          mission_attempt_id: context.missionAttemptId ?? null,
          submission_id: context.submissionId ?? null,
          hint_id: context.hintId ?? null,
          created_by: context.createdBy ?? null,
        });
      } else {
        await this.#tenant.insert<ProgressionEventRow>('progression_event', {
          ...shared,
          ...progressionEventColumns(entry.event),
        });
      }
      index += 1;
    }

    const last = written.at(-1);
    if (last !== undefined) {
      await this.#tenant.updateById('team', this.#scope.teamId, {
        stream_length: last.sequence,
        stream_head_hash: last.hash,
      });
    }

    return written;
  }
}

/** Opens one team's stream, for reading. Write through `withConnection`. */
export function teamStream(
  tenant: TenantRepository,
  scope: TeamStreamScope,
): TeamStream {
  return new TeamStream(tenant, scope);
}
