/**
 * The media library (EXPD-030).
 *
 * The files an author uploads once and places on missions, mission types and
 * templates: images, audio, video, PDFs and 3D models. They are rows of
 * `media_asset` with `in_library` set (0008), so the signed URLs of EXPD-021
 * put them in Blob Storage and read them back, unchanged.
 *
 * Five things, and nothing else:
 *
 *   1. **Listing.** One organisation's library, newest first, optionally one
 *      kind. A removed file is not listed. Evidence a team handed in never
 *      is: it is not `in_library`.
 *   2. **Adding a file is two calls.** The first writes a `pending` row with
 *      its name and answers with the URL to upload to, the same as EXPD-021.
 *      The second, once the browser has uploaded, asks Blob Storage whether
 *      the file is really there. Only then is the row `ready`, with its real
 *      size. A `pending` file is not offered for placing on a mission.
 *   3. **Renaming**, and changing the words a screen reader says instead.
 *   4. **Removing.** The row is marked `deleted`, so any download of it is a
 *      404 from then on (EXPD-021). The blob itself is left where it is.
 *   5. **Every change is audited** in the same transaction: `media.added`,
 *      `media.updated`, `media.deleted`. Asking for an upload URL is not a
 *      change, for the reason EXPD-021 gives.
 */

import { randomUUID } from 'node:crypto';
import type { UserPrincipal } from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound } from '../http/errors.ts';
import type { LibraryMediaRow, MediaKind, MediaStatus } from '../repositories/rows.ts';
import { askStorage, blobPathFor, requireStorage, sign } from './media-service.ts';
import type { MediaStorage } from './media-storage.ts';

/** The most files a list returns. A guard, not a page. */
export const MAX_LIBRARY_LIST = 500;

/** The statuses a library list shows. A removed file is gone from it. */
const LISTED: readonly MediaStatus[] = ['pending', 'ready', 'failed'];

/** One library file, as a client reads it. The container and path stay here. */
export interface LibraryItemView {
  readonly id: string;
  readonly kind: MediaKind;
  readonly status: MediaStatus;
  readonly name: string;
  readonly altText: string | null;
  readonly contentType: string | null;
  /** Known once the file is `ready`. */
  readonly byteSize: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What an author says about a file they are about to upload. */
export interface LibraryUploadRequest {
  readonly kind: MediaKind;
  readonly contentType: string;
  readonly name: string;
  readonly altText?: string | undefined;
}

/** The answer to `POST /media/library`. */
export interface LibraryUploadGrant {
  readonly media: LibraryItemView;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

/** What a rename may change. An empty alt text clears it. */
export interface LibraryChange {
  readonly name?: string | undefined;
  readonly altText?: string | undefined;
}

export class MediaLibraryService {
  readonly #db: Queryable;
  readonly #tenant: TenantRepository;
  readonly #audit: AuditLog;
  readonly #storage: MediaStorage | undefined;

  constructor(options: {
    readonly db: Queryable;
    readonly tenant: TenantRepository;
    readonly audit: AuditLog;
    readonly storage: MediaStorage | undefined;
  }) {
    this.#db = options.db;
    this.#tenant = options.tenant;
    this.#audit = options.audit;
    this.#storage = options.storage;
  }

  /** This organisation's library, newest first. */
  async list(kind?: MediaKind): Promise<{ media: LibraryItemView[] }> {
    const rows = await this.#tenant.find<LibraryMediaRow>('media_asset', {
      where: {
        in_library: true,
        status: LISTED,
        ...(kind === undefined ? {} : { kind }),
      },
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      limit: MAX_LIBRARY_LIST,
    });
    return { media: rows.map(libraryView) };
  }

  /** One library file. */
  async get(id: string): Promise<LibraryItemView> {
    return libraryView(await this.#find(this.#tenant, id));
  }

  /** Writes a `pending` library row and answers with the URL to upload it to. */
  async requestUpload(
    principal: UserPrincipal,
    request: LibraryUploadRequest,
  ): Promise<LibraryUploadGrant> {
    const storage = requireStorage(this.#storage);
    const id = randomUUID();
    const path = blobPathFor(this.#tenant.organisationId, id);
    // Signed before the row is written, for EXPD-021's reason: a refusal
    // from Azure leaves nothing behind.
    const signed = await sign(() => storage.signUpload(path));

    const row = await this.#tenant.insert<LibraryMediaRow>('media_asset', {
      id,
      kind: request.kind,
      status: 'pending',
      storage_container: storage.container,
      storage_path: path,
      content_type: request.contentType,
      in_library: true,
      name: request.name,
      alt_text: emptyToNull(request.altText),
      uploaded_by: principal.userId,
    });

    return {
      media: libraryView(row),
      upload: {
        method: 'PUT',
        url: signed.url,
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'content-type': request.contentType,
        },
        expiresAt: signed.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Marks a file `ready` once Blob Storage has it, with its real size.
   *
   * Asked twice, it answers the same the second time and audits nothing.
   * Asked before the upload finished, it is a 409 and the row stays pending,
   * so the browser can ask again.
   */
  async complete(id: string): Promise<LibraryItemView> {
    const storage = requireStorage(this.#storage);
    const pending = await this.#find(this.#tenant, id);
    if (pending.status === 'ready') {
      return libraryView(pending);
    }
    if (pending.status === 'failed') {
      throw new ApiError('conflict', { message: 'That file did not upload. Remove it and upload it again.' });
    }

    // Asked outside the transaction: a slow answer from Azure should not hold
    // a row lock open.
    const facts = await askStorage(() => storage.inspect(pending.storage_path));
    if (facts === null) {
      throw new ApiError('conflict', {
        message: 'The file has not arrived in storage yet. Finish the upload, then try again.',
      });
    }

    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const before = await this.#find(tenant, id, true);
      if (before.status === 'ready') {
        return libraryView(before);
      }
      const row = await tenant.updateById<LibraryMediaRow>('media_asset', id, {
        status: 'ready',
        byte_size: facts.byteSize,
      });
      if (row === null) {
        throw notFound('media');
      }
      await this.#audit.withConnection(tx).record('media.added', {
        entityId: row.id,
        after: summaryOf(row),
      });
      return libraryView(row);
    });
  }

  /** Renames a file, or changes its alt text. */
  async update(id: string, change: LibraryChange): Promise<LibraryItemView> {
    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const before = await this.#find(tenant, id, true);
      const patch: Record<string, string | null> = {};
      if (change.name !== undefined) {
        patch['name'] = change.name;
      }
      if (change.altText !== undefined) {
        patch['alt_text'] = emptyToNull(change.altText);
      }
      if (Object.keys(patch).length === 0) {
        return libraryView(before);
      }

      const row = await tenant.updateById<LibraryMediaRow>('media_asset', id, patch);
      if (row === null) {
        throw notFound('media');
      }
      await this.#audit.withConnection(tx).record('media.updated', {
        entityId: row.id,
        before: summaryOf(before),
        after: summaryOf(row),
      });
      return libraryView(row);
    });
  }

  /** Takes a file out of the library. Its downloads stop working. */
  async remove(id: string): Promise<void> {
    await inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const before = await this.#find(tenant, id, true);
      const row = await tenant.updateById<LibraryMediaRow>('media_asset', id, { status: 'deleted' });
      if (row === null) {
        throw notFound('media');
      }
      await this.#audit.withConnection(tx).record('media.deleted', {
        entityId: row.id,
        before: summaryOf(before),
        after: summaryOf(row),
      });
    });
  }

  /**
   * One library row of this organisation's, not removed. Anything else is
   * not found: another organisation's file, a removed one, and evidence,
   * which the library does not reach.
   */
  async #find(tenant: TenantRepository, id: string, forUpdate = false): Promise<LibraryMediaRow> {
    const row = await tenant.findById<LibraryMediaRow>('media_asset', id, { forUpdate });
    if (row === null || row.in_library !== true || row.status === 'deleted') {
      throw notFound('media');
    }
    return row;
  }
}

/** The row as a client reads it. */
export function libraryView(row: LibraryMediaRow): LibraryItemView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name,
    altText: row.alt_text ?? null,
    contentType: row.content_type,
    byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** What an audit entry keeps of a row: what a person would recognise it by. */
function summaryOf(row: LibraryMediaRow): Record<string, unknown> {
  return {
    name: row.name,
    kind: row.kind,
    status: row.status,
    alt_text: row.alt_text ?? null,
    content_type: row.content_type,
    byte_size: row.byte_size ?? null,
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * A time as ISO 8601. A missing one is now: the column defaults to `now()`,
 * the rule the mission type views follow (EXPD-025).
 */
function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return new Date().toISOString();
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
