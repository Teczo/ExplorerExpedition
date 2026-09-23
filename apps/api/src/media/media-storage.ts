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
  type DelegationKeySource,
  type Fetch,
} from './delegation-key.ts';

/** A URL, and when it stops working. */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** What the media routes need from storage. */
export interface MediaStorage {
  /** The container every blob is in. Written on the row beside the path. */
  readonly container: string;
  /** A URL that creates the blob at `blobName`, once. */
  signUpload(blobName: string): Promise<SignedUrl>;
  /** A URL that reads the blob at `blobName`. */
  signDownload(blobName: string): Promise<SignedUrl>;
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

  constructor(options: {
    readonly accountName: string;
    readonly blobEndpoint: string;
    readonly container: string;
    readonly keys: DelegationKeySource;
    readonly uploadUrlSeconds: number;
    readonly downloadUrlSeconds: number;
    readonly now?: () => Date;
  }) {
    this.container = options.container;
    this.#accountName = options.accountName;
    this.#blobEndpoint = options.blobEndpoint;
    this.#keys = options.keys;
    this.#uploadSeconds = options.uploadUrlSeconds;
    this.#downloadSeconds = options.downloadUrlSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  signUpload(blobName: string): Promise<SignedUrl> {
    return this.#sign(blobName, 'c', this.#uploadSeconds);
  }

  signDownload(blobName: string): Promise<SignedUrl> {
    return this.#sign(blobName, 'r', this.#downloadSeconds);
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
