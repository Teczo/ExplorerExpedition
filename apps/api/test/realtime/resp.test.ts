/**
 * The Redis wire protocol (EXPD-023).
 *
 * Hand-written, so held to the spec here: commands written as arrays of bulk
 * strings, and every reply type read — including a reply cut in half by the
 * network and several replies in one read.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { encodeCommand, RespError, RespParser, RespProtocolError } from '../../src/realtime/resp.ts';

describe('writing a command', () => {
  test('is an array of bulk strings, counted in bytes', () => {
    assert.equal(
      encodeCommand(['PUBLISH', 'run', 'café']).toString('utf8'),
      '*3\r\n$7\r\nPUBLISH\r\n$3\r\nrun\r\n$5\r\ncafé\r\n',
    );
  });

  test('an empty argument is still an argument', () => {
    assert.equal(encodeCommand(['PING', '']).toString('utf8'), '*2\r\n$4\r\nPING\r\n$0\r\n\r\n');
  });
});

describe('reading replies', () => {
  test('every type', () => {
    const parser = new RespParser();
    const values = parser.feed(
      Buffer.from('+OK\r\n-ERR no\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*-1\r\n*2\r\n$1\r\na\r\n:1\r\n'),
    );
    assert.equal(values.length, 7);
    assert.equal(values[0], 'OK');
    assert.ok(values[1] instanceof RespError);
    assert.equal((values[1] as RespError).message, 'ERR no');
    assert.equal(values[2], 42);
    assert.equal(values[3], 'hello');
    assert.equal(values[4], null);
    assert.equal(values[5], null);
    assert.deepEqual(values[6], ['a', 1]);
  });

  test('a reply split anywhere is read once it is whole', () => {
    const whole = Buffer.from('*3\r\n$7\r\nmessage\r\n$3\r\nrun\r\n$11\r\n{"a":"b c"}\r\n');
    for (let cut = 1; cut < whole.length; cut += 1) {
      const parser = new RespParser();
      assert.deepEqual(parser.feed(whole.subarray(0, cut)), [], `cut at ${cut}`);
      assert.deepEqual(parser.feed(whole.subarray(cut)), [['message', 'run', '{"a":"b c"}']]);
    }
  });

  test('a bulk string may hold a line break', () => {
    const parser = new RespParser();
    assert.deepEqual(parser.feed(Buffer.from('$4\r\na\r\nb\r\n')), ['a\r\nb']);
  });

  test('bytes that are not RESP are refused', () => {
    assert.throws(() => new RespParser().feed(Buffer.from('?what\r\n')), RespProtocolError);
    assert.throws(() => new RespParser().feed(Buffer.from(':x\r\n')), RespProtocolError);
  });
});
