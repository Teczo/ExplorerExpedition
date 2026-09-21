/**
 * That the doors that opened are written down as they open.
 *
 * A snapshot is worked out again from scratch every time, so nothing about
 * one says when the lock came off a mission. These are the lines that make
 * that answerable a fortnight later, and what is tested is that they are
 * written for every door that opened, once each, in the order a person would
 * tell the story — and not written for a door that closed again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { progressionEventsBetween } from '../../src/stream/index.ts';
import { at, mission, missionId, node, nodeId, snapshot } from './support.ts';

describe('what changed between two snapshots', () => {
  it('writes nothing when nothing changed', () => {
    const now = snapshot([node('start', { reached: true, cleared: true })], []);
    assert.deepEqual(progressionEventsBetween(now, now, at(0)), []);
  });

  it('writes a line for a stop the team has just got to', () => {
    const before = snapshot([node('one')], []);
    const after = snapshot([node('one', { reached: true })], []);
    assert.deepEqual(progressionEventsBetween(before, after, at(10)), [
      { reason: 'node-reached', at: at(10), nodeId: nodeId('one') },
    ]);
  });

  it('writes reaching a stop before clearing it', () => {
    const before = snapshot([node('one')], []);
    const after = snapshot([node('one', { reached: true, cleared: true })], []);
    assert.deepEqual(
      progressionEventsBetween(before, after, at(10)).map((event) => event.reason),
      ['node-reached', 'node-cleared'],
    );
  });

  it('shows a mission before it unlocks it', () => {
    const before = snapshot([], [mission('alpha', { secret: true, visible: false })]);
    const after = snapshot([], [mission('alpha', { secret: true, visible: true, unlocked: true })]);
    assert.deepEqual(
      progressionEventsBetween(before, after, at(10)).map((event) => event.reason),
      ['mission-revealed', 'mission-unlocked'],
    );
  });

  it('puts the stop that holds a mission on that mission\'s own lines', () => {
    const before = snapshot([], [mission('alpha')]);
    const after = snapshot([], [mission('alpha', { unlocked: true })]);
    const [event] = progressionEventsBetween(before, after, at(10));
    assert.equal(event?.nodeId, nodeId('alpha-stop'));
    assert.equal(event?.missionInstanceId, missionId('alpha'));
  });

  it('writes finishing the expedition last', () => {
    const before = snapshot([node('finish', { kind: 'finish' })], []);
    const after = snapshot([node('finish', { kind: 'finish', reached: true, cleared: true })], [], {
      reachedFinishNodeIds: [nodeId('finish')],
      finished: true,
    });
    assert.deepEqual(
      progressionEventsBetween(before, after, at(10)).map((event) => event.reason),
      ['node-reached', 'node-cleared', 'expedition-finished'],
    );
  });

  it('names the finish the team reached', () => {
    const before = snapshot([], []);
    const after = snapshot([], [], {
      reachedFinishNodeIds: [nodeId('finish')],
      finished: true,
    });
    assert.deepEqual(progressionEventsBetween(before, after, at(10)), [
      { reason: 'expedition-finished', at: at(10), nodeId: nodeId('finish') },
    ]);
  });

  it('writes each door once, however many times it is looked at', () => {
    const before = snapshot([node('one')], []);
    const after = snapshot([node('one', { reached: true })], []);
    assert.equal(progressionEventsBetween(before, after, at(10)).length, 1);
    assert.equal(progressionEventsBetween(after, after, at(20)).length, 0);
  });

  it('writes nothing for a door that closed again', () => {
    // `strict` puts the lock back on when it is another mission's turn. What
    // a team was let do is the record; letting it lapse is not.
    const before = snapshot([], [mission('alpha', { unlocked: true })]);
    const after = snapshot([], [mission('alpha', { unlocked: false })]);
    assert.deepEqual(progressionEventsBetween(before, after, at(10)), []);
  });

  it('reads a team with no snapshot yet as a team that had got nowhere', () => {
    const after = snapshot(
      [node('start', { kind: 'start', reached: true, cleared: true })],
      [mission('alpha', { unlocked: true })],
    );
    assert.deepEqual(
      progressionEventsBetween(undefined, after, at(0)).map((event) => event.reason),
      ['node-reached', 'node-cleared', 'mission-revealed', 'mission-unlocked'],
    );
  });

  it('lists stops and missions in the order the document does', () => {
    const before = snapshot([node('one'), node('two')], [mission('alpha'), mission('beta')]);
    const after = snapshot(
      [node('one', { reached: true }), node('two', { reached: true })],
      [mission('alpha', { unlocked: true }), mission('beta', { unlocked: true })],
    );
    assert.deepEqual(
      progressionEventsBetween(before, after, at(10)).map(
        (event) => event.nodeId ?? event.missionInstanceId,
      ),
      [nodeId('one'), nodeId('two'), nodeId('alpha-stop'), nodeId('beta-stop')],
    );
  });

  it('ignores a stop the later snapshot no longer holds', () => {
    // A document edited between two evaluations. The record says what opened,
    // and a stop nobody can reach any more never opened.
    const before = snapshot([node('one', { reached: true })], []);
    const after = snapshot([], []);
    assert.deepEqual(progressionEventsBetween(before, after, at(10)), []);
  });
});
