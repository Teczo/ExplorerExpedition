/**
 * That a final result can be rebuilt from the record and nothing else.
 *
 * The other half of the ticket. A team told they finished on 340 should be
 * able to take the lines away, add them up themselves, and get 340 — without
 * the expedition document, without the session, without the rules and
 * without anybody's word for it. What is tested here is that the reading
 * really does depend on nothing but the stream, and that it stops where the
 * stream stops rather than guessing at what it does not hold.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTeamScore } from '../../src/scoring/index.ts';
import {
  appendScoreEvents,
  openStream,
  progressionLine,
  replayStream,
  replayTeamScore,
  scoreEventsOf,
  scoreLine,
  sealStream,
  streamLinesForMission,
} from '../../src/stream/index.ts';
import { at, missionId, nodeId, progressed, scored } from './support.ts';

const alpha = missionId('alpha');
const beta = missionId('beta');

/** An afternoon: two missions, a bonus, a hint, a wrong answer, a finish. */
function afternoon() {
  return sealStream([
    progressionLine(progressed('node-reached', { nodeId: nodeId('start'), at: at(0) })),
    progressionLine(progressed('node-cleared', { nodeId: nodeId('start'), at: at(0) })),
    progressionLine(
      progressed('mission-unlocked', { nodeId: nodeId('one'), missionInstanceId: alpha, at: at(0) }),
    ),
    scoreLine(scored('hint-penalty', -20, { missionInstanceId: alpha, at: at(40) })),
    scoreLine(scored('mission-complete', 100, { missionInstanceId: alpha, at: at(60) })),
    scoreLine(scored('speed-bonus', 25, { missionInstanceId: alpha, at: at(60) })),
    progressionLine(
      progressed('mission-revealed', { nodeId: nodeId('two'), missionInstanceId: beta, at: at(60) }),
    ),
    progressionLine(
      progressed('mission-unlocked', { nodeId: nodeId('two'), missionInstanceId: beta, at: at(60) }),
    ),
    scoreLine(scored('attempt-penalty', -15, { missionInstanceId: beta, at: at(90) })),
    scoreLine(scored('partial-credit', 40, { missionInstanceId: beta, at: at(120) })),
    progressionLine(progressed('expedition-finished', { nodeId: nodeId('finish'), at: at(130) })),
  ]);
}

describe('reading a stream back', () => {
  it('lands on the total the lines add up to', () => {
    const result = replayStream(afternoon());
    assert.equal(result.total, -20 + 100 + 25 - 15 + 40);
  });

  it('says where the total came from, reason by reason', () => {
    const result = replayStream(afternoon());
    assert.deepEqual(result.pointsByReason, {
      'hint-penalty': -20,
      'mission-complete': 100,
      'speed-bonus': 25,
      'attempt-penalty': -15,
      'partial-credit': 40,
    });
  });

  it('leaves out a reason no line carried, rather than writing nought', () => {
    const result = replayStream(afternoon());
    assert.equal('manual-adjustment' in result.pointsByReason, false);
  });

  it('says what each mission came to, which is the argument a class has', () => {
    const result = replayStream(afternoon());
    assert.deepEqual(
      result.missions.map((each) => [each.missionInstanceId, each.points, each.lines]),
      [
        [alpha, 105, 3],
        [beta, 25, 2],
      ],
    );
  });

  it('lists the missions in the order the stream first named them', () => {
    const result = replayStream(afternoon());
    assert.deepEqual(result.missions.map((each) => each.missionInstanceId), [alpha, beta]);
  });

  it('says which doors opened, and in what order', () => {
    const result = replayStream(afternoon());
    assert.deepEqual(result.reachedNodeIds, [nodeId('start'), nodeId('finish')]);
    assert.deepEqual(result.clearedNodeIds, [nodeId('start')]);
    assert.deepEqual(result.unlockedMissionIds, [alpha, beta]);
    assert.deepEqual(result.revealedMissionIds, [beta]);
  });

  it('says the team finished, and when', () => {
    const result = replayStream(afternoon());
    assert.equal(result.finished, true);
    assert.equal(result.finishedAt, at(130));
  });

  it('says when the run started and when it ended', () => {
    const result = replayStream(afternoon());
    assert.equal(result.startedAt, at(0));
    assert.equal(result.endedAt, at(130));
    assert.equal(result.lines, 11);
  });

  it('reads an empty stream as a team that did nothing', () => {
    const result = replayStream(openStream());
    assert.equal(result.total, 0);
    assert.equal(result.finished, false);
    assert.equal(result.lines, 0);
    assert.deepEqual(result.missions, []);
    assert.equal(result.startedAt, undefined);
  });

  it('gives the same answer every time it is asked', () => {
    assert.deepEqual(replayStream(afternoon()), replayStream(afternoon()));
  });

  it('counts a mission a progression line named but no score line did', () => {
    const stream = sealStream([
      progressionLine(progressed('mission-unlocked', { missionInstanceId: alpha })),
    ]);
    const [mission] = replayStream(stream).missions;
    assert.equal(mission?.missionInstanceId, alpha);
    assert.equal(mission?.points, 0);
    assert.equal(mission?.lines, 0);
    assert.equal(mission?.unlocked, true);
  });
});

describe('rebuilding a team from their stream', () => {
  it('gives back a record whose total is the sum of the stream', () => {
    const stream = afternoon();
    const score = replayTeamScore(stream);
    assert.equal(score.total, replayStream(stream).total);
    assert.deepEqual(score.events, scoreEventsOf(stream));
  });

  it('starts the three counts the stream never held at nought', () => {
    const score = replayTeamScore(afternoon());
    assert.equal(score.streak, 0);
    assert.equal(score.failedAttempts, 0);
    assert.deepEqual(score.spentHintIds, []);
  });

  it('is the same record createTeamScore builds from the same events', () => {
    const stream = afternoon();
    assert.deepEqual(replayTeamScore(stream), createTeamScore(scoreEventsOf(stream)));
  });

  it('takes a score change straight off the scoring engine', () => {
    // What EXPD-020 will do: score, then append what came back.
    const events = [scored('mission-complete', 100, { missionInstanceId: alpha })];
    const stream = appendScoreEvents(openStream(), events);
    assert.equal(replayTeamScore(stream).total, 100);
  });
});

describe('answering an argument about one mission', () => {
  it('hands back every line that named it, in order', () => {
    const lines = streamLinesForMission(afternoon(), alpha);
    assert.deepEqual(
      lines.map((entry) => [entry.kind, entry.sequence]),
      [
        ['progression', 3],
        ['score', 4],
        ['score', 5],
        ['score', 6],
      ],
    );
  });

  it('hands back nothing for a mission the stream never named', () => {
    assert.deepEqual(streamLinesForMission(afternoon(), missionId('gamma')), []);
  });
});
