/**
 * Hashing and checking passwords (EXPD-004).
 *
 * Built on `node:crypto` alone. No dependency was added, and none was needed:
 * scrypt is in the standard library, and it is a memory-hard function
 * designed for exactly this.
 *
 * The stored value carries its own parameters:
 *
 *     scrypt$16384$8$1$64$<salt base64url>$<derived key base64url>
 *             N     r p len
 *
 * That matters more than it looks. Raising the cost later is a change to
 * `DEFAULT_PARAMETERS` and nothing else: rows written with the old cost keep
 * verifying, because the cost they were written with is in the row. `needsRehash`
 * says when a row is behind, so a sign-in that has just proved the password
 * can quietly write it back at the new cost.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** How hard the hash is to compute. */
export interface ScryptParameters {
  /** CPU and memory cost. A power of two. */
  readonly cost: number;
  /** Block size. */
  readonly blockSize: number;
  /** How many independent mixes to run. */
  readonly parallelism: number;
  /** How many bytes of key to derive. */
  readonly keyLength: number;
}

/**
 * What a new password is hashed with.
 *
 * N = 16384, r = 8, p = 1 is the long-standing interactive setting, and needs
 * about 16 MiB of memory per hash. Node's default `maxmem` is 32 MiB, which
 * this fits inside.
 */
export const DEFAULT_PARAMETERS: ScryptParameters = {
  cost: 16384,
  blockSize: 8,
  parallelism: 1,
  keyLength: 64,
};

/** How many bytes of salt each password gets. */
const SALT_BYTES = 16;

/** The prefix that names the algorithm in a stored hash. */
const ALGORITHM = 'scrypt';

/**
 * The shortest password the API accepts.
 *
 * Length is the only rule. Composition rules — a digit, a capital, a symbol —
 * push people towards `Password1!`, and the platform would rather have a long
 * passphrase.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The longest password the API accepts.
 *
 * A cap is needed because hashing is deliberately slow, and without one a
 * megabyte of text is a cheap way to tie up the process.
 */
export const MAX_PASSWORD_LENGTH = 256;

/** Why a password was not acceptable. */
export type PasswordProblem = 'too-short' | 'too-long' | 'not-a-string';

/** Checks a password is one the API will store. Returns null when it is. */
export function checkPassword(password: unknown): PasswordProblem | null {
  if (typeof password !== 'string') {
    return 'not-a-string';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'too-short';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'too-long';
  }
  return null;
}

/**
 * Hashes a password for storage in `user_credential.password_hash`.
 *
 * The caller checks the password with `checkPassword` first. This throws on
 * one that is out of range rather than spending a slow hash on it.
 */
export async function hashPassword(
  password: string,
  parameters: ScryptParameters = DEFAULT_PARAMETERS,
): Promise<string> {
  const problem = checkPassword(password);
  if (problem !== null) {
    throw new Error(`Refusing to hash a password that is ${problem}.`);
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, parameters);

  return [
    ALGORITHM,
    parameters.cost,
    parameters.blockSize,
    parameters.parallelism,
    parameters.keyLength,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false rather than throwing on a hash it cannot read. A row that has
 * been corrupted should fail the sign-in, not crash the request, and the two
 * look the same to whoever is trying.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parsed = parseHash(storedHash);
  if (parsed === null) {
    return false;
  }
  if (checkPassword(password) !== null) {
    return false;
  }

  const derived = await derive(password, parsed.salt, parsed.parameters);
  if (derived.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.key);
}

/**
 * True when the stored hash was written with weaker parameters than the
 * current default, so it should be written back after a successful sign-in.
 */
export function needsRehash(
  storedHash: string,
  parameters: ScryptParameters = DEFAULT_PARAMETERS,
): boolean {
  const parsed = parseHash(storedHash);
  if (parsed === null) {
    return true;
  }
  const stored = parsed.parameters;
  return (
    stored.cost < parameters.cost ||
    stored.blockSize < parameters.blockSize ||
    stored.parallelism < parameters.parallelism ||
    stored.keyLength < parameters.keyLength
  );
}

/**
 * Spends about as long as a real check would, without checking anything.
 *
 * Called when the email is not one the platform knows. Without it, a missing
 * account answers far faster than a wrong password, and anybody can tell the
 * two apart and read off who has an account.
 */
export async function spendVerificationTime(): Promise<void> {
  await derive('no such account', randomBytes(SALT_BYTES), DEFAULT_PARAMETERS);
}

async function derive(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return scryptAsync(Buffer.from(password, 'utf8'), salt, parameters.keyLength, {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelism,
    // scrypt needs roughly 128 * N * r bytes. Ask for twice that, so raising
    // the cost does not run into Node's default 32 MiB ceiling.
    maxmem: 256 * parameters.cost * parameters.blockSize,
  });
}

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(storedHash: string): ParsedHash | null {
  if (typeof storedHash !== 'string') {
    return null;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 7 || parts[0] !== ALGORITHM) {
    return null;
  }

  const [, cost, blockSize, parallelism, keyLength, salt, key] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const parameters: ScryptParameters = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism),
    keyLength: Number(keyLength),
  };

  const sane = Object.values(parameters).every(
    (value) => Number.isInteger(value) && value > 0,
  );
  if (!sane) {
    return null;
  }

  return {
    parameters,
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
}
