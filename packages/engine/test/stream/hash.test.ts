/**
 * That the seal is the hash everybody else means by SHA-256.
 *
 * The engine writes its own, because it has no dependencies and may not grow
 * one. That is only safe if it really is the published algorithm, so it is
 * held to the published vectors rather than to itself: a hash that is
 * self-consistent and wrong would pass every other test in this folder and
 * would make the record worthless the first time somebody checked it with a
 * different tool.
 *
 * The canonical form is tested for the property the chain rests on — the same
 * line always becomes the same bytes, however the object was built.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, sha256Hex } from '../../src/stream/hash.ts';

describe('the seal', () => {
  // FIPS 180-4, and the three vectors everybody quotes.
  it('is SHA-256 as published', () => {
    assert.equal(
      sha256Hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      sha256Hex(
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      ),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  // Long enough to run the padding into a block of its own, which is the
  // corner a hand-written implementation gets wrong.
  it('pads a message that fills its last block', () => {
    assert.equal(
      sha256Hex('a'.repeat(55)),
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    assert.equal(
      sha256Hex('a'.repeat(56)),
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
    assert.equal(
      sha256Hex('a'.repeat(64)),
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('hashes the UTF-8 bytes of a string, not its code units', () => {
    // What a teacher's note or a mission title can actually contain.
    assert.equal(
      sha256Hex('héllo → 🎒'),
      '5982c2a8d4d89027b463e27b488d010cfbff3cbdc213b247a5ba3b2edba56cca',
    );
  });

  it('is 64 lower-case hexadecimal characters, whatever it is given', () => {
    for (const input of ['', 'abc', '🎒', 'a'.repeat(200)]) {
      assert.match(sha256Hex(input), /^[0-9a-f]{64}$/);
    }
  });
});

describe('the bytes the seal is taken over', () => {
  it('writes the same object the same way whatever order it was built in', () => {
    const one = { reason: 'speed-bonus', points: 25, at: '2026-09-11T10:00:00.000Z' };
    const other = { at: '2026-09-11T10:00:00.000Z', points: 25, reason: 'speed-bonus' };
    assert.equal(canonicalJson(one), canonicalJson(other));
  });

  it('drops a field nobody set, so a round trip seals the same', () => {
    const written = { points: 25, note: undefined };
    const read = { points: 25 };
    assert.equal(canonicalJson(written), canonicalJson(read));
  });

  it('keeps an array in the order it was given', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });

  it('sorts the keys inside a nested object too', () => {
    assert.equal(
      canonicalJson({ b: { z: 1, a: 2 }, a: 3 }),
      '{"a":3,"b":{"a":2,"z":1}}',
    );
  });

  it('writes a missing value in an array as null, the way JSON does', () => {
    assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]');
  });
});
