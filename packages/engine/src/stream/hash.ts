/**
 * The seal, and the exact bytes it is taken over (EXPD-014).
 *
 * Two things have to be true before a hash chain is worth anything, and both
 * are here:
 *
 *   1. **The same line always becomes the same bytes.** `JSON.stringify` is
 *      not enough on its own: it writes keys in whatever order the object was
 *      built in, so the same line rebuilt from a database row and from an
 *      engine call can serialise two different ways and seal to two different
 *      hashes. `canonicalJson` sorts every key and drops every `undefined`,
 *      so a line and a round trip of that line are the same bytes.
 *   2. **The hash is one everybody can work out.** SHA-256, written out here
 *      rather than taken from anywhere, because the engine has no
 *      dependencies and is not allowed to grow one. `node:crypto` would have
 *      done the job and would have needed `@types/node` on the package to
 *      typecheck, which is a dependency; it would also have made the engine
 *      Node-only, and a results screen checking a total in a browser is
 *      exactly the use this record is for.
 *
 * The code below is FIPS 180-4 as written, and `hash.test.ts` holds it to the
 * published vectors. Nothing here is a novel construction: a hand-rolled
 * cipher would be a bad idea, and a hand-rolled implementation of a published
 * hash, tested against its own vectors, is a transcription.
 */

import type { JsonValue } from '@explorer/shared-types';

/**
 * JSON with every key in sorted order and nothing optional left in.
 *
 * `undefined` disappears from an object and becomes `null` in an array, which
 * is what `JSON.stringify` already does and what the database already does to
 * a column nobody set.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, JsonValue | undefined>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The text as UTF-8 bytes.
 *
 * Written out rather than taken from `TextEncoder`, which is a global the
 * engine's `lib` does not declare. Lone surrogates — a half of a pair with no
 * other half, which a mission's `note` could carry — become U+FFFD, the same
 * way `TextEncoder` handles them, so that no input can produce bytes a reader
 * could not reproduce.
 */
function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    let point = character.codePointAt(0) ?? 0xfffd;
    if (point >= 0xd800 && point <= 0xdfff) {
      point = 0xfffd;
    }
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** The first thirty-two bits of the cube roots of the first sixty-four primes. */
const ROUND_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first thirty-two bits of the square roots of the first eight primes. */
const INITIAL_STATE = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

/** Rotates a thirty-two bit word right. */
function rotr(word: number, by: number): number {
  return ((word >>> by) | (word << (32 - by))) >>> 0;
}

/** Reads one word out of a typed array. The index is always in range. */
function at(words: Uint32Array, index: number): number {
  return words[index] ?? 0;
}

/**
 * SHA-256 of a string, as sixty-four lower-case hexadecimal characters.
 *
 * FIPS 180-4 section 6.2. The message is padded with a 1 bit, then noughts,
 * then its length in bits as a 64-bit big-endian number, to a whole number of
 * 64-byte blocks.
 */
export function sha256Hex(text: string): string {
  const message = utf8Bytes(text);
  const bitLength = message.length * 8;
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;

  // The length goes in the last eight bytes, big-endian. A message long
  // enough to need the high word would be 512MB, which nothing here writes,
  // but leaving it out would make this the wrong hash rather than a slow one.
  const lengthAt = padded.length - 8;
  padded[lengthAt + 3] = Math.floor(bitLength / 0x100000000) & 0xff;
  padded[lengthAt + 4] = (bitLength >>> 24) & 0xff;
  padded[lengthAt + 5] = (bitLength >>> 16) & 0xff;
  padded[lengthAt + 6] = (bitLength >>> 8) & 0xff;
  padded[lengthAt + 7] = bitLength & 0xff;

  const state = Uint32Array.from(INITIAL_STATE);
  const schedule = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteAt = block + index * 4;
      schedule[index] =
        (((padded[byteAt] ?? 0) << 24) |
          ((padded[byteAt + 1] ?? 0) << 16) |
          ((padded[byteAt + 2] ?? 0) << 8) |
          (padded[byteAt + 3] ?? 0)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const fifteen = at(schedule, index - 15);
      const two = at(schedule, index - 2);
      const small = rotr(fifteen, 7) ^ rotr(fifteen, 18) ^ (fifteen >>> 3);
      const large = rotr(two, 17) ^ rotr(two, 19) ^ (two >>> 10);
      schedule[index] =
        (large + at(schedule, index - 7) + small + at(schedule, index - 16)) >>>
        0;
    }

    let a = at(state, 0);
    let b = at(state, 1);
    let c = at(state, 2);
    let d = at(state, 3);
    let e = at(state, 4);
    let f = at(state, 5);
    let g = at(state, 6);
    let h = at(state, 7);

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first =
        (h + sum1 + choose + at(ROUND_CONSTANTS, index) + at(schedule, index)) >>>
        0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }

    state[0] = (at(state, 0) + a) >>> 0;
    state[1] = (at(state, 1) + b) >>> 0;
    state[2] = (at(state, 2) + c) >>> 0;
    state[3] = (at(state, 3) + d) >>> 0;
    state[4] = (at(state, 4) + e) >>> 0;
    state[5] = (at(state, 5) + f) >>> 0;
    state[6] = (at(state, 6) + g) >>> 0;
    state[7] = (at(state, 7) + h) >>> 0;
  }

  let hex = '';
  for (let index = 0; index < 8; index += 1) {
    hex += at(state, index).toString(16).padStart(8, '0');
  }
  return hex;
}
