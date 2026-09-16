/**
 * Writing and reading the audit log (EXPD-006).
 *
 * The log answers one question, and it has to keep answering it years later:
 * who changed this, and when. Three things make that answer trustworthy, and
 * all three are here or one layer below.
 *
 *   **It cannot be edited.** The table takes an INSERT and nothing else.
 *   Migration 0003 attaches triggers that refuse an UPDATE, a DELETE and a
 *   TRUNCATE, and `TenantRepository` refuses the same two before a statement
 *   is even built. There is no method on this class that changes an entry,
 *   because there is no statement that would work.
 *
 *   **It cannot leave its organisation.** This class is built on a
 *   `TenantRepository`, so every entry it writes is stamped with that
 *   organisation and every entry it reads is filtered by it. One school
 *   cannot read another's log, and the class has no way to ask.
 *
 *   **It says who, not what they look like.** The actor is an id and a short
 *   label; `changes` holds the columns that moved and never a secret or a
 *   child's details. What is left out is `./redact.ts`.
 *
 * Writing an entry is meant to happen in the same transaction as the change
 * it describes, so that neither can exist without the other:
 *
 *     await inTransaction(db, async (tx) => {
 *       const version = await tenant.withConnection(tx).updateById(...);
 *       await audit.withConnection(tx).record('expedition.published', {
 *         entityId: version.id,
 *         after: { status: 'published' },
 *       });
 *     });
 */

import {
  entityTypeOf,
  toId,
  type AuditAction,
  type AuditActor,
  type AuditEntityType,
  type AuditEntry,
  type OrganisationId,
  type ParticipantId,
  type UserId,
} from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type { AuditLogRow } from '../repositories/rows.ts';
import { describeChange, type RowValues } from './redact.ts';

/**
 * Where the action came from: who did it, and from what.
 *
 * Built once per request and reused for every entry that request writes, so
 * that `request_id` ties them together and the whole request reads as one
 * story. `./context.ts` builds one from an Express request.
 */
export interface AuditContext {
  readonly actor: AuditActor;
  /** The caller's address, when the request came over HTTP. */
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** One id shared by every entry written while handling one request. */
  readonly requestId?: string | null;
}

/** What to record about one action. */
export interface RecordAuditInput {
  /** The row it was done to. Absent for an action about no single row. */
  readonly entityId?: string | null;
  /** The row as it was. Absent when it is being created. */
  readonly before?: RowValues;
  /** The row as it now is. Absent when it is being deleted. */
  readonly after?: RowValues;
  /** Why, in the actor's own words. */
  readonly note?: string;
  /**
   * When it happened, if that is not now.
   *
   * Left to the database by default, so that the time on an entry is the
   * database's clock rather than whichever instance served the request.
   */
  readonly occurredAt?: Date;
}

/** What to read back out of the log. */
export interface AuditQuery {
  readonly action?: AuditAction | readonly AuditAction[];
  readonly entityType?: AuditEntityType;
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly requestId?: string;
  /** How many entries. 50 when not given, and never more than 500. */
  readonly limit?: number;
  readonly offset?: number;
}

/** The most entries one read will return, however large a limit is asked for. */
export const MAX_AUDIT_PAGE = 500;

/** The number of entries a read returns when no limit is asked for. */
export const DEFAULT_AUDIT_PAGE = 50;

/**
 * One organisation's audit log.
 *
 * There is no method that changes or removes an entry, and there is no
 * organisation to pass to one: both are fixed by the repository it was built
 * on.
 */
export class AuditLog {
  readonly #tenant: TenantRepository;
  readonly #context: AuditContext;

  constructor(tenant: TenantRepository, context: AuditContext) {
    this.#tenant = tenant;
    this.#context = context;
  }

  /** The organisation every entry is written into and read from. */
  get organisationId(): OrganisationId {
    return this.#tenant.organisationId;
  }

  /** Who the entries this writes will name. */
  get actor(): AuditActor {
    return this.#context.actor;
  }

  /**
   * The same log against a different connection, such as a transaction.
   *
   * This is how an entry ends up in the same transaction as the change it
   * describes: hand both the transaction's `Queryable`.
   */
  withConnection(db: Queryable): AuditLog {
    return new AuditLog(this.#tenant.withConnection(db), this.#context);
  }

  /** The same log for a different actor, keeping the organisation. */
  as(actor: AuditActor): AuditLog {
    return new AuditLog(this.#tenant, { ...this.#context, actor });
  }

  /**
   * Appends one entry and returns it.
   *
   * The entity type is not a parameter: it comes from the action, because
   * `expedition.published` is always about an `expedition_version` and an
   * entry that said otherwise would be one nobody could join back to a row.
   */
  async record(action: AuditAction, input: RecordAuditInput = {}): Promise<AuditLogRow> {
    const entityType = entityTypeOf(action);
    const changes = describeChange(entityType, {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });

    return this.#tenant.insert<AuditLogRow>('audit_log', {
      actor_kind: this.#context.actor.kind,
      actor_user_id: actorUserId(this.#context.actor),
      actor_participant_id: actorParticipantId(this.#context.actor),
      actor_label: actorLabel(this.#context.actor),
      action,
      entity_type: entityType,
      entity_id: input.entityId ?? null,
      changes,
      ip_address: this.#context.ipAddress ?? null,
      user_agent: this.#context.userAgent ?? null,
      request_id: this.#context.requestId ?? null,
      ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt }),
    });
  }

  /**
   * Reads entries, newest first.
   *
   * Ordered by `sequence` rather than by `occurred_at`: it is the database's
   * own counter, so two entries written in the same millisecond still have an
   * order, and a clock that steps backwards cannot reorder history.
   */
  async find(query: AuditQuery = {}): Promise<AuditLogRow[]> {
    return this.#tenant.find<AuditLogRow>('audit_log', {
      where: {
        ...(query.action === undefined
          ? {}
          : { action: query.action as string | readonly string[] }),
        ...(query.entityType === undefined ? {} : { entity_type: query.entityType }),
        ...(query.entityId === undefined ? {} : { entity_id: query.entityId }),
        ...(query.actorUserId === undefined ? {} : { actor_user_id: query.actorUserId }),
        ...(query.requestId === undefined ? {} : { request_id: query.requestId }),
      },
      orderBy: [{ column: 'sequence', direction: 'desc' }],
      limit: pageSize(query.limit),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
  }

  /** Everything that has ever been done to one row, newest first. */
  async findForEntity(
    entityType: AuditEntityType,
    entityId: string,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<AuditLogRow[]> {
    return this.find({ entityType, entityId, ...options });
  }

  /** Everything one request did, in the order it did it. */
  async findForRequest(requestId: string): Promise<AuditLogRow[]> {
    const rows = await this.find({ requestId, limit: MAX_AUDIT_PAGE });
    return [...rows].reverse();
  }
}

/** Builds a log for one organisation and one caller. */
export function auditLog(tenant: TenantRepository, context: AuditContext): AuditLog {
  return new AuditLog(tenant, context);
}

/**
 * Turns a stored row into the shape the apps read.
 *
 * The row is what PostgreSQL returned, column names and all. This is the one
 * place it becomes an `AuditEntry`.
 */
export function toAuditEntry(row: AuditLogRow): AuditEntry {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    organisationId: row.organisation_id as OrganisationId | null,
    actor: actorOf(row),
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    changes: row.changes,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
  };
}

/**
 * How the actor is named in the entry.
 *
 * A participant is always named by id, whatever label a caller passed. A
 * participant is a child, and their name is not something to write into a
 * record that can never be edited (EXPD-071).
 */
export function actorLabel(actor: AuditActor): string {
  switch (actor.kind) {
    case 'user':
      return actor.label ?? `user ${actor.userId}`;
    case 'participant':
      return `participant ${actor.participantId}`;
    default:
      return actor.label;
  }
}

/** The actor's user id, or null for the three kinds that have none. */
function actorUserId(actor: AuditActor): string | null {
  return actor.kind === 'user' ? actor.userId : null;
}

/** The actor's participant id, or null for the three kinds that have none. */
function actorParticipantId(actor: AuditActor): string | null {
  return actor.kind === 'participant' ? actor.participantId : null;
}

/**
 * Rebuilds the actor from the columns it was stored in.
 *
 * The two ids are nullable in the schema and not nullable in the union, which
 * is the right way round: the `CHECK` constraints in 0001 mean a `user` row
 * always has a user id and a `participant` row always has a participant id.
 * An empty string stands in for the case the database has already refused, so
 * that reading an old row can never throw.
 */
function actorOf(row: AuditLogRow): AuditActor {
  switch (row.actor_kind) {
    case 'user':
      return {
        kind: 'user',
        userId: toId<'user'>(row.actor_user_id ?? '') as UserId,
        label: row.actor_label,
      };
    case 'participant':
      return {
        kind: 'participant',
        participantId: toId<'participant'>(row.actor_participant_id ?? '') as ParticipantId,
      };
    default:
      return { kind: row.actor_kind, label: row.actor_label };
  }
}

/** Keeps a read to a size that will not surprise whoever asked for it. */
function pageSize(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_AUDIT_PAGE;
  }
  return Math.max(1, Math.min(limit, MAX_AUDIT_PAGE));
}
