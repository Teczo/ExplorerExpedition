/**
 * The document, on its way in and out of the database (EXPD-017).
 *
 * An Expedition Definition (EXPD-002) arrives from a client, but not all of
 * it is the client's to decide. Six fields belong to the platform, and a
 * client that sent its own is not refused — it is simply overwritten, because
 * the alternative is an error message about a field nobody meant to send:
 *
 *   `id`                          the expedition row's id
 *   `definitionVersion`           the revision counter this ticket owns
 *   `status`                      draft until this API publishes it
 *   `publishedAt`                 set by publishing, and by nothing else
 *   `metadata.authoring`          who made it, who changed it, and when
 *   `metadata.authoring.source`   how it came to exist, fixed at creation
 *
 * `seal` is where that happens, and it is the only way a document is written
 * to a row. A document read back out of the database has already been through
 * it, so the six are true of the stored document rather than only of the
 * response.
 *
 * What is *not* here is any opinion about whether a document is any good.
 * `validateExpeditionDefinition` owns that, and `issuesInDocument` below only
 * translates what it says into the error contract the rest of the API speaks.
 */

import {
  EXPEDITION_SCHEMA_VERSION,
  isReadableSchemaVersion,
  validateExpeditionDefinition,
  type AuthoringSource,
  type ExpeditionStatus,
  type JsonObject,
  type JsonValue,
  type ValidationIssue,
} from '@explorer/shared-types';

import type { Checker, CheckResult } from '../http/validation.ts';
import type { FieldIssue } from '../http/errors.ts';

/**
 * The longest a title may be.
 *
 * The column has no limit of its own. This one is here so that a document
 * with a novel in its title is refused at the edge rather than stored and
 * drawn badly in every list from then on.
 */
export const MAX_TITLE_LENGTH = 200;

/** The longest a summary may be. Same reasoning as the title. */
export const MAX_SUMMARY_LENGTH = 2000;

/** What the platform decides about a document, whatever the client sent. */
export interface DocumentSeal {
  /** The expedition row's id, which every revision shares. */
  readonly expeditionId: string;
  readonly definitionVersion: number;
  readonly status: ExpeditionStatus;
  /** Set when the status is `published`, and never otherwise. */
  readonly publishedAt?: Date;
  readonly organisationId: string;
  /** Who created the expedition, kept from the revision before this one. */
  readonly createdBy: string;
  readonly createdAt: Date;
  /** Who saved this revision. */
  readonly updatedBy: string;
  readonly updatedAt: Date;
  readonly source: AuthoringSource;
}

/**
 * Writes the platform's own fields into a document.
 *
 * Returns a copy. The document handed in is never changed, because it is
 * usually the request body and a handler that read it afterwards should see
 * what the client sent.
 */
export function seal(document: JsonObject, values: DocumentSeal): JsonObject {
  const metadata = asObject(document['metadata']);
  const sealed: JsonObject = {
    ...document,
    schemaVersion: schemaVersionOf(document),
    id: values.expeditionId,
    definitionVersion: values.definitionVersion,
    status: values.status,
    metadata: {
      ...metadata,
      authoring: {
        ...asObject(metadata['authoring']),
        organisationId: values.organisationId,
        createdBy: values.createdBy,
        createdAt: values.createdAt.toISOString(),
        updatedBy: values.updatedBy,
        updatedAt: values.updatedAt.toISOString(),
        source: values.source,
      },
    },
  };

  // A draft that carried a published time would fail validation, and would be
  // saying something untrue besides. Deleting rather than nulling: the field
  // is optional in the schema, and `null` is not one of the things it may be.
  if (values.publishedAt === undefined) {
    delete sealed['publishedAt'];
  } else {
    sealed['publishedAt'] = values.publishedAt.toISOString();
  }

  return sealed;
}

/**
 * The schema version a document is stored under.
 *
 * A document that names none is stored as this build's own, which is what a
 * client that only filled in the parts it cares about meant. One that names a
 * version this build cannot read never reaches here: `expeditionDocument`
 * refuses it, because storing a document we cannot read back would be storing
 * something nobody can ever open.
 */
export function schemaVersionOf(document: JsonObject): string {
  const declared = document['schemaVersion'];
  return typeof declared === 'string' && isReadableSchemaVersion(declared)
    ? declared
    : EXPEDITION_SCHEMA_VERSION;
}

/** The columns copied out of `metadata` so a list can be drawn cheaply. */
export interface DocumentSummary {
  readonly title: string;
  readonly summary: string;
  readonly locale: string;
}

/**
 * Reads the three copied columns off a document.
 *
 * The title is known to be there: `expeditionDocument` refuses a document
 * without one, because the column is `NOT NULL` and an expedition nobody can
 * name is not a draft of anything. The other two have defaults.
 */
export function summaryOf(document: JsonObject): DocumentSummary {
  const metadata = asObject(document['metadata']);
  const title = typeof metadata['title'] === 'string' ? metadata['title'].trim() : '';
  const summary =
    typeof metadata['summary'] === 'string' ? metadata['summary'].trim() : '';
  const locale =
    typeof metadata['locale'] === 'string' && metadata['locale'].trim() !== ''
      ? metadata['locale'].trim()
      : DEFAULT_LOCALE;

  return { title, summary, locale };
}

/** The locale a document that names none is stored under. Matches 0001. */
export const DEFAULT_LOCALE = 'en-GB';

/**
 * Everything wrong with a document, in the API's error vocabulary.
 *
 * Empty means the document is a valid Expedition Definition. A draft is
 * allowed to have problems — that is what a draft is — so a save reports them
 * and stores the document anyway. Publishing refuses while there is one.
 *
 * `at` is where the document sat in the request, so that a path reads
 * `definition.graph.edges[3].to` rather than `graph.edges[3].to` and points
 * at a field the client can actually find.
 */
export function issuesInDocument(document: JsonObject, at: string): FieldIssue[] {
  const result = validateExpeditionDefinition(document);
  return result.valid ? [] : result.issues.map((issue) => toFieldIssue(issue, at));
}

/** One validator issue, as a field issue. */
function toFieldIssue(issue: ValidationIssue, at: string): FieldIssue {
  return {
    path: issue.path === '' ? at : `${at}.${issue.path}`,
    message: issue.message,
  };
}

/**
 * The checker a route puts in front of itself for a document.
 *
 * It checks the little that has to be true of *any* revision, draft or not:
 *
 *   - it is an object, with an object for `metadata`
 *   - `metadata.title` says something, and is not longer than a title
 *   - `metadata.summary`, when there is one, is not longer than a summary
 *   - `schemaVersion`, when there is one, is a version this build can read
 *
 * Everything else a document ought to be — a graph that connects up, missions
 * that are placed somewhere, scoring that adds up — is checked by
 * `validateExpeditionDefinition` and only enforced at publish. A draft is
 * allowed to be halfway through.
 */
export function expeditionDocument(): Checker<JsonObject> {
  return {
    check(value, path): CheckResult<JsonObject> {
      if (!isPlainObject(value)) {
        return fail(path, 'This has to be an expedition document.');
      }

      const issues: FieldIssue[] = [];
      const declared = value['schemaVersion'];
      if (declared !== undefined && declared !== null) {
        if (typeof declared !== 'string' || !isReadableSchemaVersion(declared)) {
          issues.push({
            path: `${path}.schemaVersion`,
            message:
              `This build reads schema version ${EXPEDITION_SCHEMA_VERSION} ` +
              'and earlier of the same major version.',
          });
        }
      }

      const metadata = value['metadata'];
      if (!isPlainObject(metadata)) {
        issues.push({
          path: `${path}.metadata`,
          message: 'This is required, and has to be an object.',
        });
        return { ok: false, issues };
      }

      issues.push(...titleIssues(metadata['title'], `${path}.metadata.title`));

      const summary = metadata['summary'];
      if (
        typeof summary === 'string' &&
        summary.trim().length > MAX_SUMMARY_LENGTH
      ) {
        issues.push({
          path: `${path}.metadata.summary`,
          message: `This has to be ${MAX_SUMMARY_LENGTH} characters or fewer.`,
        });
      }

      return issues.length === 0
        ? { ok: true, value: value as JsonObject }
        : { ok: false, issues };
    },
  };
}

function titleIssues(value: unknown, path: string): FieldIssue[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return [{ path, message: 'An expedition needs a name.' }];
  }
  if (value.trim().length > MAX_TITLE_LENGTH) {
    return [
      { path, message: `This has to be ${MAX_TITLE_LENGTH} characters or fewer.` },
    ];
  }
  return [];
}

function fail(path: string, message: string): CheckResult<never> {
  return { ok: false, issues: [{ path, message }] };
}

/** True when the value is a JSON object rather than an array or a null. */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as an object, or an empty one. For reading a half-built draft. */
function asObject(value: JsonValue | undefined): JsonObject {
  return isPlainObject(value) ? value : {};
}
