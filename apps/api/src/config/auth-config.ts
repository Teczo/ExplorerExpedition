/**
 * The settings auth needs, and where they come from (EXPD-004).
 *
 * Everything here has a safe default except the signing secret, which has
 * none. An API that invented one at start-up would sign tokens with a key
 * that changes on every restart and differs between instances, and the
 * failure would look like people being randomly signed out rather than like a
 * missing setting. So a missing secret is an error, loudly, at start-up.
 */

import { MIN_SECRET_BYTES, signingKey, type SigningKey } from '../auth/tokens.ts';

/** How long each kind of token lives. */
export interface TokenLifetimes {
  /** An access token. Short, because it cannot be withdrawn. */
  readonly accessSeconds: number;
  /** A refresh token. Long, because it can be. */
  readonly refreshSeconds: number;
  /** A student's device token. It only has to outlive the school trip. */
  readonly deviceSeconds: number;
}

/** The defaults, in seconds. */
export const DEFAULT_LIFETIMES: TokenLifetimes = {
  accessSeconds: 15 * 60,
  refreshSeconds: 30 * 24 * 60 * 60,
  deviceSeconds: 14 * 24 * 60 * 60,
};

/** Everything auth needs to run. */
export interface AuthConfig {
  readonly signingKey: SigningKey;
  readonly lifetimes: TokenLifetimes;
}

/** The environment variable holding the signing secret. */
export const SECRET_VARIABLE = 'AUTH_TOKEN_SECRET';

/** Thrown when auth cannot be configured from the environment. */
export class AuthConfigError extends Error {
  override readonly name = 'AuthConfigError';
}

/**
 * Reads the auth settings from the environment.
 *
 * `AUTH_TOKEN_SECRET` is required, and has to be at least 32 bytes. On Azure
 * App Service (EXPD-007) it comes from Key Vault; in development,
 * `openssl rand -base64 48` makes one.
 *
 * The three lifetimes are optional and read in seconds:
 * `AUTH_ACCESS_TOKEN_SECONDS`, `AUTH_REFRESH_TOKEN_SECONDS`,
 * `AUTH_DEVICE_TOKEN_SECONDS`.
 */
export function readAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const secret = environment[SECRET_VARIABLE];
  if (secret === undefined || secret.trim() === '') {
    throw new AuthConfigError(
      `${SECRET_VARIABLE} is not set. Auth signs its access tokens with it, so ` +
        'the API cannot start without one. Generate one with ' +
        '`openssl rand -base64 48`.',
    );
  }

  let key: SigningKey;
  try {
    key = signingKey(secret);
  } catch (error) {
    throw new AuthConfigError(
      `${SECRET_VARIABLE} is too short. It needs at least ${MIN_SECRET_BYTES} bytes. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return {
    signingKey: key,
    lifetimes: {
      accessSeconds: readSeconds(
        environment,
        'AUTH_ACCESS_TOKEN_SECONDS',
        DEFAULT_LIFETIMES.accessSeconds,
      ),
      refreshSeconds: readSeconds(
        environment,
        'AUTH_REFRESH_TOKEN_SECONDS',
        DEFAULT_LIFETIMES.refreshSeconds,
      ),
      deviceSeconds: readSeconds(
        environment,
        'AUTH_DEVICE_TOKEN_SECONDS',
        DEFAULT_LIFETIMES.deviceSeconds,
      ),
    },
  };
}

function readSeconds(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new AuthConfigError(
      `${name} has to be a whole number of seconds above zero, not ${JSON.stringify(raw)}.`,
    );
  }
  return seconds;
}
