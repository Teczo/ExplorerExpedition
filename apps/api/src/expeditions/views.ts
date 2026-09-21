/**
 * What the expedition endpoints answer with (EXPD-017).
 *
 * A row is what PostgreSQL returned, snake case and all. A view is what a
 * client reads. This file is the one place the first becomes the second, so
 * that a column renamed by a migration is a change in one file rather than in
 * every handler.
 *
 * Two rules the shapes follow. A time is an ISO 8601 string, never a `Date`,
 * because JSON has no date and a client should not have to know how this API
 * happens to serialise one. And an expedition carries its revisions rather
 * than a `versionId` a client would have to go and fetch: the draft and the
 * published revision are what every screen showing an expedition needs, and
 * they cost nothing to include because the list already read them.
 */

import type { AuthoringSource, ExpeditionStatus, JsonObject } from '@explorer/shared-types';

import type { FieldIssue } from '../http/errors.ts';
import type { ExpeditionRow, ExpeditionVersionRow } from '../repositories/rows.ts';
import type { ExpeditionVersionSummaryRow } from './expedition-repository.ts';

/** One revision, without its document. */
export interface ExpeditionVersionView {
  readonly id: string;
  /** The revision number. Counts from one, and goes up on each publish. */
  readonly definitionVersion: number;
  readonly status: ExpeditionStatus;
  /** The EXPD-002 schema version the document is written against. */
  readonly schemaVersion: string;
  readonly title: string;
  readonly summary: string;
  readonly locale: string;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One expedition, with the revisions a screen showing it needs. */
export interface ExpeditionView {
  readonly id: string;
  readonly status: ExpeditionStatus;
  readonly source: AuthoringSource;
  /** Copied from the newest revision, so a list can be drawn from this alone. */
  readonly title: string;
  readonly summary: string;
  readonly locale: string;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** The revision being worked on, or null when the newest one is frozen. */
  readonly draft: ExpeditionVersionView | null;
  /** The newest frozen revision, or null while nothing has been published. */
  readonly published: ExpeditionVersionView | null;
  readonly versionCount: number;
}

/** One revision with its document, and everything wrong with it. */
export interface ExpeditionDocumentView {
  readonly version: ExpeditionVersionView;
  readonly definition: JsonObject;
  /**
   * What `validateExpeditionDefinition` says about the document.
   *
   * Always empty for a published revision, because publishing refuses while
   * there is anything here. A draft may carry as many as it likes: this is
   * the list the Studio draws under the author's nose while they work, and
   * the list publishing will hold them to.
   */
  readonly issues: readonly FieldIssue[];
}

/** One page of expeditions. */
export interface ExpeditionListView {
  readonly expeditions: readonly ExpeditionView[];
  /** How many the filter matches in all, not how many are on this page. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Turns a revision row into the shape a client reads. */
export function toVersionView(
  row: ExpeditionVersionSummaryRow | ExpeditionVersionRow,
): ExpeditionVersionView {
  return {
    id: row.id,
    definitionVersion: Number(row.definition_version),
    status: row.status,
    schemaVersion: row.schema_version,
    title: row.title,
    summary: row.summary,
    locale: row.locale,
    publishedAt: timeOf(row.published_at),
    publishedBy: row.published_by,
    createdBy: row.created_by,
    createdAt: timeOf(row.created_at) ?? '',
    updatedAt: timeOf(row.updated_at) ?? '',
  };
}

/**
 * Turns an expedition and its revisions into the shape a client reads.
 *
 * `versions` is every revision of this expedition, in any order. The draft is
 * the newest revision when that revision is a draft, and there is never more
 * than one: publishing freezes a revision, and the next save writes a new one
 * after it.
 */
export function toExpeditionView(
  row: ExpeditionRow,
  versions: readonly (ExpeditionVersionSummaryRow | ExpeditionVersionRow)[],
): ExpeditionView {
  const newestFirst = [...versions].sort(
    (left, right) => Number(right.definition_version) - Number(left.definition_version),
  );
  const newest = newestFirst[0];
  const draft = newest?.status === 'draft' ? newest : undefined;
  const published = newestFirst.find((version) => version.status === 'published');

  return {
    id: row.id,
    status: row.status,
    source: row.source,
    title: newest?.title ?? '',
    summary: newest?.summary ?? '',
    locale: newest?.locale ?? '',
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: timeOf(row.created_at) ?? '',
    updatedAt: timeOf(row.updated_at) ?? '',
    archivedAt: timeOf(row.archived_at),
    draft: draft === undefined ? null : toVersionView(draft),
    published: published === undefined ? null : toVersionView(published),
    versionCount: versions.length,
  };
}

/**
 * A time as a client reads it.
 *
 * `pg` gives back a `Date` for a `timestamptz`, and `FakeDatabase` gives back
 * whatever a test seeded, which may already be a string. Both are answered
 * the same way rather than one of them throwing.
 */
function timeOf(value: Date | string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}
