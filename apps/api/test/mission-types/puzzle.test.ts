/**
 * The puzzle mission type (EXPD-035), through the registry that holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each answer is judged against it.
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
  PLATFORM_MISSION_TYPES,
  PUZZLE_AUTHORING,
  PUZZLE_KEY,
  PUZZLE_VERSION,
  puzzle,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([puzzle]);

const PADLOCK = {
  kind: 'code',
  question: 'The poem hides four digits. Open the padlock.',
  answerType: 'text',
  acceptedAnswers: ['4719'],
  ignoreSpaces: true,
};

const RIDDLE = {
  kind: 'logic',
  question: 'What has keys but cannot open locks?',
  answerType: 'text',
  acceptedAnswers: ['A piano', 'piano'],
};

const NEXT = {
  kind: 'pattern',
  question: '2, 6, 18, … what comes next?',
  answerType: 'number',
  acceptedAnswers: ['54'],
};

const LIAR = {
  kind: 'logic',
  question: 'Two of them are telling the truth. Who is lying?',
  answerType: 'choice',
  choices: [
    { id: 'ada', label: 'Ada' },
    { id: 'ben', label: 'Ben' },
    { id: 'cat', label: 'Cat' },
  ],
  correctChoices: ['ben'],
};

const LOCKS = {
  kind: 'sequence',
  question: 'Put the locks in the order they were built.',
  answerType: 'order',
  choices: [
    { id: 'mill', label: 'Mill lock' },
    { id: 'abbey', label: 'Abbey lock' },
    { id: 'weir', label: 'Weir lock' },
    { id: 'town', label: 'Town lock' },
  ],
  correctOrder: ['abbey', 'mill', 'town', 'weir'],
};

/** Checks both halves the way the API does, then judges one answer. */
function judge(config: JsonObject, submission: JsonObject): MissionEvaluation {
  assert.equal(registry.validateConfig(PUZZLE_KEY, PUZZLE_VERSION, config).valid, true);
  assert.equal(registry.validateSubmission(PUZZLE_KEY, PUZZLE_VERSION, submission).valid, true);
  const prepared = registry.prepareConfig(PUZZLE_KEY, PUZZLE_VERSION, config);
  const behaviour = registry.behaviourFor(PUZZLE_KEY, PUZZLE_VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({ config, prepared, submission, attemptNumber: 1 });
}

describe('the puzzle as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(puzzle.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({ ...puzzle.definition, ...PUZZLE_AUTHORING }).valid,
      true,
    );
  });

  test('asks a phone for nothing', () => {
    assert.deepEqual(puzzle.definition.capabilities, []);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(puzzle));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(PUZZLE_KEY, PUZZLE_VERSION, puzzle.definition.defaultConfig).valid,
      true,
    );
  });

  test('shows the team the question and the choices, and never the answer', () => {
    const fields = PUZZLE_AUTHORING.studentLayout.blocks.flatMap((block) =>
      block.kind === 'config-field' ? [block.field] : [],
    );
    assert.deepEqual(fields, ['question', 'choices']);
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) => registry.validateConfig(PUZZLE_KEY, PUZZLE_VERSION, config);

  test('has to say the kind, the question and how it is answered', () => {
    assert.equal(check(PADLOCK).valid, true);
    const { kind: _, ...noKind } = PADLOCK;
    assert.equal(check(noKind).valid, false);
    assert.equal(check({ kind: 'code', answerType: 'text' }).valid, false);
    assert.equal(check({ kind: 'code', question: 'Q?' }).valid, false);
  });

  test('picks a kind and an answer type from the lists, and nothing else', () => {
    for (const kind of ['logic', 'code', 'sequence', 'pattern']) {
      assert.equal(check({ ...PADLOCK, kind }).valid, true);
    }
    assert.equal(check({ ...PADLOCK, kind: 'riddle' }).valid, false);
    assert.equal(check({ ...PADLOCK, answerType: 'essay' }).valid, false);
  });

  test('may not write a blank question or a blank answer', () => {
    assert.equal(check({ ...PADLOCK, question: '  ' }).valid, false);
    assert.equal(check({ ...PADLOCK, acceptedAnswers: [' '] }).valid, false);
  });

  test('offers between two and twenty choices, each with an id and a label', () => {
    assert.equal(check(LIAR).valid, true);
    assert.equal(check({ ...LIAR, choices: [{ id: 'ada', label: 'Ada' }] }).valid, false);
    assert.equal(check({ ...LIAR, choices: [{ id: 'ada' }, { id: 'ben' }] }).valid, false);
  });

  test('may not list a correct choice twice, or a negative tolerance', () => {
    assert.equal(check({ ...LIAR, correctChoices: ['ben', 'ben'] }).valid, false);
    assert.equal(check({ ...NEXT, tolerance: -1 }).valid, false);
  });
});

describe('what a team may send', () => {
  const check = (submission: JsonObject) =>
    registry.validateSubmission(PUZZLE_KEY, PUZZLE_VERSION, submission);

  test('has to send something', () => {
    assert.equal(check({}).valid, false);
    assert.equal(check({ answer: '4719' }).valid, true);
    assert.equal(check({ selected: ['ben'] }).valid, true);
    assert.equal(check({ order: ['abbey', 'mill'] }).valid, true);
  });

  test('sends text, not anything else, and not too much of it', () => {
    assert.equal(check({ answer: 54 }).valid, false);
    assert.equal(check({ answer: 'x'.repeat(201) }).valid, false);
    assert.equal(check({ selected: ['ben', 'ben'] }).valid, false);
  });
});

describe('a typed answer', () => {
  test('is right when it matches one the author accepted, whatever its case', () => {
    assert.equal(judge(RIDDLE, { answer: 'a PIANO' }).outcome, 'correct');
    assert.equal(judge(RIDDLE, { answer: '  piano ' }).outcome, 'correct');
    assert.equal(judge(RIDDLE, { answer: 'A   piano' }).outcome, 'correct');
    assert.equal(judge(RIDDLE, { answer: 'An organ' }).outcome, 'incorrect');
  });

  test('says so, without saying the answer', () => {
    const right = judge(RIDDLE, { answer: 'piano' });
    assert.equal(right.feedback, 'Puzzle solved.');
    assert.equal(right.progress, 1);
    const wrong = judge(RIDDLE, { answer: 'organ' });
    assert.equal(wrong.feedback, 'Not quite. Try again.');
    assert.equal(wrong.progress, 0);
    assert.deepEqual(wrong.detail, { kind: 'logic', answerType: 'text', answer: 'organ' });
  });

  test('minds case when the author asked it to', () => {
    const exact = { ...RIDDLE, acceptedAnswers: ['Piano'], caseSensitive: true };
    assert.equal(judge(exact, { answer: 'Piano' }).outcome, 'correct');
    assert.equal(judge(exact, { answer: 'piano' }).outcome, 'incorrect');
  });

  test('drops every space when the author asked it to, for a code', () => {
    assert.equal(judge(PADLOCK, { answer: '47 19' }).outcome, 'correct');
    assert.equal(judge({ ...PADLOCK, ignoreSpaces: false }, { answer: '47 19' }).outcome, 'incorrect');
  });
});

describe('a number', () => {
  test('is right when it is the same number, however it is written', () => {
    for (const answer of ['54', '54.0', '054', ' +54 ']) {
      assert.equal(judge(NEXT, { answer }).outcome, 'correct', answer);
    }
    assert.equal(judge(NEXT, { answer: '55' }).outcome, 'incorrect');
  });

  test('is right within the tolerance the author gave', () => {
    const pi = { ...NEXT, acceptedAnswers: ['3.14159'], tolerance: 0.01 };
    assert.equal(judge(pi, { answer: '3.14' }).outcome, 'correct');
    assert.equal(judge(pi, { answer: '3.1' }).outcome, 'incorrect');
  });

  test('asks for a number when the team typed something else', () => {
    for (const answer of ['fifty-four', '0x36', '5,4']) {
      const evaluation = judge(NEXT, { answer });
      assert.equal(evaluation.outcome, 'incorrect');
      assert.equal(evaluation.feedback, 'Answer with a number.');
    }
  });
});

describe('a choice', () => {
  test('is right when exactly the correct ones are picked', () => {
    assert.equal(judge(LIAR, { selected: ['ben'] }).outcome, 'correct');
    assert.equal(judge(LIAR, { selected: ['ada'] }).outcome, 'incorrect');
    assert.equal(judge(LIAR, { selected: ['ben', 'ada'] }).outcome, 'incorrect');
  });

  test('needs every correct one when there are several', () => {
    const two = { ...LIAR, correctChoices: ['ada', 'cat'] };
    assert.equal(judge(two, { selected: ['cat', 'ada'] }).outcome, 'correct');
    assert.equal(judge(two, { selected: ['cat'] }).outcome, 'incorrect');
  });

  test('ignores a correct id that is not one of the choices', () => {
    const typo = { ...LIAR, correctChoices: ['ben', 'bne'] };
    assert.equal(judge(typo, { selected: ['ben'] }).outcome, 'correct');
  });
});

describe('an order', () => {
  test('is right when it is exactly the correct order', () => {
    const evaluation = judge(LOCKS, { order: ['abbey', 'mill', 'town', 'weir'] });
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.detail?.['inPlace'], 4);
  });

  test('says how many are in the right place, and counts that as progress', () => {
    const evaluation = judge(LOCKS, { order: ['abbey', 'mill', 'weir', 'town'] });
    assert.equal(evaluation.outcome, 'incorrect');
    assert.equal(evaluation.feedback, '2 of 4 in the right place.');
    assert.equal(evaluation.progress, 0.5);
  });

  test('is not right when it leaves one out or adds one', () => {
    assert.equal(judge(LOCKS, { order: ['abbey', 'mill', 'town'] }).outcome, 'incorrect');
    assert.equal(
      judge(LOCKS, { order: ['abbey', 'mill', 'town', 'weir', 'mill'] }).outcome,
      'incorrect',
    );
  });

  test('takes the choices as written when no correct order is given', () => {
    const { correctOrder: _, ...asWritten } = LOCKS;
    assert.equal(judge(asWritten, { order: ['mill', 'abbey', 'weir', 'town'] }).outcome, 'correct');
  });
});

describe('any puzzle', () => {
  test('asks for an answer when the team sent the wrong kind or an empty one', () => {
    const cases: [JsonObject, JsonObject][] = [
      [RIDDLE, { selected: ['ben'] }],
      [RIDDLE, { answer: '   ' }],
      [LIAR, { selected: [] }],
      [LOCKS, { answer: 'abbey' }],
    ];
    for (const [config, submission] of cases) {
      const evaluation = judge(config, submission);
      assert.equal(evaluation.outcome, 'incorrect');
      assert.equal(evaluation.feedback, 'Give your answer first.');
    }
  });

  test('goes to a teacher when the author left no answer code can judge', () => {
    const { acceptedAnswers: _, ...open } = RIDDLE;
    const evaluation = judge(open, { answer: 'a piano' });
    assert.equal(evaluation.outcome, 'needs-review');
    assert.equal(evaluation.feedback, 'Answer received. Your teacher will check it.');
    assert.equal(judge({ ...LIAR, correctChoices: ['zed'] }, { selected: ['ben'] }).outcome, 'needs-review');
  });

  test('gives the same answer twice', () => {
    assert.deepEqual(judge(LOCKS, { order: ['mill'] }), judge(LOCKS, { order: ['mill'] }));
  });
});
