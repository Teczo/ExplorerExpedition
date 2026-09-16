/**
 * Checking that a config schema is one this platform can run.
 *
 * The point of these tests is the refusals. A schema keyword that is quietly
 * ignored is a mission type that looks checked and is not, and the whole
 * reason `mission_type.config_schema` exists is to be checked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONFIG_SCHEMA_DIALECT,
  MAX_CONFIG_SCHEMA_DEPTH,
  SUPPORTED_SCHEMA_KEYWORDS,
  compilePattern,
  jsonEquals,
  validateConfigSchema,
  type MissionConfigIssue,
} from '../../src/mission-type/index.ts';

/** The issues from a schema that should not have been accepted. */
function issuesOf(value: unknown): MissionConfigIssue[] {
  const result = validateConfigSchema(value);
  assert.equal(result.valid, false, 'expected the schema to be refused');
  return result.valid ? [] : result.issues;
}

/** The single issue from a schema with exactly one thing wrong with it. */
function onlyIssue(value: unknown): MissionConfigIssue {
  const issues = issuesOf(value);
  assert.equal(issues.length, 1, `expected one issue, got ${JSON.stringify(issues)}`);
  return issues[0] as MissionConfigIssue;
}

describe('a schema the platform can run', () => {
  it('accepts the empty schema, which is what a new mission type row holds', () => {
    assert.equal(validateConfigSchema({}).valid, true);
  });

  it('accepts a whole mission type config schema', () => {
    const schema = {
      $schema: CONFIG_SCHEMA_DIALECT,
      type: 'object',
      title: 'QR hunt',
      properties: {
        codes: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', minLength: 1, maxLength: 200 },
              label: { type: 'string' },
              points: { type: 'integer', minimum: 0, maximum: 100 },
            },
            required: ['value'],
          },
        },
        order: { type: 'string', enum: ['any', 'in-order'], default: 'any' },
        radiusMetres: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
      },
      required: ['codes'],
    };
    assert.equal(validateConfigSchema(schema).valid, true);
  });

  it('hands back the same object, now typed', () => {
    const schema = { type: 'string' as const };
    const result = validateConfigSchema(schema);
    assert.equal(result.valid, true);
    assert.equal(result.valid && result.schema, schema);
  });

  it('refuses something that is not an object at all', () => {
    for (const value of [null, 'string', 42, [], true]) {
      assert.equal(onlyIssue(value).code, 'not-an-object');
    }
  });
});

describe('keywords outside the subset', () => {
  it('refuses a keyword this platform does not run, rather than ignoring it', () => {
    const issue = onlyIssue({ type: 'object', oneOf: [{ type: 'string' }] });
    assert.equal(issue.code, 'unsupported-keyword');
    assert.equal(issue.path, 'oneOf');
    assert.match(issue.message, /does not run "oneOf"/);
  });

  it('names every keyword it does run, so the message is actionable', () => {
    const issue = onlyIssue({ $ref: '#/$defs/thing' });
    for (const keyword of SUPPORTED_SCHEMA_KEYWORDS) {
      assert.ok(issue.message.includes(keyword), `message never mentions ${keyword}`);
    }
  });

  it('refuses one nested deep inside, and says where it is', () => {
    const issue = onlyIssue({
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'string', format: 'email' } } },
    });
    assert.equal(issue.code, 'unsupported-keyword');
    assert.equal(issue.path, 'properties.rows.items.format');
  });

  it('refuses a dialect other than the one it runs', () => {
    const issue = onlyIssue({ $schema: 'http://json-schema.org/draft-07/schema#' });
    assert.equal(issue.code, 'not-allowed-value');
    assert.equal(issue.path, '$schema');
  });
});

describe('keywords used on the wrong type', () => {
  it('refuses minLength on a number', () => {
    const issue = onlyIssue({ type: 'number', minLength: 2 });
    assert.equal(issue.code, 'inconsistent');
    assert.equal(issue.path, 'minLength');
  });

  it('refuses items on an object', () => {
    assert.equal(onlyIssue({ type: 'object', items: { type: 'string' } }).code, 'inconsistent');
  });

  it('allows a keyword on a schema that names no type', () => {
    assert.equal(validateConfigSchema({ minLength: 2 }).valid, true);
  });
});

describe('keywords that contradict each other', () => {
  it('refuses a maximum below the minimum', () => {
    const issue = onlyIssue({ type: 'integer', minimum: 10, maximum: 2 });
    assert.equal(issue.code, 'inconsistent');
    assert.equal(issue.path, 'maximum');
  });

  it('refuses maxItems below minItems', () => {
    assert.equal(onlyIssue({ type: 'array', minItems: 3, maxItems: 1 }).code, 'inconsistent');
  });

  it('refuses maxLength below minLength', () => {
    assert.equal(onlyIssue({ type: 'string', minLength: 3, maxLength: 1 }).code, 'inconsistent');
  });

  it('refuses requiring a field the schema does not describe', () => {
    const issue = onlyIssue({
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['codes'],
    });
    assert.equal(issue.code, 'inconsistent');
    assert.equal(issue.path, 'required[0]');
  });

  it('refuses the same field required twice', () => {
    const issue = onlyIssue({
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code', 'code'],
    });
    assert.equal(issue.code, 'duplicate-item');
  });

  it('refuses an empty list of allowed values, because nothing would pass', () => {
    assert.equal(onlyIssue({ enum: [] }).code, 'too-short');
  });

  it('refuses a step of zero or below', () => {
    assert.equal(onlyIssue({ type: 'number', multipleOf: 0 }).code, 'out-of-range');
    assert.equal(onlyIssue({ type: 'number', multipleOf: -1 }).code, 'out-of-range');
  });

  it('refuses a count that is not a whole number', () => {
    assert.equal(onlyIssue({ type: 'array', minItems: 1.5 }).code, 'not-an-integer');
  });

  it('refuses a negative count', () => {
    assert.equal(onlyIssue({ type: 'string', maxLength: -1 }).code, 'out-of-range');
  });
});

describe('patterns', () => {
  it('refuses a pattern that will not compile', () => {
    const issue = onlyIssue({ type: 'string', pattern: '([a-z' });
    assert.equal(issue.code, 'invalid-pattern');
    assert.equal(issue.path, 'pattern');
  });

  it('anchors a compiled pattern at both ends', () => {
    const expression = compilePattern('\\d+');
    assert.notEqual(expression, null);
    assert.equal(expression?.test('123'), true);
    assert.equal(expression?.test('a123'), false);
    assert.equal(expression?.test('123a'), false);
  });

  it('keeps alternation whole when it anchors', () => {
    const expression = compilePattern('cat|dog');
    assert.equal(expression?.test('cat'), true);
    assert.equal(expression?.test('dog'), true);
    assert.equal(expression?.test('cats'), false);
  });
});

describe('how deep a schema may go', () => {
  it('accepts nesting up to the limit', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < MAX_CONFIG_SCHEMA_DEPTH - 1; level += 1) {
      schema = { type: 'array', items: schema };
    }
    assert.equal(validateConfigSchema(schema).valid, true);
  });

  it('refuses nesting past it, rather than recursing without end', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < MAX_CONFIG_SCHEMA_DEPTH + 2; level += 1) {
      schema = { type: 'array', items: schema };
    }
    const issues = issuesOf(schema);
    assert.ok(issues.some((issue) => issue.code === 'too-deep'));
  });
});

describe('comparing JSON values', () => {
  it('compares by content, not by reference', () => {
    assert.equal(jsonEquals({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(jsonEquals({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(jsonEquals({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(jsonEquals(null, null), true);
    assert.equal(jsonEquals(0, false as never), false);
  });
});
