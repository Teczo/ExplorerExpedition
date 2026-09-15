/**
 * Access tokens and refresh tokens (EXPD-004).
 *
 * Two different things, on purpose.
 *
 * An **access token** is signed and self contained. The API checks the
 * signature and reads the organisation and the role straight out of it, with
 * no database round trip on every request. That is the point: an API-first
 * platform with a student app on a school's wifi cannot afford a query per
 * call. The price is that it cannot be withdrawn, so it is short lived —
 * fifteen minutes by default.
 *
 * A **refresh token** is a random string that means nothing on its own. It is
 * looked up in `auth_session` every time, so it can be withdrawn the moment
 * somebody signs out or a password changes. It lives for a month.
 *
 * The signing is HMAC-SHA256 over `header.payload`, base64url throughout.
 * The layout is JWT-shaped so that it reads the way people expect, but it is
 * read by the code in this file and nothing else, and `typ` is the platform's
 * own. Two rules keep the well-known JWT mistakes out:
 *
 *   1. `alg` is not consulted. It is written, and on the way back in it has
 *      to equal `HS256` exactly. There is no algorithm to negotiate, so
 *      `alg: "none"` has nothing to negotiate with.
 *   2. The signature is compared with `timingSafeEqual`.
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/** The only algorithm this file writes or accepts. */
const ALGORITHM = 'HS256';

/** Marks a token as this platform's, so another system's cannot be replayed. */
const TOKEN_TYPE = 'EXPD1';

/** What the token is for. A device token is never accepted as a user token. */
export type TokenAudience = 'user' | 'device';

/** What is inside an access token once it has been checked. */
export interface AccessTokenClaims {
  /** Who the token is for: a user id, or a participant id. */
  readonly sub: string;
  /** What kind of caller. */
  readonly aud: TokenAudience;
  /** The organisation the token acts for. Always present. */
  readonly org: string;
  /** Seconds since the epoch when it was issued. */
  readonly iat: number;
  /** Seconds since the epoch when it stops being accepted. */
  readonly exp: number;
  /** A unique id for this token, so it can be named in a log. */
  readonly jti: string;
  /** Everything else the caller put in. */
  readonly [claim: string]: unknown;
}

/**
 * The claims a caller supplies. `iat` and `exp` are filled in here, and `jti`
 * is generated unless one is given.
 */
export interface AccessTokenInput {
  readonly sub: string;
  readonly aud: TokenAudience;
  readonly org: string;
  readonly jti?: string;
  readonly [claim: string]: unknown;
}

/** Why a token was not accepted. */
export type TokenProblem =
  /** Not three base64url parts separated by dots. */
  | 'malformed'
  /** The header was not this platform's. */
  | 'wrong-type'
  /** The signature did not match. */
  | 'bad-signature'
  /** `exp` has passed. */
  | 'expired'
  /** A claim the platform requires was absent or the wrong shape. */
  | 'bad-claims'
  /** The token was minted for a different kind of caller. */
  | 'wrong-audience';

/** What checking a token gives back. */
export type TokenResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly problem: TokenProblem };

/** The key an access token is signed with. */
export interface SigningKey {
  /**
   * The secret. At least 32 bytes of it: HMAC-SHA256's security rests on the
   * key being at least as long as its output.
   */
  readonly secret: Buffer;
}

/** The shortest signing secret the platform accepts, in bytes. */
export const MIN_SECRET_BYTES = 32;

/** Builds a signing key, checking the secret is long enough. */
export function signingKey(secret: string | Buffer): SigningKey {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(
      `An access token signing secret needs at least ${MIN_SECRET_BYTES} bytes; ` +
        `this one has ${bytes.length}.`,
    );
  }
  return { secret: bytes };
}

/** Signs an access token that expires `lifetimeSeconds` from now. */
export function signAccessToken(
  key: SigningKey,
  claims: AccessTokenInput,
  lifetimeSeconds: number,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const full: AccessTokenClaims = {
    ...claims,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    jti: claims.jti ?? randomId(),
  };

  const header = encode({ alg: ALGORITHM, typ: TOKEN_TYPE });
  const payload = encode(full);
  const signature = sign(key, `${header}.${payload}`);

  return `${header}.${payload}.${signature.toString('base64url')}`;
}

/**
 * Checks an access token and reads its claims.
 *
 * `audience` is not optional. Every caller knows which kind of token it is
 * expecting, and saying so is what stops a student's device token being
 * presented to a staff endpoint.
 */
export function verifyAccessToken(
  key: SigningKey,
  token: string,
  audience: TokenAudience,
  now: Date = new Date(),
): TokenResult {
  if (typeof token !== 'string') {
    return { ok: false, problem: 'malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, problem: 'malformed' };
  }
  const [header, payload, signature] = parts as [string, string, string];

  const decodedHeader = decode(header);
  if (
    decodedHeader === null ||
    decodedHeader['alg'] !== ALGORITHM ||
    decodedHeader['typ'] !== TOKEN_TYPE
  ) {
    return { ok: false, problem: 'wrong-type' };
  }

  const expected = sign(key, `${header}.${payload}`);
  const offered = Buffer.from(signature, 'base64url');
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return { ok: false, problem: 'bad-signature' };
  }

  const claims = decode(payload);
  if (claims === null) {
    return { ok: false, problem: 'malformed' };
  }
  if (
    typeof claims['sub'] !== 'string' ||
    typeof claims['org'] !== 'string' ||
    typeof claims['jti'] !== 'string' ||
    typeof claims['iat'] !== 'number' ||
    typeof claims['exp'] !== 'number'
  ) {
    return { ok: false, problem: 'bad-claims' };
  }
  if (claims['aud'] !== audience) {
    return { ok: false, problem: 'wrong-audience' };
  }
  if (claims['exp'] * 1000 <= now.getTime()) {
    return { ok: false, problem: 'expired' };
  }

  return { ok: true, claims: claims as unknown as AccessTokenClaims };
}

/** How many bytes of randomness a refresh or device token carries. */
const OPAQUE_TOKEN_BYTES = 32;

/**
 * Mints a refresh token or a device token.
 *
 * It is 256 bits from the system's random source and carries no structure at
 * all: guessing one and looking one up are the only ways to use it.
 */
export function mintOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes an opaque token for storage.
 *
 * Plain SHA-256, with no salt and no cost, and that is right here. Salting
 * and stretching defend a secret people chose, which is guessable. These
 * tokens are 256 random bits, so there is nothing to guess and nothing a
 * rainbow table could hold. The hash is here so that reading the table gives
 * an attacker no token they can present.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Returns true when a token matches a stored hash, without leaking timing. */
export function opaqueTokenMatches(token: string, storedHash: string): boolean {
  const offered = Buffer.from(hashOpaqueToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/**
 * Pulls the token out of an `Authorization: Bearer <token>` header.
 *
 * Returns null for a header that is absent, is another scheme, or is empty.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer[ ]+(?<token>[A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  return match?.groups?.['token'] ?? null;
}

function sign(key: SigningKey, content: string): Buffer {
  return createHmac('sha256', key.secret).update(content, 'utf8').digest();
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function randomId(): string {
  return randomBytes(16).toString('base64url');
}
