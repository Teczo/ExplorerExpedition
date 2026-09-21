/**
 * The code itself (EXPD-018).
 *
 * The only tests in this ticket that do not send a request. A join code is
 * read off a whiteboard and typed by a child, and everything here is about
 * that: the alphabet has nothing in it a child could misread, a generated
 * code is one the column would accept, and what somebody types is read
 * forgivingly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateJoinCode,
  generateJoinCode,
  isJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  JoinCodeExhaustedError,
  normaliseJoinCode,
} from '../../src/participation/join-codes.ts';

describe('the alphabet a code is built from', () => {
  test('has no character twice', () => {
    assert.equal(new Set(JOIN_CODE_ALPHABET).size, JOIN_CODE_ALPHABET.length);
  });

  test('is inside what the column allows', () => {
    assert.ok(/^[A-Z0-9]+$/.test(JOIN_CODE_ALPHABET));
  });

  test('keeps only one character out of each confusable group', () => {
    for (const group of ['0OQD', '1ILJ', '2Z', '5S', '6G', '8B', 'UV']) {
      const kept = [...group].filter((character) =>
        JOIN_CODE_ALPHABET.includes(character),
      );

      assert.equal(
        kept.length,
        1,
        `${group} should contribute one character, not ${kept.join('')}`,
      );
    }
  });
});

describe('a generated code', () => {
  test('is the length the ticket settled on', () => {
    assert.equal(generateJoinCode().length, JOIN_CODE_LENGTH);
  });

  test('is one the column would accept', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.ok(isJoinCode(generateJoinCode()));
    }
  });

  test('uses nothing outside the alphabet', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      for (const character of generateJoinCode()) {
        assert.ok(
          JOIN_CODE_ALPHABET.includes(character),
          `${character} is not in the alphabet`,
        );
      }
    }
  });

  test('is not the same code every time', () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      seen.add(generateJoinCode());
    }

    assert.ok(seen.size > 40, `only ${seen.size} different codes in 50 tries`);
  });

  test('refuses a length the column would refuse', () => {
    assert.throws(() => generateJoinCode(3), RangeError);
    assert.throws(() => generateJoinCode(13), RangeError);
  });
});

describe('reading back what somebody typed', () => {
  test('upper-cases it', () => {
    assert.equal(normaliseJoinCode('hj4kmn'), 'HJ4KMN');
  });

  test('throws away the spaces and hyphens people add', () => {
    assert.equal(normaliseJoinCode('HJ4 - KMN'), 'HJ4KMN');
  });

  test('reads a zero as the D it must have been', () => {
    assert.equal(normaliseJoinCode('0J4KMN'), 'DJ4KMN');
  });

  test('reads every dropped character as the one its group kept', () => {
    assert.equal(normaliseJoinCode('OQ1ILZSGBU'), 'DDJJJ2568V');
  });

  test('leaves a code that is already right alone', () => {
    assert.equal(normaliseJoinCode('HJ4KMN'), 'HJ4KMN');
  });

  test('does not promise the result is a code', () => {
    assert.equal(isJoinCode(normaliseJoinCode('!!')), false);
  });
});

describe('finding a code nothing is using', () => {
  test('takes the first one when it is free', async () => {
    const asked: string[] = [];
    const code = await allocateJoinCode(async (candidate) => {
      asked.push(candidate);
      return false;
    });

    assert.equal(asked.length, 1);
    assert.equal(code, asked[0]);
  });

  test('tries again when a code is taken', async () => {
    let asked = 0;
    const code = await allocateJoinCode(async () => {
      asked += 1;
      return asked < 3;
    });

    assert.equal(asked, 3);
    assert.ok(isJoinCode(code));
  });

  test('gives up rather than looping for ever', async () => {
    await assert.rejects(
      allocateJoinCode(async () => true, { attempts: 4 }),
      JoinCodeExhaustedError,
    );
  });
});
