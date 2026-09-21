/**
 * That the record cannot be changed without saying so.
 *
 * This is the promise the ticket rests on. A stream is only worth handing to
 * somebody who disagrees with a result if editing it, reordering it, removing
 * a line from it or slipping one into it all show up — and show up as a
 * finding that names the line, rather than as "invalid".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GENESIS_HASH, type StreamEntry } from '@explorer/shared-types';

import {
  appendProgressionEvents,
  appendScoreEvents,
  appendToStream,
  openStream,
  progressionLine,
  scoreLine,
  sealStream,
  verifyStream,
} from '../../src/stream/index.ts';
import { at, missionId, nodeId, progressed, scored } from './support.ts';

/** A short run: a mission opened, finished, and paid a bonus on.  */
function runOfThree(): readonly StreamEntry[] {
  return sealStream([
    progressionLine(progressed('mission-unlocked', { missionInstanceId: missionId('alpha') })),
    scoreLine(scored('mission-complete', 100, { missionInstanceId: missionId('alpha'), at: at(30) })),
    scoreLine(scored('speed-bonus', 25, { missionInstanceId: missionId('alpha'), at: at(30) })),
  ]);
}

describe('numbering a stream', () => {
  it('starts at one and never skips', () => {
    const stream = runOfThree();
    assert.deepEqual(stream.map((entry) => entry.sequence), [1, 2, 3]);
  });

  it('seals the first line against the fixed opening value', () => {
    const [first] = runOfThree();
    assert.equal(first?.previousHash, GENESIS_HASH);
  });

  it('gives every line the seal of the one before it', () => {
    const stream = runOfThree();
    assert.equal(stream[1]?.previousHash, stream[0]?.hash);
    assert.equal(stream[2]?.previousHash, stream[1]?.hash);
  });

  it('carries on the numbering when more is appended later', () => {
    const later = appendScoreEvents(runOfThree(), [scored('hint-penalty', -20)]);
    assert.deepEqual(later.map((entry) => entry.sequence), [1, 2, 3, 4]);
    assert.equal(later[3]?.previousHash, later[2]?.hash);
  });

  it('gives the same stream whether lines are added together or one by one', () => {
    const events = [
      scoreLine(scored('mission-complete', 100)),
      scoreLine(scored('speed-bonus', 25)),
      progressionLine(progressed('node-cleared', { nodeId: nodeId('one') })),
    ];
    const together = appendToStream(openStream(), ...events);
    let apart = openStream();
    for (const event of events) {
      apart = appendToStream(apart, event);
    }
    assert.deepEqual(apart, together);
  });

  it('leaves the stream it was given alone', () => {
    const before = runOfThree();
    const copy = [...before];
    appendScoreEvents(before, [scored('attempt-penalty', -15)]);
    assert.deepEqual(before, copy);
  });

  it('seals the same lines the same way every time', () => {
    assert.deepEqual(runOfThree(), runOfThree());
  });
});

describe('checking a stream', () => {
  it('passes a stream nobody has touched', () => {
    const check = verifyStream(runOfThree());
    assert.equal(check.intact, true);
    assert.deepEqual(check.defects, []);
    assert.equal(check.checked, 3);
    assert.equal(check.total, 125);
  });

  it('passes an empty stream, and calls it the opening seal', () => {
    const check = verifyStream(openStream());
    assert.equal(check.intact, true);
    assert.equal(check.total, 0);
    assert.equal(check.headHash, GENESIS_HASH);
  });

  it('names the line somebody edited, and only that line', () => {
    const stream = [...runOfThree()];
    const line = stream[1];
    assert.ok(line !== undefined && line.kind === 'score');
    // The change somebody covering a wrong total would actually make.
    stream[1] = { ...line, event: { ...line.event, points: 500 } };

    const check = verifyStream(stream);
    assert.equal(check.intact, false);
    assert.deepEqual(
      check.defects.map((defect) => [defect.code, defect.sequence]),
      [['edited', 2]],
    );
  });

  it('notices a line taken out of the middle', () => {
    const stream = runOfThree();
    const check = verifyStream([stream[0], stream[2]].filter(isEntry));
    assert.equal(check.intact, false);
    assert.deepEqual(
      check.defects.map((defect) => defect.code).sort(),
      ['broken-chain', 'out-of-order'],
    );
    assert.equal(check.defects[0]?.sequence, 3);
  });

  it('notices a line slipped in', () => {
    const stream = runOfThree();
    const slipped = [
      stream[0],
      ...sealStream([scoreLine(scored('manual-adjustment', 999, { note: 'oops' }))]),
      stream[1],
      stream[2],
    ].filter(isEntry);

    const check = verifyStream(slipped);
    assert.equal(check.intact, false);
    assert.ok(check.defects.some((defect) => defect.code === 'broken-chain'));
  });

  it('notices two lines swapped round', () => {
    const stream = runOfThree();
    const swapped = [stream[0], stream[2], stream[1]].filter(isEntry);
    const check = verifyStream(swapped);
    assert.equal(check.intact, false);
    assert.ok(check.defects.some((defect) => defect.code === 'out-of-order'));
    assert.ok(check.defects.some((defect) => defect.code === 'broken-chain'));
  });

  it('notices a whole stream resealed from a different opening', () => {
    // Every seal inside is consistent; what gives it away is where it starts.
    const forged = runOfThree().map((entry) => ({ ...entry, sequence: entry.sequence + 10 }));
    const check = verifyStream(forged);
    assert.equal(check.intact, false);
    assert.ok(check.defects.some((defect) => defect.code === 'out-of-order'));
    assert.ok(check.defects.some((defect) => defect.code === 'edited'));
  });

  it('says so when a total somebody is claiming is not the stream', () => {
    const check = verifyStream(runOfThree(), { expectedTotal: 340 });
    assert.equal(check.intact, false);
    const defect = check.defects.at(0);
    assert.equal(defect?.code, 'total-disagrees');
    assert.equal(defect?.expected, '125');
    assert.equal(defect?.found, '340');
  });

  it('agrees with a total that is the stream', () => {
    assert.equal(verifyStream(runOfThree(), { expectedTotal: 125 }).intact, true);
  });

  it('checks one page of a long stream on its own', () => {
    const whole = appendProgressionEvents(runOfThree(), [
      progressed('expedition-finished', { nodeId: nodeId('finish'), at: at(90) }),
    ]);
    const page = whole.slice(2);
    const before = whole[1];
    assert.ok(before !== undefined);

    const check = verifyStream(page, {
      startingFrom: { sequence: before.sequence, hash: before.hash },
    });
    assert.equal(check.intact, true);
    assert.equal(check.checked, 2);
  });

  it('refuses a page that does not follow where it says it does', () => {
    const whole = runOfThree();
    const check = verifyStream(whole.slice(2), {
      startingFrom: { sequence: 1, hash: whole[0]?.hash ?? GENESIS_HASH },
    });
    assert.equal(check.intact, false);
    assert.ok(check.defects.some((defect) => defect.code === 'out-of-order'));
  });

  it('hands back the seal on the last line, which stands for the whole stream', () => {
    const stream = runOfThree();
    assert.equal(verifyStream(stream).headHash, stream.at(-1)?.hash);
  });
});

/** Narrows away the `undefined` that indexing a list can hand back. */
function isEntry(entry: StreamEntry | undefined): entry is StreamEntry {
  return entry !== undefined;
}
