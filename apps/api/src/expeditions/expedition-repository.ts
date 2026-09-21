/**
 * Reading and writing expeditions and their revisions (EXPD-017).
 *
 * Two tables, and the rule that ties them together: `expedition` is the thing
 * that keeps its id forever, and `expedition_version` is what can actually be
 * edited. A revision carries the whole EXPD-002 document, so every read here
 * says whether it wants the document or only the line about it —
 * `VERSION_SUMMARY_COLUMNS` is the read that leaves the document behind, and
 * a list of fifty expeditions uses it rather than loading fifty documents to
 * print fifty titles.
 *
 * Every call goes through a `TenantRepository`, so the organisation predicate
 * is on every statement whether this file remembers it or not (EXPD-004).
 * There is no method here that takes an organisation, because there is
 * nowhere for one to come from but the token.
 */

import type { ExpeditionStatus, JsonObject } from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import type { SqlValue } from '../db/sql.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type { ExpeditionRow, ExpeditionVersionRow } from '../repositories/rows.ts';

/**
 * Every column of `expedition_version` except the document itself.
 *
 * `definition` is the largest thing the API stores, and nothing that draws a
 * list needs it. Spelled out rather than subtracted from `*`, because a
 * column added by a later migration should have to be named here before it is
 * read into a summary.
 */
export const VERSION_SUMMARY_COLUMNS: readonly string[] = [
  'id',
  'organisation_id',
  'expedition_id',
  'definition_version',
  'schema_version',
  'status',
  'title',
  'summary',
  'locale',
  'published_at',
  'published_by',
  'created_by',
  'created_at',
  'updated_at',
];

/** A revision with the document left behind. */
export type ExpeditionVersionSummaryRow = Omit<ExpeditionVersionRow, 'definition'>;

/** What a new expedition needs. */
export interface NewExpedition {
  readonly createdBy: string;
  readonly source: string;
}

/** What a new revision needs. */
export interface NewExpeditionVersion {
  readonly expeditionId: string;
  readonly definitionVersion: number;
  readonly schemaVersion: string;
  readonly status: ExpeditionStatus;
  readonly definition: JsonObject;
  readonly title: string;
  readonly summary: string;
  readonly locale: string;
  readonly createdBy: string;
}

/** How to page through a list. */
export interface ExpeditionPage {
  readonly status?: ExpeditionStatus;
  readonly limit: number;
  readonly offset: number;
}

/** Expeditions and their revisions, for one organisation. */
export class ExpeditionRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /**
   * The same repository against a different connection, such as a
   * transaction. Every write in this ticket is made through one.
   */
  withConnection(db: Queryable): ExpeditionRepository {
    return new ExpeditionRepository(this.#tenant.withConnection(db));
  }

  // --- Expeditions --------------------------------------------------------

  /** One page of expeditions, most recently changed first. */
  async listExpeditions(page: ExpeditionPage): Promise<ExpeditionRow[]> {
    return this.#tenant.find<ExpeditionRow>('expedition', {
      where: page.status === undefined ? {} : { status: page.status },
      orderBy: [
        { column: 'updated_at', direction: 'desc' },
        { column: 'id', direction: 'desc' },
      ],
      limit: page.limit,
      offset: page.offset,
    });
  }

  /** How many expeditions the same filter matches, for the page count. */
  async countExpeditions(status?: ExpeditionStatus): Promise<number> {
    return this.#tenant.count('expedition', status === undefined ? {} : { status });
  }

  /** One expedition, or null when the organisation has no such row. */
  async findExpedition(
    id: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionRow | null> {
    return this.#tenant.findOne<ExpeditionRow>('expedition', {
      where: { id },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /** Adds the expedition itself. The first revision is a separate write. */
  async insertExpedition(input: NewExpedition): Promise<ExpeditionRow> {
    return this.#tenant.insert<ExpeditionRow>('expedition', {
      status: 'draft',
      source: input.source,
      created_by: input.createdBy,
      updated_by: input.createdBy,
    });
  }

  /**
   * Records that somebody changed an expedition.
   *
   * `updated_at` is not passed: migration 0001 puts a trigger on every table
   * that has the column, so the database sets it and two instances with
   * disagreeing clocks cannot disagree about when a row changed.
   */
  async touchExpedition(
    id: string,
    patch: { readonly updatedBy: string; readonly status?: ExpeditionStatus },
  ): Promise<ExpeditionRow | null> {
    const values: Record<string, SqlValue> = { updated_by: patch.updatedBy };
    if (patch.status !== undefined) {
      values['status'] = patch.status;
    }
    return this.#tenant.updateById<ExpeditionRow>('expedition', id, values);
  }

  // --- Revisions ----------------------------------------------------------

  /** Every revision of one expedition, newest first, without the documents. */
  async listVersions(expeditionId: string): Promise<ExpeditionVersionSummaryRow[]> {
    return this.#tenant.find<ExpeditionVersionSummaryRow>('expedition_version', {
      where: { expedition_id: expeditionId },
      columns: VERSION_SUMMARY_COLUMNS,
      orderBy: [{ column: 'definition_version', direction: 'desc' }],
    });
  }

  /**
   * Every revision of several expeditions at once, without the documents.
   *
   * What a list of expeditions is drawn from: one statement for the page
   * rather than one per row. An empty list of ids reads nothing at all, which
   * `buildFilter` already turns into a statement that matches nothing.
   */
  async listVersionsFor(
    expeditionIds: readonly string[],
  ): Promise<ExpeditionVersionSummaryRow[]> {
    if (expeditionIds.length === 0) {
      return [];
    }
    return this.#tenant.find<ExpeditionVersionSummaryRow>('expedition_version', {
      where: { expedition_id: expeditionIds },
      columns: VERSION_SUMMARY_COLUMNS,
      orderBy: [{ column: 'definition_version', direction: 'desc' }],
    });
  }

  /** One revision by its number, document and all. */
  async findVersion(
    expeditionId: string,
    definitionVersion: number,
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findOne<ExpeditionVersionRow>('expedition_version', {
      where: { expedition_id: expeditionId, definition_version: definitionVersion },
    });
  }

  /**
   * The newest revision of an expedition, document and all.
   *
   * Newest means the highest `definition_version`, which is also the only
   * revision that can be a draft: publishing freezes a revision, and the next
   * edit writes a new one after it. `forUpdate` locks it, and is how a
   * publish and a save racing each other end up in an order rather than in
   * two drafts.
   */
  async findLatestVersion(
    expeditionId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findOne<ExpeditionVersionRow>('expedition_version', {
      where: { expedition_id: expeditionId },
      orderBy: [{ column: 'definition_version', direction: 'desc' }],
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /** The newest published revision, or null while nothing has been published. */
  async findPublishedVersion(
    expeditionId: string,
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findOne<ExpeditionVersionRow>('expedition_version', {
      where: { expedition_id: expeditionId, status: 'published' },
      orderBy: [{ column: 'definition_version', direction: 'desc' }],
    });
  }

  /** Adds a revision. */
  async insertVersion(input: NewExpeditionVersion): Promise<ExpeditionVersionRow> {
    return this.#tenant.insert<ExpeditionVersionRow>('expedition_version', {
      expedition_id: input.expeditionId,
      definition_version: input.definitionVersion,
      schema_version: input.schemaVersion,
      status: input.status,
      definition: input.definition,
      title: input.title,
      summary: input.summary,
      locale: input.locale,
      created_by: input.createdBy,
    });
  }

  /** Writes a new document over a draft. */
  async replaceDraftDocument(
    versionId: string,
    values: {
      readonly schemaVersion: string;
      readonly definition: JsonObject;
      readonly title: string;
      readonly summary: string;
      readonly locale: string;
    },
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.updateById<ExpeditionVersionRow>(
      'expedition_version',
      versionId,
      {
        schema_version: values.schemaVersion,
        definition: values.definition,
        title: values.title,
        summary: values.summary,
        locale: values.locale,
      },
    );
  }

  /**
   * Freezes a draft.
   *
   * The document goes in with it, because publishing changes two fields
   * inside it — `status` and `publishedAt` — and a stored document that
   * disagreed with its own row would be worse than either.
   */
  async publishVersion(
    versionId: string,
    values: {
      readonly definition: JsonObject;
      readonly publishedAt: Date;
      readonly publishedBy: string;
    },
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.updateById<ExpeditionVersionRow>(
      'expedition_version',
      versionId,
      {
        status: 'published',
        definition: values.definition,
        published_at: values.publishedAt,
        published_by: values.publishedBy,
      },
    );
  }
}

/** Builds the repository from the repository the middleware made. */
export function expeditionRepository(tenant: TenantRepository): ExpeditionRepository {
  return new ExpeditionRepository(tenant);
}
