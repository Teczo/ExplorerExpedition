/**
 * The code a student types to get into a run (EXPD-018).
 *
 * A join code is read off a whiteboard by a nine-year-old and typed into a
 * phone, usually in a hurry. Everything here follows from that.
 *
 * **The alphabet keeps one character out of each confusable group.** The
 * groups are the ones people really mix up when reading handwriting or a
 * projector: `0 O Q D`, `1 I L J`, `2 Z`, `5 S`, `6 G`, `8 B`, `U V`. One
 * character of each is kept and the rest are dropped, which leaves 25. Six of
 * those is about 244 million codes — far more than a school will ever have
 * joinable at once, and every one of them unambiguous on a whiteboard.
 *
 * **Reading a code back is forgiving.** `normaliseJoinCode` upper-cases,
 * throws away the spaces and hyphens people add to make a code readable, and
 * maps each dropped character onto the one its group kept. A student who
 * types `0` gets the `D` the code actually has, because no code has a `0` in
 * it for them to have meant.
 *
 * **A code is not a secret.** It is six characters long and written in front
 * of thirty children. It says which run you are joining and nothing about who
 * you are; the device token issued at the end of joining is the credential,
 * and that one is `mintOpaqueToken`'s 256 bits.
 *
 * Migration 0001 checks `^[A-Z0-9]{4,12}$` on the column, so a generated code
 * always sits inside that. Its unique index covers the *joinable* runs only,
 * which is why allocating a code asks whether one is in use rather than
 * whether it has ever been used: when a run ends, its code goes back in the
 * pool.
 */

import { randomInt } from 'node:crypto';

/**
 * The characters a generated code is built from.
 *
 * 25 of the 36 the column allows: one from each confusable group, and
 * everything that is in no group at all. See the note above.
 */
export const JOIN_CODE_ALPHABET = 'ACDEFHJKMNPRTVWXY23456789';

/** How long a generated code is. */
export const JOIN_CODE_LENGTH = 6;

/**
 * The shape migration 0001 allows in the column.
 *
 * Wider than what `generateJoinCode` produces, on purpose. A code a teacher
 * chose by hand for their class is still a code, and this is the check that
 * says so.
 */
export const JOIN_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;

/**
 * What each dropped character is read as.
 *
 * One entry per character the alphabet does not use, pointing at the
 * character its group kept. Nothing here is a guess about what a student
 * meant in general — it is only true because a generated code cannot contain
 * the key, so the value is the only thing they can have been looking at.
 */
const CONFUSABLE: ReadonlyMap<string, string> = new Map([
  ['0', 'D'],
  ['O', 'D'],
  ['Q', 'D'],
  ['1', 'J'],
  ['I', 'J'],
  ['L', 'J'],
  ['Z', '2'],
  ['S', '5'],
  ['G', '6'],
  ['B', '8'],
  ['U', 'V'],
]);

/**
 * Reads what somebody typed as a join code.
 *
 * The result is not promised to be a valid code — `isJoinCode` answers that —
 * only to be the best reading of what was typed.
 */
export function normaliseJoinCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/[\s-]+/gu, '');
  return [...upper].map((character) => CONFUSABLE.get(character) ?? character).join('');
}

/** Returns true when the value is a code the column would accept. */
export function isJoinCode(value: string): boolean {
  return JOIN_CODE_PATTERN.test(value);
}

/**
 * Makes up a code.
 *
 * `randomInt` rather than `Math.random`, not because a code is a secret but
 * because a generator with a pattern in it would hand two classes in the same
 * school the same code far more often than chance would, and the retry loop
 * below would hide that rather than fix it.
 */
export function generateJoinCode(length: number = JOIN_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < 4 || length > 12) {
    throw new RangeError(
      `A join code is between 4 and 12 characters, not ${String(length)}. ` +
        'Migration 0001 checks that on the column.',
    );
  }

  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** How many codes are tried before allocating gives up. */
export const JOIN_CODE_ATTEMPTS = 10;

/** Thrown when that many tries in a row all landed on a code already in use. */
export class JoinCodeExhaustedError extends Error {
  override readonly name = 'JoinCodeExhaustedError';

  constructor(attempts: number) {
    super(
      `Could not find an unused join code in ${String(attempts)} tries. ` +
        'Either a great many runs are joinable at once, or the uniqueness ' +
        'check is answering wrongly.',
    );
  }
}

/**
 * Finds a code no joinable run is using.
 *
 * `isTaken` is the only part that touches the database, and it has to ask
 * across every organisation: the unique index migration 0001 builds is not
 * scoped to one, because a student typing a code has not told anybody which
 * school they are in. `JoinCodeDirectory` is what answers it.
 *
 * The loop is best effort and is meant to be. Two requests can both be told a
 * code is free and both try to use it; the index is what settles that, and
 * the loser is refused by the database rather than given a second run with
 * the same code. What the loop buys is that the common case asks once.
 */
export async function allocateJoinCode(
  isTaken: (code: string) => Promise<boolean>,
  options: { readonly length?: number; readonly attempts?: number } = {},
): Promise<string> {
  const attempts = options.attempts ?? JOIN_CODE_ATTEMPTS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = generateJoinCode(options.length ?? JOIN_CODE_LENGTH);
    if (!(await isTaken(code))) {
      return code;
    }
  }

  throw new JoinCodeExhaustedError(attempts);
}
