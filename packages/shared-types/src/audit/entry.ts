/**
 * What one line of the audit log is (EXPD-006).
 *
 * An entry is a sentence with four parts: somebody did something to some row
 * at some time. This file is the shape of that sentence — who, what, to what,
 * and what changed — in the vocabulary every app speaks. The writing of it is
 * `apps/api/src/audit`, because only the API touches the table.
 *
 * Two rules run through the whole shape, and both come from the fact that an
 * entry is permanent:
 *
 *   1. **An entry outlives the rows it names.** The actor is a label as well
 *      as an id, so the entry still names somebody after the account is
 *      deleted, and `entityId` is a plain id with no foreign key behind it.
 *   2. **An entry is not a copy of the row.** `changes` holds the columns
 *      that moved, not the row itself, and never a secret or a child's
 *      details. What is left out is `apps/api/src/audit/redact.ts`, and
 *      EXPD-071 will widen it.
 */

import type { OrganisationId, ParticipantId, UserId } from '../auth/principal.ts';
import type { AuditAction, AuditEntityType } from './actions.ts';

/**
 * The kinds of actor the log knows about.
 *
 * Copied from the `audit_actor_kind` enum in
 * `apps/api/db/migrations/0001_core_data_model.sql`, in the same order.
 */
export const AUDIT_ACTOR_KINDS = ['user', 'participant', 'system', 'service'] as const;

/** One of the values `audit_log.actor_kind` holds. */
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** A person with an account. */
export interface UserAuditActor {
  readonly kind: 'user';
  readonly userId: UserId;
  /**
   * How to name them in the log once the account is gone.
   *
   * A staff member's own display name, and nothing more. Absent is fine: the
   * writer falls back to the id.
   */
  readonly label?: string;
}

/**
 * A student, acting from their phone.
 *
 * There is no label, on purpose. A participant is a child, and their name is
 * not something to write into a permanent record (EXPD-071). The writer
 * labels them by id.
 */
export interface ParticipantAuditActor {
  readonly kind: 'participant';
  readonly participantId: ParticipantId;
}

/** The platform itself: the engine scoring an attempt, a scheduled job. */
export interface SystemAuditActor {
  readonly kind: 'system';
  /** Which part of the platform, such as `scoring-engine`. */
  readonly label: string;
}

/** Something outside the platform, such as a Stripe webhook (EXPD-068). */
export interface ServiceAuditActor {
  readonly kind: 'service';
  /** Which service, such as `stripe`. */
  readonly label: string;
}

/**
 * Whoever caused the entry.
 *
 * The union is what holds the two `CHECK` constraints in the schema: a `user`
 * entry cannot be written without a user id, and a `participant` entry cannot
 * be written without a participant id, because there is no way to build one.
 */
export type AuditActor =
  | UserAuditActor
  | ParticipantAuditActor
  | SystemAuditActor
  | ServiceAuditActor;

/**
 * A value small enough to keep forever.
 *
 * Scalars only. A column holding a document — an expedition definition, a
 * submission payload — is recorded as a marker saying it changed, not as a
 * copy of itself, because the log is read a year later and a copy would both
 * dwarf the entry and freeze data somebody may have asked to have deleted.
 */
export type AuditValue = string | number | boolean | null;

/**
 * What changed, as columns rather than as a row.
 *
 * `before` and `after` hold the same column names, and only the ones that
 * differ. A creation has no `before`; a deletion has no `after`.
 */
export interface AuditChanges {
  readonly before?: Readonly<Record<string, AuditValue>>;
  readonly after?: Readonly<Record<string, AuditValue>>;
  /** Why, in the actor's own words, when they were asked for a reason. */
  readonly note?: string;
}

/**
 * One line of the log, as a reader gets it.
 *
 * `sequence` is the database's own counter, and it is what to sort by: two
 * entries written in the same millisecond still have an order, and a clock
 * that steps backwards cannot reorder history.
 */
export interface AuditEntry {
  readonly id: string;
  readonly sequence: number;
  /**
   * Null on an action that belongs to the platform rather than to any one
   * organisation. Nothing widens a read to include those.
   */
  readonly organisationId: OrganisationId | null;
  readonly actor: AuditActor;
  /** How the actor was named at the time, kept even if the account is gone. */
  readonly actorLabel: string;
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  /** Null when the action is about no single row. */
  readonly entityId: string | null;
  readonly changes: AuditChanges;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Ties an entry to one API request, so a whole request reads as one story. */
  readonly requestId: string | null;
  readonly occurredAt: Date;
}

/** Returns true when the value is an actor kind this file lists. */
export function isAuditActorKind(value: unknown): value is AuditActorKind {
  return (
    typeof value === 'string' && (AUDIT_ACTOR_KINDS as readonly string[]).includes(value)
  );
}
