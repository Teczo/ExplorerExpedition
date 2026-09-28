/**
 * Signed URLs for the `media` container (EXPD-021).
 *
 * The one thing the media routes ask of storage: a URL to put a new file
 * at, and a URL to read one back from. Both are signed here and nowhere
 * else, so every URL the API hands out works for the same short time, on
 * one blob, over HTTPS, and for one thing.
 */

import type { StorageConfig } from '../config/storage-config.ts';
import { signedBlobUrl, type BlobPermission } from './blob-sas.ts';
import {
  BlobDelegationKeySource,
  CLOCK_SKEW_SECONDS,
  ManagedIdentityTokenSource,
  StorageSigningError,
  type DelegationKeySource,
  type Fetch,
} from './delegation-key.ts';

/** How long asking Blob Storage about one blob may take. */
const INSPECT_TIMEOUT_MS = 5_000;

/** A URL, and when it stops working. */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** What Blob Storage says about a blob that is there (EXPD-030). */
export interface BlobFacts {
  /** From `content-length`. Null when storage did not say. */
  readonly byteSize: number | null;
  readonly contentType: string | null;
}

/** What the media routes need from storage. */
export interface MediaStorage {
  /** The container every blob is in. Written on the row beside the path. */
  readonly container: string;
  /** A URL that creates the blob at `blobName`, once. */
  signUpload(blobName: string): Promise<SignedUrl>;
  /** A URL that reads the blob at `blobName`. */
  signDownload(blobName: string): Promise<SignedUrl>;
  /**
   * Whether the blob at `blobName` has arrived, and how big it is. Null when
   * it is not there. The media library asks before it calls a file ready
   * (EXPD-030).
   */
  inspect(blobName: string): Promise<BlobFacts | null>;
}

/** Media storage in an Azure storage account, signed with delegation keys. */
export class BlobMediaStorage implements MediaStorage {
  readonly container: string;
  readonly #accountName: string;
  readonly #blobEndpoint: string;
  readonly #keys: DelegationKeySource;
  readonly #uploadSeconds: number;
  readonly #downloadSeconds: number;
  readonly #now: () => Date;
  readonly #fetch: Fetch;

  constructor(options: {
    readonly accountName: string;
    readonly blobEndpoint: string;
    readonly container: string;
    readonly keys: DelegationKeySource;
    readonly uploadUrlSeconds: number;
    readonly downloadUrlSeconds: number;
    readonly now?: () => Date;
    /** For `inspect`. The global `fetch` when absent. */
    readonly fetch?: Fetch;
  }) {
    this.container = options.container;
    this.#accountName = options.accountName;
    this.#blobEndpoint = options.blobEndpoint;
    this.#keys = options.keys;
    this.#uploadSeconds = options.uploadUrlSeconds;
    this.#downloadSeconds = options.downloadUrlSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  signUpload(blobName: string): Promise<SignedUrl> {
    return this.#sign(blobName, 'c', this.#uploadSeconds);
  }

  signDownload(blobName: string): Promise<SignedUrl> {
    return this.#sign(blobName, 'r', this.#downloadSeconds);
  }

  /**
   * A `HEAD` on a read URL signed for the purpose. The same kind of URL a
   * teacher is given, so it needs no permission the API does not already use.
   */
  async inspect(blobName: string): Promise<BlobFacts | null> {
    const signed = await this.signDownload(blobName);
    let response: Response;
    try {
      response = await this.#fetch(signed.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new StorageSigningError(
        `Blob Storage could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new StorageSigningError(`Blob Storage answered ${response.status} when asked about a blob.`);
    }
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    return {
      byteSize: Number.isSafeInteger(length) && length >= 0 ? length : null,
      contentType: response.headers.get('content-type'),
    };
  }

  async #sign(blobName: string, permission: BlobPermission, seconds: number): Promise<SignedUrl> {
    const now = this.#now();
    const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + seconds * 1000);
    const key = await this.#keys.keyValidUntil(expiresAt);
    // Started a little in the past, for the reason the key is: the storage
    // service's clock may be ahead of this one.
    const startsAt = new Date(now.getTime() - CLOCK_SKEW_SECONDS * 1000);

    return {
      url: signedBlobUrl(this.#blobEndpoint, {
        accountName: this.#accountName,
        containerName: this.container,
        blobName,
        permission,
        startsAt,
        expiresAt,
        key,
      }),
      expiresAt,
    };
  }
}

/** Builds media storage from its settings, with the managed identity behind it. */
export function mediaStorageFrom(
  config: StorageConfig,
  options: { readonly fetch?: Fetch } = {},
): MediaStorage {
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };
  const tokens = new ManagedIdentityTokenSource({
    endpoint: config.identityEndpoint,
    header: config.identityHeader,
    ...fetchOption,
  });
  return new BlobMediaStorage({
    accountName: config.accountName,
    blobEndpoint: config.blobEndpoint,
    container: config.mediaContainer,
    keys: new BlobDelegationKeySource({
      blobEndpoint: config.blobEndpoint,
      tokens,
      ...fetchOption,
    }),
    uploadUrlSeconds: config.uploadUrlSeconds,
    downloadUrlSeconds: config.downloadUrlSeconds,
  });
}
