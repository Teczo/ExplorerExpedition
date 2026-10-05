/**
 * The communication challenge mission type (EXPD-038), through the registry
 * that holds it, and the rule that deals its parts out.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMissionTypeRegistry, type MissionEvaluation } from '@explorer/engine';
import {
  validateAuthoredMissionType,
  validateMissionTypeDefinition,
  type JsonObject,
} from '@explorer/shared-types';

import {
  COMMUNICATION_CHALLENGE_AUTHORING,
  COMMUNICATION_CHALLENGE_KEY,
  COMMUNICATION_CHALLENGE_VERSION,
  PLATFORM_MISSION_TYPES,
  communicationChallenge,
  partsForSeat,
  prepareCommunicationChallenge,
  type CommunicationSeat,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([communicationChallenge]);
const KEY = COMMUNICATION_CHALLENGE_KEY;
const VERSION = COMMUNICATION_CHALLENGE_VERSION;

/** Each player holds one fragment of where the hiker is. */
const RADIO_RESCUE = {
  pattern: 'radio-rescue',
  parts: [
    { heading: 'Bearing', text: 'Due north of the bandstand.' },
    { heading: 'Landmark', text: 'Beside the tallest oak.' },
    { heading: 'Call sign', text: 'The hiker answers to KESTREL.' },
  ],
  answerType: 'text',
  acceptedAnswers: ['The tallest oak', 'oak'],
};

/** The navigator sees the route; the rover walks it blind. */
const BLIND_ROVER = {
  pattern: 'blind-rover',
  parts: [
    { heading: 'The route', text: 'Ten paces, left at the bench, five paces.', role: 'navigator' },
  ],
  answerType: 'text',
  acceptedAnswers: ['HERON'],
};

/** The first runner sees the colours for ten seconds and passes them on. */
const MEMORY_RELAY = {
  pattern: 'memory-relay',
  parts: [{ heading: 'Remember this', text: 'Red, blue, blue, green.', showForSeconds: 10 }],
  answerType: 'sequence',
  correctSequence: ['red', 'blue', 'blue', 'green'],
};

function judge(config: JsonObject, submission: JsonObject): MissionEvaluation {
  assert.equal(registry.validateConfig(KEY, VERSION, config).valid, true);
  assert.equal(registry.validateSubmission(KEY, VERSION, submission).valid, true);
  const behaviour = registry.behaviourFor(KEY, VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({
    config,
    prepared: registry.prepareConfig(KEY, VERSION, config),
    submission,
    attemptNumber: 1,
  });
}

/** The headings one seat is dealt. */
function dealt(config: JsonObject, seats: readonly CommunicationSeat[], memberId: string): string[] {
  return partsForSeat(prepareCommunicationChallenge(config).parts, seats, memberId).map(
    (part) => part.heading,
  );
}

const seat = (memberId: string, role: string | null = null): CommunicationSeat => ({
  memberId,
  role,
});

describe('the communication challenge as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(communicationChallenge.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({
        ...communicationChallenge.definition,
        ...COMMUNICATION_CHALLENGE_AUTHORING,
      }).valid,
      true,
    );
  });

  test('asks a phone for nothing, and is shipped as code', () => {
    assert.deepEqual(communicationChallenge.definition.capabilities, []);
    assert.ok(PLATFORM_MISSION_TYPES.includes(communicationChallenge));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(KEY, VERSION, communicationChallenge.definition.defaultConfig).valid,
      true,
    );
  });

  test('places no config field, so no phone is shown every part or the answer', () => {
    assert.equal(
      COMMUNICATION_CHALLENGE_AUTHORING.studentLayout.blocks.some(
        (block) => block.kind === 'config-field',
      ),
      false,
    );
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) => registry.validateConfig(KEY, VERSION, config);

  test('covers the three patterns, and nothing else', () => {
    assert.equal(check(RADIO_RESCUE).valid, true);
    assert.equal(check(BLIND_ROVER).valid, true);
    assert.equal(check(MEMORY_RELAY).valid, true);
    assert.equal(check({ ...RADIO_RESCUE, pattern: 'telephone' }).valid, false);
  });

  test('has to split something, and say how it is answered', () => {
    assert.equal(check({ ...RADIO_RESCUE, parts: [] }).valid, false);
    const { answerType: _, ...noAnswerType } = RADIO_RESCUE;
    assert.equal(check(noAnswerType).valid, false);
    assert.equal(check({ ...RADIO_RESCUE, answerType: 'choice' }).valid, false);
  });

  test('gives every part a heading and some text, and nothing else', () => {
    assert.equal(check({ ...RADIO_RESCUE, parts: [{ heading: 'A' }] }).valid, false);
    assert.equal(check({ ...RADIO_RESCUE, parts: [{ heading: 'A', text: '  ' }] }).valid, false);
    assert.equal(
      check({ ...RADIO_RESCUE, parts: [{ heading: 'A', text: 'B', answer: 'C' }] }).valid,
      false,
    );
  });

  test('shows a part for whole seconds, at least one', () => {
    const part = (showForSeconds: number) => ({
      ...MEMORY_RELAY,
      parts: [{ heading: 'A', text: 'B', showForSeconds }],
    });
    assert.equal(check(part(0)).valid, false);
    assert.equal(check(part(2.5)).valid, false);
  });
});

describe('who is dealt which part', () => {
  const three = [seat('asha'), seat('ben'), seat('cal')];

  test('one each, in the order the team joined', () => {
    assert.deepEqual(dealt(RADIO_RESCUE, three, 'asha'), ['Bearing']);
    assert.deepEqual(dealt(RADIO_RESCUE, three, 'ben'), ['Landmark']);
    assert.deepEqual(dealt(RADIO_RESCUE, three, 'cal'), ['Call sign']);
  });

  test('round again when there are more parts than players, so none is lost', () => {
    const two = [seat('asha'), seat('ben')];
    assert.deepEqual(dealt(RADIO_RESCUE, two, 'asha'), ['Bearing', 'Call sign']);
    assert.deepEqual(dealt(RADIO_RESCUE, two, 'ben'), ['Landmark']);
    assert.deepEqual(dealt(RADIO_RESCUE, [seat('solo')], 'solo'), [
      'Bearing',
      'Landmark',
      'Call sign',
    ]);
  });

  test('nothing for a player when there are more players than parts', () => {
    assert.deepEqual(dealt(MEMORY_RELAY, three, 'asha'), ['Remember this']);
    assert.deepEqual(dealt(MEMORY_RELAY, three, 'cal'), []);
  });

  test('a part for a role goes to whoever holds it, and the rover sees nothing', () => {
    const team = [seat('asha'), seat('ben', 'navigator')];
    assert.deepEqual(dealt(BLIND_ROVER, team, 'ben'), ['The route']);
    assert.deepEqual(dealt(BLIND_ROVER, team, 'asha'), []);
  });

  test('a part for a role nobody holds is dealt instead of lost', () => {
    assert.deepEqual(dealt(BLIND_ROVER, [seat('asha'), seat('ben')], 'asha'), ['The route']);
  });

  test('parts with no role go to the players who got none for their role', () => {
    const mixed: JsonObject = {
      ...RADIO_RESCUE,
      parts: [
        { heading: 'Map', text: 'The map.', role: 'navigator' },
        { heading: 'Clue one', text: 'One.' },
        { heading: 'Clue two', text: 'Two.' },
      ],
    };
    const team = [seat('asha', 'navigator'), seat('ben'), seat('cal')];
    assert.deepEqual(dealt(mixed, team, 'asha'), ['Map']);
    assert.deepEqual(dealt(mixed, team, 'ben'), ['Clue one']);
    assert.deepEqual(dealt(mixed, team, 'cal'), ['Clue two']);
  });

  test('nothing for somebody not on the team', () => {
    assert.deepEqual(dealt(RADIO_RESCUE, three, 'stranger'), []);
  });
});

describe('a text answer', () => {
  test('is right when it matches, whatever the case and spacing', () => {
    for (const answer of ['oak', '  The   TALLEST oak ']) {
      assert.equal(judge(RADIO_RESCUE, { answer }).outcome, 'correct');
    }
  });

  test('is wrong otherwise, and never says the answer', () => {
    const verdict = judge(RADIO_RESCUE, { answer: 'the bench' });
    assert.equal(verdict.outcome, 'incorrect');
    assert.doesNotMatch(JSON.stringify(verdict), /oak/i);
  });

  test('asks for an answer when there is none', () => {
    assert.equal(judge(RADIO_RESCUE, {}).feedback, 'Hand in the answer your team put together.');
  });

  test('goes to a teacher when the author left no answer', () => {
    const { acceptedAnswers: _, ...open } = RADIO_RESCUE;
    assert.equal(judge(open, { answer: 'oak' }).outcome, 'needs-review');
  });
});

describe('a sequence', () => {
  test('is right when every item is in place', () => {
    const verdict = judge(MEMORY_RELAY, { sequence: ['Red', ' blue', 'BLUE', 'green'] });
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.progress, 1);
  });

  test('says how many are in place when it is not', () => {
    const verdict = judge(MEMORY_RELAY, { sequence: ['red', 'blue', 'green', 'green'] });
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.progress, 0.75);
    assert.equal(verdict.feedback, '3 of 4 in the right place.');
  });

  test('is not right with an item too many', () => {
    const verdict = judge(MEMORY_RELAY, { sequence: ['red', 'blue', 'blue', 'green', 'red'] });
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.progress, 0.8);
  });

  test('keeps what was sent, and never the answer', () => {
    const verdict = judge(MEMORY_RELAY, { sequence: ['red'] });
    assert.deepEqual(verdict.detail, { pattern: 'memory-relay', sequence: ['red'] });
  });
});
