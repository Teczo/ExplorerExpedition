/**
 * Getting a user delegation key from Blob Storage (EXPD-021).
 *
 * Two calls, both over plain `fetch`, because the Azure SDK is a dependency
 * and no ticket has added it:
 *
 *   1. The web app's managed identity (EXPD-007) is asked for an access
 *      token for Azure Storage. On App Service that is a local endpoint the
 *      platform puts in `IDENTITY_ENDPOINT`, guarded by `IDENTITY_HEADER`.
 *   2. Blob Storage is asked, with that token, for a user delegation key.
 *      The identity holds Storage Blob Data Contributor, which is what lets
 *      it ask.
 *
 * The key is kept and reused until it is close to running out, so a class of
 * thirty uploading at once costs one round trip to Azure and not thirty.
 * Nothing here is written down anywhere: a key lives in this process's
 * memory, and a restart asks for a new one.
 */

import { isoSeconds, SAS_VERSION, type UserDelegationKey } from './blob-sas.ts';

/** `fetch`, or something shaped like it. A test passes its own. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Anything that can hand over a delegation key good until at least `until`. */
export interface DelegationKeySource {
  keyValidUntil(until: Date): Promise<UserDelegationKey>;
}

/** Thrown when a key or a token could not be had. The API answers 503. */
export class StorageSigningError extends Error {
  override readonly name = 'StorageSigningError';
}

/** The resource an access token for Blob Storage is asked for. */
export const STORAGE_RESOURCE = 'https://storage.azure.com/';

/** How long a request to Azure may take before it is given up on. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * How long a key is asked for.
 *
 * Azure allows up to seven days. A day is plenty to cover every URL signed
 * with it, and short enough that a key nobody uses again is soon worthless.
 */
export const KEY_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * How far back a key's start is set, and how early a token is renewed.
 *
 * A key that starts "now" by this server's clock can start in the future by
 * the storage service's, and be refused for a few seconds.
 */
export const CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * An access token from the App Service managed identity.
 *
 * https://learn.microsoft.com/azure/app-service/overview-managed-identity#rest-endpoint-reference
 */
export class ManagedIdentityTokenSource {
  readonly #endpoint: string;
  readonly #header: string;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  #cached: { readonly token: string; readonly expiresAt: Date } | undefined;

  constructor(options: {
    readonly endpoint: string;
    readonly header: string;
    readonly fetch?: Fetch;
    readonly now?: () => Date;
  }) {
    this.#endpoint = options.endpoint;
    this.#header = options.header;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async token(): Promise<string> {
    const now = this.#now();
    if (
      this.#cached !== undefined &&
      this.#cached.expiresAt.getTime() - CLOCK_SKEW_SECONDS * 1000 > now.getTime()
    ) {
      return this.#cached.token;
    }

    const url = new URL(this.#endpoint);
    url.searchParams.set('resource', STORAGE_RESOURCE);
    url.searchParams.set('api-version', '2019-08-01');

    const response = await call(this.#fetch, url.toString(), {
      method: 'GET',
      headers: { 'X-IDENTITY-HEADER': this.#header },
    }, 'the managed identity endpoint');

    const body = (await response.json()) as Record<string, unknown>;
    const token = body['access_token'];
    const expiresOn = Number(body['expires_on']);
    if (typeof token !== 'string' || token === '' || !Number.isFinite(expiresOn)) {
      throw new StorageSigningError(
        'The managed identity endpoint answered without an access token.',
      );
    }

    this.#cached = { token, expiresAt: new Date(expiresOn * 1000) };
    return token;
  }
}

/**
 * User delegation keys from Blob Storage, kept until they run short.
 *
 * https://learn.microsoft.com/rest/api/storageservices/get-user-delegation-key
 */
export class BlobDelegationKeySource implements DelegationKeySource {
  readonly #blobEndpoint: string;
  readonly #tokens: { token(): Promise<string> };
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  #cached: UserDelegationKey | undefined;
  /** A request already on its way, so a burst of uploads shares it. */
  #pending: Promise<UserDelegationKey> | undefined;

  constructor(options: {
    readonly blobEndpoint: string;
    readonly tokens: { token(): Promise<string> };
    readonly fetch?: Fetch;
    readonly now?: () => Date;
  }) {
    this.#blobEndpoint = options.blobEndpoint;
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async keyValidUntil(until: Date): Promise<UserDelegationKey> {
    const cached = this.#cached;
    if (cached !== undefined && Date.parse(cached.signedExpiry) >= until.getTime()) {
      return cached;
    }

    this.#pending ??= this.#fetchKey().finally(() => {
      this.#pending = undefined;
    });
    const key = await this.#pending;
    this.#cached = key;

    if (Date.parse(key.signedExpiry) < until.getTime()) {
      throw new StorageSigningError(
        `Blob Storage issued a key that ends at ${key.signedExpiry}, ` +
          `before ${isoSeconds(until)}, when a URL signed with it has to end.`,
      );
    }
    return key;
  }

  async #fetchKey(): Promise<UserDelegationKey> {
    const now = this.#now();
    const start = new Date(now.getTime() - CLOCK_SKEW_SECONDS * 1000);
    const expiry = new Date(now.getTime() + KEY_LIFETIME_SECONDS * 1000);

    const url = new URL(this.#blobEndpoint);
    url.searchParams.set('restype', 'service');
    url.searchParams.set('comp', 'userdelegationkey');

    const response = await call(this.#fetch, url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.#tokens.token()}`,
        'x-ms-version': SAS_VERSION,
        'content-type': 'application/xml',
      },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        `<KeyInfo><Start>${isoSeconds(start)}</Start>` +
        `<Expiry>${isoSeconds(expiry)}</Expiry></KeyInfo>`,
    }, 'Blob Storage');

    return parseDelegationKey(await response.text());
  }
}

/**
 * Reads the key out of Blob Storage's answer.
 *
 * The answer is a flat XML document of seven elements, none of which can
 * hold markup, so each is read by name rather than with an XML parser — which
 * would be a dependency.
 */
export function parseDelegationKey(xml: string): UserDelegationKey {
  const read = (element: string): string => {
    const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
    const value = match?.[1]?.trim();
    if (value === undefined || value === '') {
      throw new StorageSigningError(
        `Blob Storage answered with a delegation key that has no ${element}.`,
      );
    }
    return value;
  };

  return {
    signedObjectId: read('SignedOid'),
    signedTenantId: read('SignedTid'),
    signedStart: read('SignedStart'),
    signedExpiry: read('SignedExpiry'),
    signedService: read('SignedService'),
    signedVersion: read('SignedVersion'),
    value: read('Value'),
  };
}

async function call(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  who: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new StorageSigningError(`Could not reach ${who}.`, { cause: error });
  }
  if (!response.ok) {
    // The body can say why, and is worth having in the log. It holds no
    // secret: a refusal does not echo the token it refused.
    const text = await response.text().catch(() => '');
    throw new StorageSigningError(
      `${who} answered ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return response;
}
