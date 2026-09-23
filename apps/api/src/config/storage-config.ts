/**
 * The settings signed media URLs need, and where they come from (EXPD-021).
 *
 * EXPD-007 puts the first three on the web app. The managed identity's two
 * are put there by App Service itself whenever the app has an identity,
 * which it does.
 *
 *   AZURE_STORAGE_ACCOUNT          the account's name. Required to sign.
 *   AZURE_STORAGE_BLOB_ENDPOINT    its blob endpoint. Defaults from the name.
 *   AZURE_STORAGE_MEDIA_CONTAINER  the container. Defaults to `media`.
 *   IDENTITY_ENDPOINT              App Service's token endpoint.
 *   IDENTITY_HEADER                the secret that endpoint wants back.
 *
 * And two that are optional, in seconds:
 *
 *   MEDIA_UPLOAD_URL_SECONDS       how long an upload URL works. 900.
 *   MEDIA_DOWNLOAD_URL_SECONDS     how long a download URL works. 900.
 *
 * Unlike auth, storage is allowed to be missing altogether. A developer
 * without an Azure subscription still runs the API; the two media endpoints
 * answer 503 and everything else works. What is not allowed is half of it —
 * an account with no identity to sign for it — because that is a mistake,
 * and one that would otherwise surface as the first student's photo failing.
 */

/** Everything signing needs. */
export interface StorageConfig {
  readonly accountName: string;
  readonly blobEndpoint: string;
  readonly mediaContainer: string;
  readonly identityEndpoint: string;
  readonly identityHeader: string;
  readonly uploadUrlSeconds: number;
  readonly downloadUrlSeconds: number;
}

/** The defaults, in seconds. */
export const DEFAULT_URL_SECONDS = {
  upload: 15 * 60,
  download: 15 * 60,
} as const;

/**
 * The longest a signed URL may be set to work.
 *
 * A URL cannot be withdrawn once it is handed out, so it is kept short. An
 * hour is long enough for a video over a school's patchy signal, and it is
 * well inside the day a delegation key lasts (`delegation-key.ts`).
 */
export const MAX_URL_SECONDS = 60 * 60;

/** Thrown when storage is configured, but not completely. */
export class StorageConfigError extends Error {
  override readonly name = 'StorageConfigError';
}

/**
 * Reads the storage settings, or returns undefined when there are none.
 */
export function readStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StorageConfig | undefined {
  const accountName = setting(environment, 'AZURE_STORAGE_ACCOUNT');
  if (accountName === undefined) {
    return undefined;
  }

  const identityEndpoint = setting(environment, 'IDENTITY_ENDPOINT');
  const identityHeader = setting(environment, 'IDENTITY_HEADER');
  if (identityEndpoint === undefined || identityHeader === undefined) {
    throw new StorageConfigError(
      'AZURE_STORAGE_ACCOUNT is set, but IDENTITY_ENDPOINT and IDENTITY_HEADER ' +
        'are not. Media URLs are signed with a key issued to the app\'s managed ' +
        'identity, and the account keys are switched off (EXPD-007), so there is ' +
        'nothing else to sign with. Unset AZURE_STORAGE_ACCOUNT to run without media.',
    );
  }

  return {
    accountName,
    blobEndpoint:
      setting(environment, 'AZURE_STORAGE_BLOB_ENDPOINT') ??
      `https://${accountName}.blob.core.windows.net/`,
    mediaContainer: setting(environment, 'AZURE_STORAGE_MEDIA_CONTAINER') ?? 'media',
    identityEndpoint,
    identityHeader,
    uploadUrlSeconds: readSeconds(
      environment,
      'MEDIA_UPLOAD_URL_SECONDS',
      DEFAULT_URL_SECONDS.upload,
    ),
    downloadUrlSeconds: readSeconds(
      environment,
      'MEDIA_DOWNLOAD_URL_SECONDS',
      DEFAULT_URL_SECONDS.download,
    ),
  };
}

function setting(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = environment[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function readSeconds(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = setting(environment, name);
  if (raw === undefined) {
    return fallback;
  }

  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_URL_SECONDS) {
    throw new StorageConfigError(
      `${name} has to be a whole number of seconds from 1 to ${MAX_URL_SECONDS}, ` +
        `not ${JSON.stringify(raw)}.`,
    );
  }
  return seconds;
}
