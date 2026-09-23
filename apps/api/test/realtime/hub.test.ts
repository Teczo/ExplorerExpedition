/**
 * The hub, and what each change says (EXPD-023).
 *
 * Without a socket: who is in which audience, what a failed publish does,
 * what a gap does, and the notices each kind of change turns into.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { RealtimeEvent } from '@explorer/shared-types';

import type { PlayView } from '../../src/play/views.ts';
import type { RealtimeBroker } from '../../src/realtime/broker.ts';
import { InProcessBroker } from '../../src/realtime/broker.ts';
import {
  channelOf,
  hears,
  RealtimeHub,
  type Audience,
  type StreamListener,
  type Viewer,
} from '../../src/realtime/hub.ts';
import {
  participantRemovedNotices,
  participantTeamChangedNotices,
  playedNotices,
} from '../../src/realtime/notices.ts';
import { until } from './support.ts';

const RUN = { organisationId: 'org-1', sessionId: 'run-1' };

function listener(viewer: Viewer): StreamListener & { heard: RealtimeEvent[]; resyncs: number; ended: boolean } {
  const self = {
    viewer,
    heard: [] as RealtimeEvent[],
    resyncs: 0,
    ended: false,
    deliver: (event: RealtimeEvent) => void self.heard.push(event),
    resync: () => {
      self.resyncs += 1;
    },
    end: () => {
      self.ended = true;
    },
  };
  return self;
}

describe('who hears what', () => {
  const staff: Viewer = { kind: 'staff' };
  const red: Viewer = { kind: 'device', participantId: 'asha', teamId: 'red' };
  const none: Viewer = { kind: 'device', participantId: 'dev', teamId: null };

  const cases: [Audience, boolean, boolean, boolean][] = [
    //                                                   staff  red    no team
    [{ kind: 'everyone' },                                true,  true,  true],
    [{ kind: 'staff' },                                   true,  false, false],
    [{ kind: 'team', teamId: 'red' },                     true,  true,  false],
    [{ kind: 'team', teamId: 'blue' },                    true,  false, false],
    [{ kind: 'participant', participantId: 'asha' },      true,  true,  false],
    [{ kind: 'participant', participantId: 'dev' },       true,  false, true],
  ];
  for (const [audience, byStaff, byRed, byNone] of cases) {
    test(JSON.stringify(audience), () => {
      assert.equal(hears(staff, audience), byStaff);
      assert.equal(hears(red, audience), byRed);
      assert.equal(hears(none, audience), byNone);
    });
  }

  test('a run\'s channel names its organisation', () => {
    assert.equal(channelOf(RUN), 'expd:realtime:org-1:run-1');
  });
});

describe('the hub', () => {
  test('delivers to the audience, and moves a phone with its team', async () => {
    const hub = new RealtimeHub({ broker: new InProcessBroker() });
    const asha = listener({ kind: 'device', participantId: 'asha', teamId: 'blue' });
    await hub.attach(RUN, asha);

    await hub.publish(RUN, participantTeamChangedNotices('asha', 'red'));
    await hub.publish(RUN, [
      { audience: { kind: 'team', teamId: 'red' }, event: { type: 'announcement', message: 'red', teamId: 'red' } },
    ]);
    await until(() => asha.heard.length === 2, 'two events');

    assert.deepEqual(
      asha.heard.map((event) => event.type),
      ['participant.team-changed', 'announcement'],
    );
    assert.equal(asha.viewer.kind === 'device' && asha.viewer.teamId, 'red');
  });

  test('ends a phone\'s stream when its student is taken out', async () => {
    const hub = new RealtimeHub({ broker: new InProcessBroker() });
    const asha = listener({ kind: 'device', participantId: 'asha', teamId: 'red' });
    const ben = listener({ kind: 'device', participantId: 'ben', teamId: 'red' });
    await hub.attach(RUN, asha);
    await hub.attach(RUN, ben);

    await hub.publish(RUN, participantRemovedNotices('asha'));
    await until(() => asha.ended, 'the stream to end');
    assert.equal(ben.ended, false);
    assert.deepEqual(ben.heard, []);
  });

  test('a failed publish is logged, and does not throw', async () => {
    const lines: string[] = [];
    const broken: RealtimeBroker = {
      publish: () => Promise.reject(new Error('Redis is down')),
      subscribe: () => Promise.reject(new Error('Redis is down')),
      close: () => Promise.resolve(),
    };
    const hub = new RealtimeHub({ broker: broken, log: (line) => void lines.push(line) });
    const sent = await hub.publish(RUN, [
      { audience: { kind: 'everyone' }, event: { type: 'leaderboard.changed' } },
    ]);
    assert.deepEqual(sent, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /could not publish leaderboard.changed/);

    await assert.rejects(hub.attach(RUN, listener({ kind: 'staff' })), /Redis is down/);
    assert.equal(hub.listenerCount(RUN), 0);
  });

  test('a gap tells every stream to read again', async () => {
    let gap: (() => void) | undefined;
    const broker: RealtimeBroker = {
      publish: () => Promise.resolve(),
      subscribe: (_channel, _listener, onGap) => {
        gap = onGap;
        return Promise.resolve(() => Promise.resolve());
      },
      close: () => Promise.resolve(),
    };
    const hub = new RealtimeHub({ broker });
    const one = listener({ kind: 'staff' });
    const two = listener({ kind: 'device', participantId: 'asha', teamId: null });
    await hub.attach(RUN, one);
    await hub.attach(RUN, two);

    gap?.();
    assert.equal(one.resyncs, 1);
    assert.equal(two.resyncs, 1);
  });

  test('ignores a message on the channel that is not an event', async () => {
    const broker = new InProcessBroker();
    const lines: string[] = [];
    const hub = new RealtimeHub({ broker, log: (line) => void lines.push(line) });
    const staff = listener({ kind: 'staff' });
    await hub.attach(RUN, staff);

    await broker.publish(channelOf(RUN), 'not json');
    await broker.publish(channelOf(RUN), '{"audience":{"kind":"everyone"}}');
    await until(() => lines.length === 2, 'both to be ignored');
    assert.deepEqual(staff.heard, []);
  });
});

describe('what a played mission says', () => {
  const base: PlayView = {
    teamId: 'red',
    mission: { id: 'gate', state: 'complete', attemptsUsed: 1, allowedTriggers: [] },
    attempt: null,
    score: { total: 15, events: [] },
    progression: { events: [], unlockedMissionIds: [], visibleMissionIds: [], finished: false },
  };

  test('a try starting: the team hears it, and the board has not moved', () => {
    const notices = playedNotices({ ...base, mission: { ...base.mission, state: 'in-progress' } });
    assert.deepEqual(
      notices.map((notice) => [notice.event.type, notice.audience]),
      [['team.progress', { kind: 'team', teamId: 'red' }]],
    );
  });

  test('points and a door: the team hears both, and everybody hears the board moved', () => {
    const notices = playedNotices({
      ...base,
      score: {
        total: 15,
        events: [
          { reason: 'mission-complete', points: 10, at: '2026-09-01T09:00:00.000Z' },
          { reason: 'first-to-complete-bonus', points: 5, at: '2026-09-01T09:00:00.000Z' },
        ],
      } as PlayView['score'],
      progression: {
        ...base.progression,
        events: [
          { reason: 'mission-unlocked', missionInstanceId: 'tower', at: '2026-09-01T09:00:00.000Z' },
          { reason: 'mission-revealed', missionInstanceId: 'tower', at: '2026-09-01T09:00:00.000Z' },
          { reason: 'node-reached', nodeId: 'node-tower', at: '2026-09-01T09:00:00.000Z' },
        ],
      } as unknown as PlayView['progression'],
    });
    assert.deepEqual(
      notices.map((notice) => notice.event),
      [
        {
          type: 'team.progress',
          teamId: 'red',
          missionId: 'gate',
          missionState: 'complete',
          totalScore: 15,
          scoreDelta: 15,
          finished: false,
        },
        { type: 'mission.unlocked', teamId: 'red', missionIds: ['tower'] },
        { type: 'leaderboard.changed' },
      ],
    );
    assert.deepEqual(notices[2]?.audience, { kind: 'everyone' });
  });

  test('finishing moves the board even with no points in it', () => {
    const notices = playedNotices({
      ...base,
      progression: {
        ...base.progression,
        finished: true,
        events: [{ reason: 'expedition-finished', nodeId: 'finish', at: '2026-09-01T09:00:00.000Z' }],
      } as unknown as PlayView['progression'],
    });
    assert.deepEqual(
      notices.map((notice) => notice.event.type),
      ['team.progress', 'leaderboard.changed'],
    );
  });
});
