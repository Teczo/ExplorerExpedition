/**
 * What an expedition endpoint actually does (EXPD-017).
 *
 * The rules of the ticket live here, and there are only three of them.
 *
 *   **An expedition is its revisions.** The `expedition` row keeps the id and
 *   nothing else worth reading; every word of it is in a revision. Creating
 *   one writes both: the expedition, and revision 1 as a draft.
 *
 *   **A draft is the newest revision, and there is at most one.** Saving
 *   writes over it. When the newest revision is published there is no draft
 *   to write over, so a save starts one at the next number — the published
 *   revision is not touched, and anybody playing it goes on playing it.
 *
 *   **Publishing freezes a revision.** The draft becomes published, is
 *   stamped with the time and the person, and from that moment nothing in
 *   this file will write to it again. A published revision is refused a save,
 *   refused a second publish, and copied out flat (`./projection.ts`) so that
 *   a run can point at its missions.
 *
 * Publishing is the one place a document has to be a valid Expedition
 * Definition. A draft is allowed to be halfway through — that is what a draft
 * is for — so a save stores whatever it was given and answers with
 * everything wrong with it, and publishing refuses while that list is not
 * empty.
 *
 * Every write here is one transaction, and the audit entry (EXPD-006) is
 * inside it, so a change and the record of who made it cannot exist without
 * each other.
 */

import {
  assertExpeditionDefinition,
  type AuthoringSource,
  type ExpeditionStatus,
  type JsonObject,
  type UserPrincipal,
} from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import { tenantRepository, type TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound, ValidationError, type FieldIssue } from '../http/errors.ts';
import type { ExpeditionRow, ExpeditionVersionRow } from '../repositories/rows.ts';
import {
  issuesInDocument,
  schemaVersionOf,
  seal,
  summaryOf,
  type DocumentSeal,
} from './documents.ts';
import {
  ExpeditionRepository,
  type ExpeditionPage,
  type ExpeditionVersionSummaryRow,
} from './expedition-repository.ts';
import { clear, MissionTypeResolver, project } from './projection.ts';
import {
  toExpeditionView,
  toVersionView,
  type ExpeditionDocumentView,
  type ExpeditionListView,
  type ExpeditionView,
} from './views.ts';

/** Where a document sits in a request body, for the paths in an error. */
const DOCUMENT_PATH = 'definition';

/** The most expeditions one list will return, however large a limit is asked. */
export const MAX_EXPEDITION_PAGE = 100;

/** The number of expeditions a list returns when no limit is asked for. */
export const DEFAULT_EXPEDITION_PAGE = 25;

/** What creating an expedition needs. */
export interface CreateExpeditionInput {
  readonly definition: JsonObject;
  /** How it came to exist. `studio` when the caller does not say. */
  readonly source?: AuthoringSource;
}

/** What one request may do to expeditions. */
export class ExpeditionService {
  readonly #db: Queryable;
  readonly #expeditions: ExpeditionRepository;
  readonly #tenant: TenantRepository;
  readonly #audit: AuditLog;
  readonly #principal: UserPrincipal;

  constructor(options: {
    /**
     * The connection transactions are opened on.
     *
     * The repositories are built on the request's own `TenantRepository`, and
     * this is the same connection underneath. A write rebuilds them against
     * the transaction with `withConnection`, which is the only way their
     * statements end up inside it.
     */
    readonly db: Queryable;
    readonly tenant: TenantRepository;
    readonly audit: AuditLog;
    readonly principal: UserPrincipal;
  }) {
    this.#db = options.db;
    this.#tenant = options.tenant;
    this.#expeditions = new ExpeditionRepository(options.tenant);
    this.#audit = options.audit;
    this.#principal = options.principal;
  }

  // --- Reading ------------------------------------------------------------

  /**
   * One page of this organisation's expeditions, most recently changed first.
   *
   * Three statements whatever the page holds: the count, the page, and one
   * read of the revisions belonging to everything on it. The documents are
   * left in the database — a list prints titles, and the titles are copied
   * onto the revision rows for exactly this reason.
   */
  async list(page: ExpeditionPage): Promise<ExpeditionListView> {
    const total = await this.#expeditions.countExpeditions(page.status);
    const rows = await this.#expeditions.listExpeditions(page);
    const versions = await this.#expeditions.listVersionsFor(
      rows.map((row) => row.id),
    );

    const byExpedition = new Map<string, ExpeditionVersionSummaryRow[]>();
    for (const version of versions) {
      const existing = byExpedition.get(version.expedition_id);
      if (existing === undefined) {
        byExpedition.set(version.expedition_id, [version]);
      } else {
        existing.push(version);
      }
    }

    return {
      expeditions: rows.map((row) =>
        toExpeditionView(row, byExpedition.get(row.id) ?? []),
      ),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  /** One expedition. Throws `not-found` when this organisation has no such row. */
  async read(expeditionId: string): Promise<ExpeditionView> {
    const row = await this.#requireExpedition(this.#expeditions, expeditionId);
    const versions = await this.#expeditions.listVersions(expeditionId);
    return toExpeditionView(row, versions);
  }

  /** Every revision of one expedition, newest first, without the documents. */
  async listVersions(expeditionId: string): Promise<ExpeditionVersionSummaryRow[]> {
    await this.#requireExpedition(this.#expeditions, expeditionId);
    return this.#expeditions.listVersions(expeditionId);
  }

  /** One revision, document and all. */
  async readVersion(
    expeditionId: string,
    definitionVersion: number,
  ): Promise<ExpeditionDocumentView> {
    await this.#requireExpedition(this.#expeditions, expeditionId);
    const version = await this.#expeditions.findVersion(
      expeditionId,
      definitionVersion,
    );
    if (version === null) {
      throw notFound('revision');
    }
    return this.#documentView(version);
  }

  /**
   * The revision being worked on.
   *
   * Throws `not-found` when the newest revision is published: there is no
   * draft until somebody saves one, and answering with the published document
   * instead would be answering a different question.
   */
  async readDraft(expeditionId: string): Promise<ExpeditionDocumentView> {
    await this.#requireExpedition(this.#expeditions, expeditionId);
    const version = await this.#expeditions.findLatestVersion(expeditionId);
    if (version === null || version.status !== 'draft') {
      throw notFound('draft revision');
    }
    return this.#documentView(version);
  }

  // --- Writing ------------------------------------------------------------

  /**
   * Creates an expedition, and revision 1 as a draft.
   *
   * The document is sealed before it is stored: the id it is stored under is
   * the row's, not whatever the client called it, and the authoring block
   * says who really made it. See `./documents.ts`.
   */
  async create(input: CreateExpeditionInput): Promise<ExpeditionDocumentView> {
    const source = input.source ?? 'studio';

    return this.#write(async (expeditions, tenant, audit, types) => {
      const expedition = await expeditions.insertExpedition({
        createdBy: this.#principal.userId,
        source,
      });

      const document = seal(input.definition, {
        expeditionId: expedition.id,
        definitionVersion: 1,
        status: 'draft',
        organisationId: this.#principal.organisationId,
        createdBy: this.#principal.userId,
        createdAt: asDate(expedition.created_at),
        updatedBy: this.#principal.userId,
        updatedAt: new Date(),
        source,
      });

      const version = await expeditions.insertVersion({
        expeditionId: expedition.id,
        definitionVersion: 1,
        schemaVersion: schemaVersionOf(document),
        status: 'draft',
        definition: document,
        createdBy: this.#principal.userId,
        ...summaryOf(document),
      });

      const issues = await this.#writeFlatCopy(tenant, version.id, document, types);

      await audit.record('expedition.created', {
        entityId: expedition.id,
        after: {
          status: 'draft',
          source,
          title: version.title,
          definition_version: 1,
        },
      });

      return { version, definition: document, issues };
    });
  }

  /**
   * Saves a document over the draft, starting one when there is none.
   *
   * Whether this writes over revision 3 or starts revision 4 is not the
   * caller's to decide and not something they can tell from the request. It
   * follows from whether the newest revision has been published, and the
   * answer comes back in `version.definitionVersion`.
   */
  async saveDraft(
    expeditionId: string,
    definition: JsonObject,
  ): Promise<ExpeditionDocumentView> {
    return this.#write(async (expeditions, tenant, audit, types) => {
      const expedition = await this.#requireExpedition(expeditions, expeditionId, {
        forUpdate: true,
      });
      const latest = await expeditions.findLatestVersion(expeditionId, {
        forUpdate: true,
      });

      const startsNewRevision = latest === null || latest.status !== 'draft';
      const definitionVersion =
        latest === null ? 1 : Number(latest.definition_version) + (startsNewRevision ? 1 : 0);

      const document = seal(definition, {
        ...this.#sealFor(expedition),
        definitionVersion,
        status: 'draft',
      });
      const summary = summaryOf(document);
      const schemaVersion = schemaVersionOf(document);

      const version = startsNewRevision
        ? await expeditions.insertVersion({
            expeditionId,
            definitionVersion,
            schemaVersion,
            status: 'draft',
            definition: document,
            createdBy: this.#principal.userId,
            ...summary,
          })
        : await expeditions.replaceDraftDocument(latest.id, {
            schemaVersion,
            definition: document,
            ...summary,
          });

      if (version === null) {
        throw notFound('draft revision');
      }

      const issues = await this.#writeFlatCopy(tenant, version.id, document, types);
      await expeditions.touchExpedition(expeditionId, {
        updatedBy: this.#principal.userId,
      });

      await audit.record('expedition.updated', {
        entityId: expeditionId,
        before: {
          title: latest?.title ?? '',
          definition_version: latest === null ? null : Number(latest.definition_version),
        },
        after: { title: version.title, definition_version: definitionVersion },
      });

      return { version, definition: document, issues };
    });
  }

  /**
   * Freezes the draft.
   *
   * Refused two ways, and they are different refusals on purpose. A document
   * that is not a valid Expedition Definition is answered 422 with every
   * problem and the path to it, because the author can fix those. An
   * expedition whose newest revision is already published is answered 409:
   * nothing is wrong with the request, there is simply nothing to publish.
   */
  async publish(expeditionId: string): Promise<ExpeditionDocumentView> {
    return this.#write(async (expeditions, tenant, audit, types) => {
      const expedition = await this.#requireExpedition(expeditions, expeditionId, {
        forUpdate: true,
      });
      const draft = await expeditions.findLatestVersion(expeditionId, {
        forUpdate: true,
      });

      if (draft === null || draft.status !== 'draft') {
        throw new ApiError('conflict', {
          message:
            'There is no draft to publish. Save a change first, which starts the next revision.',
          detail: `expedition ${expeditionId} has no draft revision`,
        });
      }

      const publishedAt = new Date();
      const document = seal(draft.definition, {
        ...this.#sealFor(expedition),
        definitionVersion: Number(draft.definition_version),
        status: 'published',
        publishedAt,
      });

      const issues = issuesInDocument(document, DOCUMENT_PATH);
      if (issues.length > 0) {
        throw new ValidationError(
          issues,
          'This expedition cannot be published while there is something wrong with it.',
        );
      }

      const version = await expeditions.publishVersion(draft.id, {
        definition: document,
        publishedAt,
        publishedBy: this.#principal.userId,
      });
      if (version === null) {
        throw notFound('draft revision');
      }

      // The document has just been validated, so the flat copy cannot be the
      // half-written kind the database would refuse.
      await project(tenant, version.id, assertExpeditionDefinition(document), types);

      await expeditions.touchExpedition(expeditionId, {
        updatedBy: this.#principal.userId,
        status: 'published',
      });

      await audit.record('expedition.published', {
        entityId: version.id,
        before: { status: 'draft' },
        after: {
          status: 'published',
          definition_version: Number(version.definition_version),
          title: version.title,
        },
      });

      return { version, definition: document, issues: [] };
    });
  }

  // --- The parts every write shares ---------------------------------------

  /**
   * Runs a write inside one transaction.
   *
   * Everything the work touches is rebuilt against the transaction first, the
   * audit log included, so that the change and the record of it are one
   * commit. A `Queryable` that hands out a different connection per statement
   * would break that promise, and the ticket that adds the driver has to hand
   * `createApp` something that does not.
   */
  async #write(
    work: (
      expeditions: ExpeditionRepository,
      tenant: TenantRepository,
      audit: AuditLog,
      types: MissionTypeResolver,
    ) => Promise<{
      readonly version: ExpeditionVersionRow;
      readonly definition: JsonObject;
      readonly issues: readonly FieldIssue[];
    }>,
  ): Promise<ExpeditionDocumentView> {
    const result = await inTransaction(this.#db, async (tx) =>
      work(
        this.#expeditions.withConnection(tx),
        this.#tenant.withConnection(tx),
        this.#audit.withConnection(tx),
        this.#missionTypesOn(tx),
      ),
    );

    return {
      version: toVersionView(result.version),
      definition: result.definition,
      issues: result.issues,
    };
  }

  /**
   * Writes the flat copy of a revision, or clears it, and says what is wrong.
   *
   * A draft that does not validate keeps no copy at all. The database would
   * refuse most half-finished drafts anyway — two start nodes, a node holding
   * a mission that was deleted — and a stale copy would be worse than none:
   * something else would go on pointing at missions the author has removed.
   */
  async #writeFlatCopy(
    tenant: TenantRepository,
    versionId: string,
    document: JsonObject,
    types: MissionTypeResolver,
  ): Promise<readonly FieldIssue[]> {
    const issues = issuesInDocument(document, DOCUMENT_PATH);
    if (issues.length > 0) {
      await clear(tenant, versionId);
      return issues;
    }

    await project(tenant, versionId, assertExpeditionDefinition(document), types);
    return [];
  }

  /** What the platform writes into a document, for an expedition that exists. */
  #sealFor(expedition: ExpeditionRow): Omit<DocumentSeal, 'definitionVersion' | 'status'> {
    return {
      expeditionId: expedition.id,
      organisationId: this.#principal.organisationId,
      createdBy: expedition.created_by ?? this.#principal.userId,
      createdAt: asDate(expedition.created_at),
      updatedBy: this.#principal.userId,
      updatedAt: new Date(),
      source: expedition.source,
    };
  }

  /** One revision, with its document and everything wrong with it. */
  #documentView(version: ExpeditionVersionRow): ExpeditionDocumentView {
    return {
      version: toVersionView(version),
      definition: version.definition,
      issues: issuesInDocument(version.definition, DOCUMENT_PATH),
    };
  }

  /** The expedition, or `not-found`. Another organisation's is not found. */
  async #requireExpedition(
    expeditions: ExpeditionRepository,
    expeditionId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionRow> {
    const row = await expeditions.findExpedition(expeditionId, options);
    if (row === null) {
      throw notFound('expedition');
    }
    return row;
  }

  /**
   * The mission type registry, read on one connection.
   *
   * Built with `includeSharedRows`, which is the one read in this ticket that
   * has to see a row belonging to no organisation: `qr-hunt` belongs to the
   * platform, and a scope that could not see it could not resolve any mission
   * to a registry row. It widens reads only — `TenantRepository` never widens
   * a write — and nothing here writes to `mission_type` anyway.
   */
  #missionTypesOn(db: Queryable): MissionTypeResolver {
    return new MissionTypeResolver(
      tenantRepository(db, {
        organisationId: this.#principal.organisationId,
        includeSharedRows: true,
      }),
    );
  }
}

/**
 * A `timestamptz` as a `Date`, whatever the driver handed back.
 *
 * `pg` hands back a `Date`. The column is `NOT NULL DEFAULT now()`, so the
 * absent case is not a row that has no creation time — it is a read that did
 * not ask for the column — and now is the closest true answer to give a
 * document being written this second.
 */
function asDate(value: Date | string | null | undefined): Date {
  if (value === null || value === undefined) {
    return new Date();
  }
  return value instanceof Date ? value : new Date(value);
}

/** Reads a page from what a request asked for. */
export function expeditionPage(options: {
  readonly status?: ExpeditionStatus;
  readonly limit?: number;
  readonly offset?: number;
}): ExpeditionPage {
  return {
    ...(options.status === undefined ? {} : { status: options.status }),
    limit: Math.max(1, Math.min(options.limit ?? DEFAULT_EXPEDITION_PAGE, MAX_EXPEDITION_PAGE)),
    offset: Math.max(0, options.offset ?? 0),
  };
}
