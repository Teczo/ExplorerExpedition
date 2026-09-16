/**
 * Checking a mission's settings against its type's schema.
 *
 * This is the check EXPD-002 left out of the Expedition Definition validator
 * on purpose, so these tests are what make the note in that file true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  validateAgainstSchema,
  type ConfigSchema,
  type MissionConfigIssue,
} from '../../src/mission-type/index.ts';

function issuesOf(schema: ConfigSchema, value: unknown, path?: string): MissionConfigIssue[] {
  const result = validateAgainstSchema(schema, value, path === undefined ? {} : { path });
  assert.equal(result.valid, false, 'expected the value to be refused');
  return result.valid ? [] : result.issues;
}

function onlyIssue(schema: ConfigSchema, value: unknown, path?: string): MissionConfigIssue {
  const issues = issuesOf(schema, value, path);
  assert.equal(issues.length, 1, `expected one issue, got ${JSON.stringify(issues)}`);
  return issues[0] as MissionConfigIssue;
}

function accepts(schema: ConfigSchema, value: unknown): void {
  const result = validateAgainstSchema(schema, value);
  assert.equal(
    result.valid,
    true,
    `expected the value to pass, got ${JSON.stringify(result.valid ? [] : result.issues)}`,
  );
}

describe('the type of a value', () => {
  const cases: Array<[ConfigSchema['type'], unknown, unknown]> = [
    ['string', 'hello', 3],
    ['number', 1.5, 'no'],
    ['integer', 4, 4.5],
    ['boolean', true, 'true'],
    ['null', null, 0],
    ['object', {}, []],
    ['array', [], {}],
  ];

  for (const [type, good, bad] of cases) {
    it(`accepts ${type} and refuses what is not one`, () => {
      accepts({ type }, good);
      assert.equal(onlyIssue({ type }, bad).code, 'wrong-type');
    });
  }

  it('accepts a whole number where a number is wanted', () => {
    accepts({ type: 'number' }, 7);
  });

  it('says what it got, so the message is worth reading', () => {
    assert.match(onlyIssue({ type: 'string' }, []).message, /has to be string, but it is array/);
  });

  it('refuses a number JSON cannot carry', () => {
    assert.equal(onlyIssue({ type: 'number' }, Number.NaN).code, 'wrong-type');
    assert.equal(onlyIssue({ type: 'number' }, Number.POSITIVE_INFINITY).code, 'wrong-type');
  });

  it('accepts any type when the schema names none', () => {
    for (const value of ['a', 1, true, null, [], {}]) {
      accepts({}, value);
    }
  });
});

describe('the fields of an object', () => {
  const schema: ConfigSchema = {
    type: 'object',
    properties: {
      value: { type: 'string', minLength: 1 },
      points: { type: 'integer', minimum: 0 },
    },
    required: ['value'],
  };

  it('accepts an object with the required field', () => {
    accepts(schema, { value: 'gate' });
    accepts(schema, { value: 'gate', points: 5 });
  });

  it('reports a required field that is absent, at that field', () => {
    const issue = onlyIssue(schema, { points: 5 });
    assert.equal(issue.code, 'missing');
    assert.equal(issue.path, 'value');
  });

  it('refuses a field the mission type does not have', () => {
    const issue = onlyIssue(schema, { value: 'gate', pionts: 5 });
    assert.equal(issue.code, 'unknown-field');
    assert.equal(issue.path, 'pionts');
    assert.match(issue.message, /does not have a setting called "pionts"/);
  });

  it('allows unknown fields only when the schema asks for them', () => {
    accepts({ ...schema, additionalProperties: true }, { value: 'gate', extra: 1 });
  });

  it('checks the fields it does describe, at their own path', () => {
    const issue = onlyIssue(schema, { value: '' });
    assert.equal(issue.code, 'empty-string');
    assert.equal(issue.path, 'value');
  });

  it('treats a field set to undefined as absent, because JSON cannot carry it', () => {
    const issue = onlyIssue(schema, { value: undefined });
    assert.equal(issue.code, 'missing');
    assert.equal(issue.path, 'value');
  });

  it('checks nothing when the schema describes no fields', () => {
    accepts({ type: 'object' }, { anything: [1, 2, 3] });
  });

  it('counts the fields when asked to', () => {
    assert.equal(
      onlyIssue({ type: 'object', minProperties: 2 }, { a: 1 }).code,
      'too-short',
    );
    assert.equal(
      onlyIssue({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 }).code,
      'too-long',
    );
  });

  it('writes a field name that is not an identifier in brackets', () => {
    const issue = onlyIssue(
      { type: 'object', properties: { 'two words': { type: 'string' } }, required: ['two words'] },
      {},
    );
    assert.equal(issue.path, '["two words"]');
  });
});

describe('the entries of a list', () => {
  const schema: ConfigSchema = {
    type: 'array',
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: { type: 'string', pattern: '[A-Z]{3}' },
  };

  it('accepts a list within its bounds', () => {
    accepts(schema, ['ABC', 'DEF']);
  });

  it('refuses a list that is too short or too long', () => {
    assert.equal(onlyIssue(schema, []).code, 'too-short');
    assert.equal(onlyIssue(schema, ['ABC', 'DEF', 'GHI', 'JKL']).code, 'too-long');
  });

  it('refuses a repeated entry, and says which one it repeats', () => {
    const issue = onlyIssue(schema, ['ABC', 'ABC']);
    assert.equal(issue.code, 'duplicate-item');
    assert.equal(issue.path, '[1]');
    assert.match(issue.message, /same as entry 0/);
  });

  it('compares entries by content, so two equal objects are one', () => {
    const objects: ConfigSchema = { type: 'array', uniqueItems: true };
    assert.equal(onlyIssue(objects, [{ a: 1 }, { a: 1 }]).code, 'duplicate-item');
    accepts(objects, [{ a: 1 }, { a: 2 }]);
  });

  it('checks every entry, at its own index', () => {
    const issues = issuesOf(schema, ['ABC', 'de']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, 'pattern-mismatch');
    assert.equal(issues[0]?.path, '[1]');
  });
});

describe('strings', () => {
  it('counts length in code points, the way a person would', () => {
    // Four emoji are four characters to whoever typed them, and eight UTF-16
    // units to JavaScript. The author set the limit, so the author wins.
    accepts({ type: 'string', maxLength: 4 }, '🎒🧭🔦🎯');
    assert.equal(onlyIssue({ type: 'string', maxLength: 1 }, '🎒🧭').code, 'too-long');
  });

  it('calls an empty string empty rather than too short', () => {
    assert.equal(onlyIssue({ type: 'string', minLength: 1 }, '').code, 'empty-string');
    assert.equal(onlyIssue({ type: 'string', minLength: 3 }, 'ab').code, 'too-short');
  });

  it('matches a pattern against the whole string', () => {
    const schema: ConfigSchema = { type: 'string', pattern: '[a-z]+' };
    accepts(schema, 'abc');
    assert.equal(onlyIssue(schema, 'abc1').code, 'pattern-mismatch');
  });
});

describe('numbers', () => {
  it('holds a value inside its range, included and excluded', () => {
    accepts({ type: 'integer', minimum: 0, maximum: 10 }, 0);
    accepts({ type: 'integer', minimum: 0, maximum: 10 }, 10);
    assert.equal(onlyIssue({ type: 'integer', minimum: 1 }, 0).code, 'out-of-range');
    assert.equal(onlyIssue({ type: 'integer', maximum: 9 }, 10).code, 'out-of-range');
    assert.equal(onlyIssue({ type: 'number', exclusiveMinimum: 0 }, 0).code, 'out-of-range');
    assert.equal(onlyIssue({ type: 'number', exclusiveMaximum: 1 }, 1).code, 'out-of-range');
  });

  it('holds a value on the step it was given', () => {
    accepts({ type: 'number', multipleOf: 0.5 }, 2.5);
    assert.equal(onlyIssue({ type: 'number', multipleOf: 0.5 }, 2.3).code, 'not-a-multiple');
  });

  it('does not trip over binary floating point on a step of 0.1', () => {
    accepts({ type: 'number', multipleOf: 0.1 }, 0.3);
    accepts({ type: 'number', multipleOf: 0.1 }, 8.7);
  });
});

describe('a fixed or listed value', () => {
  it('accepts only the listed values', () => {
    const schema: ConfigSchema = { type: 'string', enum: ['any', 'in-order'] };
    accepts(schema, 'any');
    const issue = onlyIssue(schema, 'backwards');
    assert.equal(issue.code, 'not-allowed-value');
    assert.match(issue.message, /"any", "in-order"/);
  });

  it('accepts only the fixed value', () => {
    accepts({ const: 2 }, 2);
    assert.equal(onlyIssue({ const: 2 }, 3).code, 'not-allowed-value');
  });

  it('compares a listed object by content', () => {
    accepts({ enum: [{ a: 1 }] }, { a: 1 });
  });
});

describe('where a problem is reported', () => {
  const schema: ConfigSchema = {
    type: 'object',
    properties: {
      codes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { value: { type: 'string', minLength: 1 } },
          required: ['value'],
        },
      },
    },
  };

  it('writes the path the way the field is reached in code', () => {
    assert.equal(onlyIssue(schema, { codes: [{ value: 'a' }, {}] }).path, 'codes[1].value');
  });

  it('starts the path where the caller says it does', () => {
    assert.equal(
      onlyIssue(schema, { codes: [{}] }, 'missions[2].config').path,
      'missions[2].config.codes[0].value',
    );
  });

  it('reports every problem, not just the first', () => {
    const issues = issuesOf(schema, { codes: [{}, { value: '' }, { value: 1 }] });
    assert.deepEqual(
      issues.map((issue) => issue.path),
      ['codes[0].value', 'codes[1].value', 'codes[2].value'],
    );
  });
});
