/**
 * Redis pub/sub as a broker (EXPD-023).
 *
 * Two brokers on one fake Redis are two API instances: what one publishes,
 * the other hears. The fake speaks RESP over a real socket, and can drop
 * every connection the way a failover does.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseRedisUrl, RedisBroker } from '../../src/realtime/redis-broker.ts';
import { readRealtimeConfig } from '../../src/config/realtime-config.ts';
import { FakeRedis, until } from './support.ts';

function brokerFor(redis: FakeRedis, password?: string): RedisBroker {
  return new RedisBroker({
    endpoint: {
      host: '127.0.0.1',
      port: redis.port,
      tls: false,
      ...(password === undefined ? {} : { password }),
    },
    retryDelaysMs: [20],
    timeoutMs: 1_000,
    log: () => undefined,
  });
}

describe('reading REDIS_URL', () => {
  test('the form EXPD-007 writes', () => {
    assert.deepEqual(parseRedisUrl('rediss://:k%2Fey%3D@redis-expd-dev.redis.cache.windows.net:6380'), {
      host: 'redis-expd-dev.redis.cache.windows.net',
      port: 6380,
      tls: true,
      password: 'k/ey=',
    });
  });

  test('a local Redis, with the default port', () => {
    assert.deepEqual(parseRedisUrl('redis://localhost'), { host: 'localhost', port: 6379, tls: false });
    assert.deepEqual(parseRedisUrl('redis://user:pw@localhost:7000'), {
      host: 'localhost',
      port: 7000,
      tls: false,
      username: 'user',
      password: 'pw',
    });
  });

  test('anything else is refused when the app is built', () => {
    assert.throws(() => parseRedisUrl('http://localhost'), /redis:\/\/ or rediss:\/\//);
    assert.throws(() => parseRedisUrl('not a url'), /not a URL/);
    assert.throws(() => readRealtimeConfig({ REDIS_URL: 'http://x' }), /redis:\/\//);
  });

  test('no REDIS_URL is no Redis', () => {
    assert.equal(readRealtimeConfig({}), undefined);
    assert.equal(readRealtimeConfig({ REDIS_URL: '  ' }), undefined);
  });
});

describe('the broker', () => {
  test('what one instance publishes, another hears', async () => {
    const redis = await new FakeRedis({ password: 'secret' }).start();
    const one = brokerFor(redis, 'secret');
    const two = brokerFor(redis, 'secret');
    try {
      const heard: string[] = [];
      await two.subscribe('run-1', (message) => heard.push(message));
      await one.publish('run-1', '{"hello":1}');
      await one.publish('run-2', 'not for us');
      await until(() => heard.length === 1, 'the message');
      assert.deepEqual(heard, ['{"hello":1}']);
      assert.ok(redis.commands.some((words) => words[0] === 'AUTH' && words[1] === 'secret'));
    } finally {
      await one.close();
      await two.close();
      await redis.stop();
    }
  });

  test('one subscription per channel, however many listen', async () => {
    const redis = await new FakeRedis().start();
    const broker = brokerFor(redis);
    try {
      const first = await broker.subscribe('run-1', () => undefined);
      const second = await broker.subscribe('run-1', () => undefined);
      assert.equal(redis.commands.filter((words) => words[0] === 'SUBSCRIBE').length, 1);

      await first();
      assert.equal(redis.subscribers('run-1'), 1);
      await second();
      await until(() => redis.subscribers('run-1') === 0, 'the unsubscribe');
    } finally {
      await broker.close();
      await redis.stop();
    }
  });

  test('a wrong password is refused', async () => {
    const redis = await new FakeRedis({ password: 'secret' }).start();
    const broker = brokerFor(redis, 'wrong');
    try {
      await assert.rejects(broker.publish('run-1', 'x'), /Redis refused AUTH/);
    } finally {
      await broker.close();
      await redis.stop();
    }
  });

  test('a publish with Redis gone fails, and the next one after it is back works', async () => {
    const redis = await new FakeRedis().start();
    const port = redis.port;
    const broker = brokerFor(redis);
    try {
      await broker.publish('run-1', 'first');
      await redis.stop();
      await assert.rejects(broker.publish('run-1', 'lost'));

      // Back on the same port, the way a restarted cache is.
      const restarted = await new FakeRedis().start(port);
      try {
        await broker.publish('run-1', 'after');
        assert.ok(restarted.commands.some((words) => words[0] === 'PUBLISH' && words[2] === 'after'));
      } finally {
        await restarted.stop();
      }
    } finally {
      await broker.close();
    }
  });

  test('subscribes again after the connection drops, and says a gap happened', async () => {
    const redis = await new FakeRedis().start();
    const listener = brokerFor(redis);
    const publisher = brokerFor(redis);
    try {
      const heard: string[] = [];
      let gaps = 0;
      await listener.subscribe('run-1', (message) => heard.push(message), () => {
        gaps += 1;
      });

      redis.dropAll();
      await until(() => gaps === 1, 'the gap to be reported');
      assert.equal(redis.subscribers('run-1'), 1);

      await publisher.publish('run-1', 'after the drop');
      await until(() => heard.includes('after the drop'), 'the message after the drop');
    } finally {
      await listener.close();
      await publisher.close();
      await redis.stop();
    }
  });

  test('refuses to work once closed', async () => {
    const redis = await new FakeRedis().start();
    const broker = brokerFor(redis);
    await broker.close();
    try {
      await assert.rejects(broker.publish('run-1', 'x'), /closed/);
    } finally {
      await redis.stop();
    }
  });
});
