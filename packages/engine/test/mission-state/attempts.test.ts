/**
 * Tries, and running out of them.
 *
 * The attempt policy is one of the two things that change what a trigger
 * does. A wrong answer with a try left hands the mission back; the same wrong
 * answer on the last try ends it. Both are the `reject` trigger, and which
 * one happens is the only place in the machine where the destination is not
 * written in the table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toId,
  type MissionInstanceId,
  type MissionProgress,
} from '@explorer/shared-types';

import {
  applyMissionTransition,
  createMissionProgress,
  requireMissionTransition,
  type MissionStatePolicy,
} from '../../src/mission-state/index.ts';

const MISSION: MissionInstanceId = toId('mission-1');
const AT = '2026-09-17T09:00:00.000Z';

const twoTries: MissionStatePolicy = { maxAttempts: 2, allowSkip: false };
const oneTry: MissionStatePolicy = { maxAttempts: 1, allowSkip: false };
const unlimited: MissionStatePolicy = { maxAttempts: null, allowSkip: false };

/** Walks a mission through a list of triggers, insisting each one works. */
function walk(
  from: MissionProgress,
  triggers: readonly string[],
  policy: MissionStatePolicy,
): MissionProgress {
  let progress = from;
  for (const trigger of triggers) {
    progress = requireMissionTransition(
      progress,
      { trigger, actor: 'engine', at: AT },
      policy,
    );
  }
  return progress;
}

describe('counting tries', () => {
  const available = createMissionProgress(MISSION, { state: 'available' });

  it('starts at none used', () => {
    assert.equal(available.attemptsUsed, 0);
  });

  it('counts one the moment the mission is opened, not when it is judged', () => {
    const open = walk(available, ['start'], unlimited);
    assert.equal(open.attemptsUsed, 1);
    assert.equal(walk(open, ['submit'], unlimited).attemptsUsed, 1);
  });

  it('counts a try the team let the clock run out on', () => {
    const expired = walk(available, ['start', 'expire'], unlimited);
    assert.equal(expired.attemptsUsed, 1);
    assert.equal(expired.state, 'failed');
  });

  it('numbers each line of the history by the try it was about', () => {
    const second = walk(
      available,
      ['start', 'submit', 'reject', 'start', 'submit', 'accept'],
      twoTries,
    );
    assert.deepEqual(
      second.log.map((entry) => [entry.trigger, entry.attemptNumber] as const),
      [
        ['start', 1],
        ['submit', 1],
        ['reject', 1],
        ['start', 2],
        ['submit', 2],
        ['accept', 2],
      ],
    );
  });
});

describe('a wrong answer with a try left', () => {
  it('hands the mission back to be tried again', () => {
    const rejected = walk(
      createMissionProgress(MISSION, { state: 'available' }),
      ['start', 'submit', 'reject'],
      twoTries,
    );
    assert.equal(rejected.state, 'available');
    assert.equal(rejected.attemptsUsed, 1);
  });

  it('does the same when a teacher is the one rejecting it', () => {
    const overruled = walk(
      createMissionProgress(MISSION, { state: 'available' }),
      ['start', 'submit', 'refer', 'overrule'],
      twoTries,
    );
    assert.equal(overruled.state, 'available');
  });
});

describe('a wrong answer on the last try', () => {
  it('ends the mission instead of offering a start nothing would allow', () => {
    const failed = walk(
      createMissionProgress(MISSION, { state: 'available' }),
      ['start', 'submit', 'reject'],
      oneTry,
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.log.at(-1)?.to, 'failed');
  });

  it('ends it the same way when the teacher rejects it', () => {
    const failed = walk(
      createMissionProgress(MISSION, { state: 'available' }),
      ['start', 'submit', 'refer', 'overrule'],
      oneTry,
    );
    assert.equal(failed.state, 'failed');
  });

  it('never ends it when there is no limit at all', () => {
    let progress = createMissionProgress(MISSION, { state: 'available' });
    for (let round = 0; round < 20; round += 1) {
      progress = walk(progress, ['start', 'submit', 'reject'], unlimited);
    }
    assert.equal(progress.state, 'available');
    assert.equal(progress.attemptsUsed, 20);
  });
});

describe('opening one try too many', () => {
  it('is refused, and says how many the team had', () => {
    const used = walk(
      createMissionProgress(MISSION, { state: 'available' }),
      ['start', 'submit', 'reject'],
      twoTries,
    );
    const second = walk(used, ['start', 'submit', 'reject'], twoTries);
    assert.equal(second.state, 'failed');

    // The mission is finished, so the refusal is about that rather than the
    // count. The count is what a mission left `available` by a hand-written
    // record would hit, which is why the machine checks both.
    const stuck = applyMissionTransition(
      { ...second, state: 'available' },
      { trigger: 'start', actor: 'team', at: AT },
      twoTries,
    );
    assert.equal(stuck.applied, false);
    assert.equal(stuck.applied === false && stuck.refusal.code, 'no-attempts-left');
    assert.ok(stuck.applied === false && stuck.refusal.message.includes('2'));
  });
});
