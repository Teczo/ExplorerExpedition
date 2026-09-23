/**
 * A run's stream, end to end (EXPD-023).
 *
 *   GET  /sessions/:id/events
 *   POST /sessions/:id/announcements
 *
 * What it promises: staff and the run's own phones may listen, and nobody
 * else; each hears only what its audience allows; the routers that change a
 * run tell it, after the change; and a stream ends when its token does, or
 * when its student is taken out of the run.
 *
 * "Did not hear" is proved by order, never by waiting: an event for everybody
 * is sent after the one a stream should not hear, and once that one has
 * arrived the first can no longer be on its way. One run's events keep their
 * order on the channel.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { InProcessBroker } from '../../src/realtime/broker.ts';
import { RedisBroker } from '../../src/realtime/redis-broker.ts';
import {
  ASHA,
  BEN,
  CAL,
  DEV,
  EVE,
  FakeRedis,
  MISSING_ID,
  ORG_B,
  RUN_A,
  RUN_A2,
  TEAM_BLUE,
  TEAM_RED,
  harness,
  opened,
  phone,
  seeded,
  shortPhone,
  staff,
  until,
  type OpenedStream,
} from './support.ts';

const announce = `/sessions/${RUN_A}/announcements`;

/** Sends an announcement to everybody and waits for each stream to hear it. */
async function flush(
  h: Awaited<ReturnType<typeof harness>>,
  ...streams: OpenedStream[]
): Promise<void> {
  const answer = await h.post(announce, staff(), { message: 'flush' });
  assert.equal(answer.status, 202);
  for (const stream of streams) {
    for (;;) {
      const event = await stream.next('announcement');
      if (event.type === 'announcement' && event.message === 'flush') {
        break;
      }
    }
  }
}

describe('opening a stream', () => {
  test('staff hear a run of their own, starting with channel.ready', async () => {
    const h = await harness();
    try {
      const stream = opened(await h.stream(staff()));
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(stream.headers.get('cache-control'), 'no-store');

      const ready = await stream.next('channel.ready');
      assert.equal(stream.events[0]?.type, 'channel.ready');
      assert.equal(ready.sessionId, RUN_A);
      assert.equal(typeof ready.id, 'string');
      assert.equal(typeof ready.sentAt, 'string');
      assert.deepEqual(
        { status: ready.type === 'channel.ready' && ready.sessionStatus, team: ready.type === 'channel.ready' && ready.teamId },
        { status: 'running', team: null },
      );
    } finally {
      await h.close();
    }
  });

  test('a phone hears its own run, and is told its team', async () => {
    const h = await harness();
    try {
      const asha = opened(await h.stream(phone(ASHA)));
      const ready = await asha.next('channel.ready');
      assert.equal(ready.type === 'channel.ready' && ready.teamId, TEAM_RED);

      const dev = opened(await h.stream(phone(DEV)));
      const devReady = await dev.next('channel.ready');
      assert.equal(devReady.type === 'channel.ready' && devReady.teamId, null);
    } finally {
      await h.close();
    }
  });

  test('asks for a token', async () => {
    const h = await harness();
    try {
      const answer = await h.stream(null);
      assert.equal(answer.status, 401);
    } finally {
      await h.close();
    }
  });

  test('another run is not found, for a phone', async () => {
    const h = await harness();
    try {
      const answer = await h.stream(phone(ASHA), RUN_A2);
      assert.equal(answer.status, 404);
    } finally {
      await h.close();
    }
  });

  test('a student taken out of the run is refused', async () => {
    const h = await harness();
    try {
      const answer = await h.stream(phone(EVE));
      assert.equal(answer.status, 404);
    } finally {
      await h.close();
    }
  });

  test('another school\'s run is not found, and so is one that does not exist', async () => {
    const h = await harness();
    try {
      assert.equal((await h.stream(staff({ organisationId: ORG_B }))).status, 404);
      assert.equal((await h.stream(staff(), MISSING_ID)).status, 404);
      assert.equal((await h.stream(staff(), 'not-a-uuid')).status, 422);
    } finally {
      await h.close();
    }
  });

  test('sends a heartbeat', async () => {
    const h = await harness({ realtimeHeartbeatSeconds: 0.05 });
    try {
      const stream = opened(await h.stream(staff()));
      await until(() => stream.comments.includes('heartbeat'), 'a heartbeat');
    } finally {
      await h.close();
    }
  });

  test('ends when the token does', async () => {
    const h = await harness();
    try {
      const stream = opened(await h.stream(shortPhone(ASHA, 1)));
      await stream.next('channel.ready');
      const started = Date.now();
      await stream.ended;
      assert.ok(Date.now() - started < 2_000);
    } finally {
      await h.close();
    }
  });

  test('lets go of the channel when the last stream closes', async () => {
    const broker = new InProcessBroker();
    const h = await harness({ realtimeBroker: broker });
    try {
      const one = opened(await h.stream(staff()));
      const two = opened(await h.stream(phone(ASHA)));
      await one.next('channel.ready');
      await two.next('channel.ready');
      assert.equal(broker.channelCount, 1);

      one.close();
      two.close();
      await until(() => broker.channelCount === 0, 'the channel to be released');
    } finally {
      await h.close();
    }
  });
});

describe('announcements', () => {
  test('to everybody reach staff and every phone', async () => {
    const h = await harness();
    try {
      const streams = [
        opened(await h.stream(staff())),
        opened(await h.stream(phone(ASHA))),
        opened(await h.stream(phone(CAL))),
        opened(await h.stream(phone(DEV))),
      ];
      for (const stream of streams) {
        await stream.next('channel.ready');
      }

      const answer = await h.post(announce, staff(), { message: 'Back to the gate at two.' });
      assert.equal(answer.status, 202);
      assert.equal(answer.body['type'], 'announcement');
      assert.equal(answer.body['teamId'], null);

      for (const stream of streams) {
        const heard = await stream.next('announcement');
        assert.equal(heard.type === 'announcement' && heard.message, 'Back to the gate at two.');
        assert.equal(heard.id, answer.body['id']);
      }
    } finally {
      await h.close();
    }
  });

  test('to one team reach that team and staff, and nobody else', async () => {
    const h = await harness();
    try {
      const teacher = opened(await h.stream(staff()));
      const asha = opened(await h.stream(phone(ASHA)));
      const cal = opened(await h.stream(phone(CAL)));
      for (const stream of [teacher, asha, cal]) {
        await stream.next('channel.ready');
      }

      const answer = await h.post(announce, staff(), { message: 'Red: try the tower.', teamId: TEAM_RED });
      assert.equal(answer.status, 202);

      await flush(h, teacher, asha, cal);
      const said = (stream: OpenedStream): string[] =>
        stream.all('announcement').map((event) => (event.type === 'announcement' ? event.message : ''));
      assert.deepEqual(said(teacher), ['Red: try the tower.', 'flush']);
      assert.deepEqual(said(asha), ['Red: try the tower.', 'flush']);
      assert.deepEqual(said(cal), ['flush']);
    } finally {
      await h.close();
    }
  });

  test('are refused to a phone', async () => {
    const h = await harness();
    try {
      const answer = await h.post(announce, phone(ASHA), { message: 'Hello' });
      assert.equal(answer.status, 403);
    } finally {
      await h.close();
    }
  });

  test('check what was sent', async () => {
    const h = await harness();
    try {
      assert.equal((await h.post(announce, staff(), { message: '' })).status, 422);
      assert.equal((await h.post(announce, staff(), { message: 'x'.repeat(501) })).status, 422);
      assert.equal((await h.post(announce, staff(), { message: 'Hi', extra: 1 })).status, 422);
      assert.equal((await h.post(announce, staff(), { message: 'Hi', teamId: MISSING_ID })).status, 404);
      assert.equal(
        (await h.post(`/sessions/${MISSING_ID}/announcements`, staff(), { message: 'Hi' })).status,
        404,
      );
      assert.equal(
        (await h.post(announce, staff({ organisationId: ORG_B }), { message: 'Hi' })).status,
        404,
      );
    } finally {
      await h.close();
    }
  });

  test('to a run that is over are refused', async () => {
    const h = await harness({ db: seeded({ runStatus: 'ended' }) });
    try {
      const answer = await h.post(announce, staff(), { message: 'Hi' });
      assert.equal(answer.status, 409);
    } finally {
      await h.close();
    }
  });

  test('reach a phone held by another instance', async () => {
    // Two API instances, one broker between them: what Redis is on App Service.
    const broker = new InProcessBroker();
    const db = seeded();
    const first = await harness({ db, realtimeBroker: broker });
    const second = await harness({ db, realtimeBroker: broker });
    try {
      const asha = opened(await second.stream(phone(ASHA)));
      await asha.next('channel.ready');

      const answer = await first.post(announce, staff(), { message: 'From the other side.' });
      assert.equal(answer.status, 202);
      const heard = await asha.next('announcement');
      assert.equal(heard.type === 'announcement' && heard.message, 'From the other side.');
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('through Redis', () => {
  test('a teacher on one instance pauses the run, and a phone on another hears it', async () => {
    const redis = await new FakeRedis({ password: 'key' }).start();
    const brokerFor = (): RedisBroker =>
      new RedisBroker({
        endpoint: { host: '127.0.0.1', port: redis.port, tls: false, password: 'key' },
        log: () => undefined,
      });
    const brokers = [brokerFor(), brokerFor()];
    const db = seeded();
    const first = await harness({ db, realtimeBroker: brokers[0] });
    const second = await harness({ db, realtimeBroker: brokers[1] });
    try {
      const asha = opened(await second.stream(phone(ASHA)));
      await asha.next('channel.ready');

      assert.equal((await first.post(`/sessions/${RUN_A}/pause`, staff())).status, 200);
      const heard = await asha.next('session.status');
      assert.equal(heard.type === 'session.status' && heard.status, 'paused');
    } finally {
      await first.close();
      await second.close();
      await Promise.all(brokers.map((broker) => broker.close()));
      await redis.stop();
    }
  });
});

describe('what the routers tell the run', () => {
  test('pausing and resuming a run reaches everybody', async () => {
    const h = await harness();
    try {
      const teacher = opened(await h.stream(staff()));
      const asha = opened(await h.stream(phone(ASHA)));
      await teacher.next('channel.ready');
      await asha.next('channel.ready');

      assert.equal((await h.post(`/sessions/${RUN_A}/pause`, staff())).status, 200);
      for (const stream of [teacher, asha]) {
        const heard = await stream.next('session.status');
        assert.equal(heard.type === 'session.status' && heard.status, 'paused');
        assert.ok(heard.type === 'session.status' && heard.nextStatuses.includes('running'));
      }

      assert.equal((await h.post(`/sessions/${RUN_A}/resume`, staff())).status, 200);
      const resumed = await asha.next('session.status');
      assert.equal(resumed.type === 'session.status' && resumed.status, 'running');
    } finally {
      await h.close();
    }
  });

  test('a refused change tells nobody', async () => {
    const h = await harness();
    try {
      const teacher = opened(await h.stream(staff()));
      await teacher.next('channel.ready');
      // The run is already running, so starting it again is refused.
      assert.equal((await h.post(`/sessions/${RUN_A}/start`, staff())).status, 409);
      await flush(h, teacher);
      assert.deepEqual(teacher.all('session.status'), []);
    } finally {
      await h.close();
    }
  });

  test('a right answer tells the team, and tells everybody the board moved', async () => {
    const h = await harness();
    try {
      const teacher = opened(await h.stream(staff()));
      const asha = opened(await h.stream(phone(ASHA)));
      const cal = opened(await h.stream(phone(CAL)));
      for (const stream of [teacher, asha, cal]) {
        await stream.next('channel.ready');
      }

      // Ben plays; Asha is on his team and hears it.
      assert.equal((await h.post(`/sessions/${RUN_A}/missions/gate/attempts`, phone(BEN))).status, 201);
      const answer = await h.post(`/sessions/${RUN_A}/missions/gate/submissions`, phone(BEN), {
        payload: { code: 'OTTER' },
      });
      assert.equal(answer.status, 201);
      assert.equal(answer.body['teamId'], TEAM_RED);

      for (const stream of [teacher, asha]) {
        await stream.next('team.progress'); // the try starting
        const progress = await stream.next('team.progress');
        assert.ok(progress.type === 'team.progress');
        assert.equal(progress.teamId, TEAM_RED);
        assert.equal(progress.missionId, 'gate');
        assert.equal(progress.missionState, 'complete');
        assert.equal(progress.totalScore, 15);
        assert.equal(progress.scoreDelta, 15);

        // The team's first change also writes down the doors it started
        // with, so `tower` may come with others. It has to come.
        await until(
          () =>
            stream
              .all('mission.unlocked')
              .some((event) => event.type === 'mission.unlocked' && event.missionIds.includes('tower')),
          'tower to be unlocked',
        );
      }

      // Cal is on Blue. He hears the board moved, and nothing about Red.
      await cal.next('leaderboard.changed');
      await flush(h, cal);
      assert.deepEqual(cal.all('team.progress'), []);
      assert.deepEqual(cal.all('mission.unlocked'), []);
      assert.equal(Object.keys(cal.all('leaderboard.changed')[0] ?? {}).sort().join(','), 'id,sentAt,sessionId,type');
    } finally {
      await h.close();
    }
  });

  test('moving a student moves their stream to the new team', async () => {
    const h = await harness();
    try {
      const teacher = opened(await h.stream(staff()));
      const cal = opened(await h.stream(phone(CAL)));
      await teacher.next('channel.ready');
      await cal.next('channel.ready');

      const moved = await h.put(`/sessions/${RUN_A}/participants/${CAL}/team`, staff(), { teamId: TEAM_RED });
      assert.equal(moved.status, 200);

      const told = await cal.next('participant.team-changed');
      assert.ok(told.type === 'participant.team-changed');
      assert.equal(told.teamId, TEAM_RED);
      const roster = await teacher.next('team.roster-changed');
      assert.ok(roster.type === 'team.roster-changed');
      assert.equal(roster.participantId, CAL);
      assert.equal(roster.teamId, TEAM_RED);

      // From now on Cal hears Red, and not Blue.
      await h.post(announce, staff(), { message: 'Blue only', teamId: TEAM_BLUE });
      await h.post(announce, staff(), { message: 'Red only', teamId: TEAM_RED });
      await flush(h, cal);
      assert.deepEqual(
        cal.all('announcement').map((event) => (event.type === 'announcement' ? event.message : '')),
        ['Red only', 'flush'],
      );
      assert.deepEqual(cal.all('team.roster-changed'), []);
    } finally {
      await h.close();
    }
  });

  test('taking a student out of the run tells their phone, and ends its stream', async () => {
    const h = await harness();
    try {
      const asha = opened(await h.stream(phone(ASHA)));
      const ben = opened(await h.stream(phone(BEN)));
      await asha.next('channel.ready');
      await ben.next('channel.ready');

      const removed = await h.delete(`/sessions/${RUN_A}/participants/${ASHA}`, staff());
      assert.equal(removed.status, 200);

      const told = await asha.next('participant.removed');
      assert.equal(told.type === 'participant.removed' && told.participantId, ASHA);
      await asha.ended;

      // Ben stays, and is not told about Asha.
      await flush(h, ben);
      assert.deepEqual(ben.all('participant.removed'), []);
    } finally {
      await h.close();
    }
  });
});

describe('after a gap', () => {
  test('staff are told to read again, and a phone reconnects', async () => {
    const redis = await new FakeRedis().start();
    const broker = new RedisBroker({
      endpoint: { host: '127.0.0.1', port: redis.port, tls: false },
      retryDelaysMs: [20],
      log: () => undefined,
    });
    const h = await harness({ realtimeBroker: broker });
    try {
      const teacher = opened(await h.stream(staff()));
      const asha = opened(await h.stream(phone(ASHA)));
      await teacher.next('channel.ready');
      await asha.next('channel.ready');

      redis.dropAll();
      await teacher.next('channel.ready');
      await asha.ended;
      assert.equal(asha.all('channel.ready').length, 1);
    } finally {
      await h.close();
      await broker.close();
      await redis.stop();
    }
  });
});
