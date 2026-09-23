/**
 * Asking for a signed upload URL, and for a signed download URL (EXPD-021).
 *
 * An upload is two steps and the API is only in the first. The caller says
 * what kind of file it has; the API writes a `pending` row naming where the
 * file will go and answers with a URL that can create that one blob and
 * nothing else. The phone then PUTs the bytes straight to Blob Storage. The
 * API never sees them, which is the point: a class of thirty uploading video
 * over a school's signal is Blob Storage's load, not the App Service plan's.
 *
 * A download is one step: a URL that reads one blob, for a short time.
 */

import { randomUUID } from 'node:crypto';
import type { Principal } from '@explorer/shared-types';

import { ApiError, notFound } from '../http/errors.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type { MediaAssetRow, MediaKind } from '../repositories/rows.ts';
import { StorageSigningError } from './delegation-key.ts';
import type { MediaStorage, SignedUrl } from './media-storage.ts';

/** What the caller says about the file it is about to upload. */
export interface UploadRequest {
  readonly kind: MediaKind;
  /** Sent back as the `content-type` the PUT has to carry. */
  readonly contentType: string;
}

/** What a client reads back about one file. */
export interface MediaView {
  readonly id: string;
  readonly kind: MediaKind;
  readonly status: MediaAssetRow['status'];
  readonly contentType: string | null;
}

/** The answer to `POST /media/uploads`. */
export interface UploadGrant {
  readonly media: MediaView;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    /**
     * The headers the PUT has to send. `x-ms-blob-type` is Blob Storage's
     * and it refuses the upload without it.
     */
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

/** The answer to `GET /media/:mediaId/download`. */
export interface DownloadGrant {
  readonly media: MediaView;
  readonly download: {
    readonly method: 'GET';
    readonly url: string;
    readonly expiresAt: string;
  };
}

/**
 * Where a file lives inside the container.
 *
 * The organisation first, so that everything one school uploaded is under
 * one prefix and can be found, exported or deleted together (EXPD-071).
 * Then the row's own id, which is random, so a path cannot be guessed and
 * two uploads cannot land on each other.
 */
export function blobPathFor(organisationId: string, mediaId: string): string {
  return `${organisationId}/${mediaId}`;
}

/** The two actions, for one organisation. */
export class MediaService {
  readonly #tenant: TenantRepository;
  readonly #storage: MediaStorage | undefined;

  constructor(options: {
    readonly tenant: TenantRepository;
    readonly storage: MediaStorage | undefined;
  }) {
    this.#tenant = options.tenant;
    this.#storage = options.storage;
  }

  /** Writes a `pending` row and answers with the URL to upload it to. */
  async requestUpload(principal: Principal, request: UploadRequest): Promise<UploadGrant> {
    const storage = this.#requireStorage();
    const id = randomUUID();
    const path = blobPathFor(this.#tenant.organisationId, id);

    // Signed before the row is written. A key Azure would not give is a 503
    // with nothing left behind; a row with no URL would be one nobody could
    // ever fill.
    const signed = await sign(() => storage.signUpload(path));

    const row = await this.#tenant.insert<MediaAssetRow>('media_asset', {
      id,
      kind: request.kind,
      status: 'pending',
      storage_container: storage.container,
      storage_path: path,
      content_type: request.contentType,
      // A person is recorded as a person and a phone as the student holding
      // it, never both, so the row says which kind of caller uploaded it.
      uploaded_by: principal.kind === 'user' ? principal.userId : null,
      uploaded_by_participant: principal.kind === 'device' ? principal.participantId : null,
    });

    return {
      media: mediaView(row),
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

  /** Answers with a URL that reads one file of this organisation's. */
  async requestDownload(mediaId: string): Promise<DownloadGrant> {
    const storage = this.#requireStorage();
    const row = await this.#tenant.findById<MediaAssetRow>('media_asset', mediaId);
    // Another organisation's file is not found, as everywhere else. So is
    // one that has been deleted: its blob is on its way out, and a URL to it
    // would be a promise the storage account is about to break.
    if (row === null || row.status === 'deleted') {
      throw notFound('media');
    }
    if (row.status === 'failed') {
      throw new ApiError('conflict', { message: 'That file did not upload, so there is nothing to read.' });
    }

    const signed = await sign(() => storage.signDownload(row.storage_path));
    return {
      media: mediaView(row),
      download: {
        method: 'GET',
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
      },
    };
  }

  #requireStorage(): MediaStorage {
    if (this.#storage === undefined) {
      throw new ApiError('service-unavailable', {
        message: 'Media storage is not set up on this server.',
        detail: 'createApp was given no media storage, and AZURE_STORAGE_ACCOUNT is not set.',
      });
    }
    return this.#storage;
  }
}

/** The row as a client reads it. The container and path stay on the server. */
export function mediaView(row: MediaAssetRow): MediaView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    contentType: row.content_type,
  };
}

/** Signs, and turns Azure refusing into the API's 503. */
async function sign(signer: () => Promise<SignedUrl>): Promise<SignedUrl> {
  try {
    return await signer();
  } catch (error) {
    if (error instanceof StorageSigningError) {
      throw new ApiError('service-unavailable', {
        message: 'Media storage is not answering. Try again in a moment.',
        detail: error.message,
        cause: error,
      });
    }
    throw error;
  }
}
