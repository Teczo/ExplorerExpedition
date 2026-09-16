/**
 * The schema language a mission type describes its `config` with.
 *
 * `mission_type.config_schema` and `mission_type.submission_schema` in
 * migration 0001 hold a JSON Schema. This file says exactly which part of
 * JSON Schema the platform runs, because "a JSON Schema" on its own is not a
 * contract anybody can build against:
 *
 *   - The Mission Type Builder (EXPD-025) has to draw a form for every
 *     keyword, so it needs the list to be finite.
 *   - The validator below is written by hand and pulls in no library, the
 *     same rule the Expedition Definition validator follows, so the student
 *     app can check a config without installing anything.
 *
 * The subset is JSON Schema draft 2020-12 with the keywords listed in
 * `SUPPORTED_SCHEMA_KEYWORDS`. A schema that uses any other keyword is
 * **refused**, not ignored. Ignoring one would mean a mission type that looks
 * checked and is not, which is worse than a schema the Studio cannot save.
 *
 * Three things are deliberately not in the subset, and each would be its own
 * piece of work: `$ref` and `$defs` (a schema referring to itself), the
 * combinators `oneOf`, `anyOf`, `allOf` and `not`, and `format`. A mission
 * config is a record of settings, and none of the three is needed to describe
 * one.
 */

import type { JsonObject, JsonValue } from '../expedition/common.ts';
import type { MissionConfigIssue, MissionConfigIssueCode } from './issues.ts';

/** The kinds of value a schema can ask for. */
export type ConfigSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** Every schema type. */
export const CONFIG_SCHEMA_TYPES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const satisfies readonly ConfigSchemaType[];

/** The JSON Schema dialect the subset is drawn from. */
export const CONFIG_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * One schema, describing one value.
 *
 * Every field is optional, so `{}` describes "any JSON value". That is the
 * default `mission_type.config_schema` holds, and it means a type that has
 * not described its settings yet rather than a mistake.
 */
export interface ConfigSchema {
  /** The dialect. When given it has to be `CONFIG_SCHEMA_DIALECT`. */
  $schema?: string;

  /** What kind of value this is. Absent means any kind is accepted. */
  type?: ConfigSchemaType;
  /** The field label the Studio shows. */
  title?: string;
  /** The help text the Studio shows under the field. */
  description?: string;
  /** What a new mission starts this field out with. */
  default?: JsonValue;
  /** Marks a field kept only so old configs still read. */
  deprecated?: boolean;
  /** The complete list of values allowed here. */
  enum?: JsonValue[];
  /** The single value allowed here. */
  const?: JsonValue;

  // type: 'object'
  /** The fields of the object, by name. */
  properties?: { [field: string]: ConfigSchema };
  /** Which of those fields have to be present. */
  required?: string[];
  /**
   * Whether fields outside `properties` are allowed.
   *
   * **This defaults to `false`, which is not the JSON Schema default.** A
   * mission config is written by hand in the Studio and by the AI builder,
   * and a misspelled field that is quietly accepted becomes a mission that
   * does nothing on the day. A schema that really does hold open-ended data
   * says `additionalProperties: true` and means it.
   *
   * It is only consulted when `properties` is given. An object schema with no
   * `properties` does not check its fields at all.
   */
  additionalProperties?: boolean;
  /** The fewest fields the object may hold. */
  minProperties?: number;
  /** The most fields the object may hold. */
  maxProperties?: number;

  // type: 'array'
  /** The schema every entry of the list has to match. */
  items?: ConfigSchema;
  /** The fewest entries the list may hold. */
  minItems?: number;
  /** The most entries the list may hold. */
  maxItems?: number;
  /** Whether two entries of the list may be equal. */
  uniqueItems?: boolean;

  // type: 'string'
  /** The fewest characters the string may hold. */
  minLength?: number;
  /** The most characters the string may hold. */
  maxLength?: number;
  /**
   * A regular expression the whole string has to match.
   *
   * It is compiled with the `u` flag and anchored at both ends, so `\d+`
   * means "digits and nothing else" rather than "digits somewhere".
   */
  pattern?: string;

  // type: 'number' | 'integer'
  /** The smallest value allowed, included. */
  minimum?: number;
  /** The largest value allowed, included. */
  maximum?: number;
  /** The smallest value allowed, excluded. */
  exclusiveMinimum?: number;
  /** The largest value allowed, excluded. */
  exclusiveMaximum?: number;
  /** The step the value has to fall on. Has to be above zero. */
  multipleOf?: number;
}

/**
 * Every keyword the platform runs.
 *
 * A schema carrying anything else is refused by `validateConfigSchema`.
 */
export const SUPPORTED_SCHEMA_KEYWORDS = [
  '$schema',
  'type',
  'title',
  'description',
  'default',
  'deprecated',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;

/**
 * How deeply a schema may nest.
 *
 * The same guard, and the same reason, as `MAX_UNLOCK_CONDITION_DEPTH` in the
 * Expedition Definition validator: a generated or hand-written schema must
 * not be able to make the walker recurse without end.
 */
export const MAX_CONFIG_SCHEMA_DEPTH = 10;

/** What came back from checking that a value is a schema we can run. */
export type ConfigSchemaResult =
  | {
      valid: true;
      /** The same value, now safe to treat as a `ConfigSchema`. */
      schema: ConfigSchema;
    }
  | {
      valid: false;
      /** Every problem found, in the order the schema was walked. */
      issues: MissionConfigIssue[];
    };

function report(
  issues: MissionConfigIssue[],
  path: string,
  code: MissionConfigIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Joins a path to a field name the way the field is reached in code. */
export function childPath(path: string, field: string): string {
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field);
  if (path === '') {
    return safe ? field : `[${JSON.stringify(field)}]`;
  }
  return safe ? `${path}.${field}` : `${path}[${JSON.stringify(field)}]`;
}

/**
 * Compares two JSON values by their content.
 *
 * `enum`, `const` and `uniqueItems` all need this, and `===` would answer
 * "different" for two objects that hold exactly the same thing.
 */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && jsonEquals(entry, other);
    });
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => {
      if (!Object.hasOwn(right, key)) {
        return false;
      }
      const a = (left as JsonObject)[key];
      const b = (right as JsonObject)[key];
      return a !== undefined && b !== undefined && jsonEquals(a, b);
    });
  }
  return false;
}

/**
 * Compiles a schema `pattern` into a regular expression.
 *
 * The pattern is anchored at both ends, so it describes the whole string.
 * Returns `null` when the pattern will not compile.
 *
 * One limit is worth knowing: the pattern comes from whoever authored the
 * mission type, and a pattern can be written that takes a very long time on
 * a crafted input. That is a creator holding up their own organisation's
 * Studio, not a student reaching anything, so the platform compiles what it
 * is given rather than trying to judge it.
 */
export function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
}

/** Says whether a value is JSON — the only thing a schema may hold. */
function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > MAX_CONFIG_SCHEMA_DEPTH) {
    return false;
  }
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') {
    return true;
  }
  if (kind === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

/** Checks a keyword that has to be a whole number of at least `min`. */
function checkCount(
  issues: MissionConfigIssue[],
  path: string,
  keyword: string,
  value: unknown,
  min: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    report(issues, childPath(path, keyword), 'wrong-type', 'This has to be a number.');
    return undefined;
  }
  if (!Number.isInteger(value)) {
    report(
      issues,
      childPath(path, keyword),
      'not-an-integer',
      'This has to be a whole number.',
    );
    return undefined;
  }
  if (value < min) {
    report(
      issues,
      childPath(path, keyword),
      'out-of-range',
      `This cannot be below ${min}.`,
    );
    return undefined;
  }
  return value;
}

/** Checks a keyword that has to be a finite number. */
function checkNumber(
  issues: MissionConfigIssue[],
  path: string,
  keyword: string,
  value: unknown,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    report(issues, childPath(path, keyword), 'wrong-type', 'This has to be a number.');
    return undefined;
  }
  return value;
}

/** Checks a keyword that has to be true or false. */
function checkBoolean(
  issues: MissionConfigIssue[],
  path: string,
  keyword: string,
  value: unknown,
): void {
  if (typeof value !== 'boolean') {
    report(
      issues,
      childPath(path, keyword),
      'wrong-type',
      'This has to be true or false.',
    );
  }
}

/** Checks a keyword that has to be a non-empty string. */
function checkString(
  issues: MissionConfigIssue[],
  path: string,
  keyword: string,
  value: unknown,
): void {
  if (typeof value !== 'string') {
    report(issues, childPath(path, keyword), 'wrong-type', 'This has to be a string.');
  }
}

function walkSchema(
  issues: MissionConfigIssue[],
  path: string,
  value: unknown,
  depth: number,
): void {
  if (depth > MAX_CONFIG_SCHEMA_DEPTH) {
    report(
      issues,
      path,
      'too-deep',
      `A schema may not nest more than ${MAX_CONFIG_SCHEMA_DEPTH} levels deep.`,
    );
    return;
  }
  if (!isPlainObject(value)) {
    report(issues, path, 'not-an-object', 'A schema has to be an object.');
    return;
  }

  for (const keyword of Object.keys(value)) {
    if (!(SUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(keyword)) {
      report(
        issues,
        childPath(path, keyword),
        'unsupported-keyword',
        `This platform does not run "${keyword}". The keywords it runs are: ` +
          `${SUPPORTED_SCHEMA_KEYWORDS.join(', ')}.`,
      );
    }
  }

  if (value['$schema'] !== undefined && value['$schema'] !== CONFIG_SCHEMA_DIALECT) {
    report(
      issues,
      childPath(path, '$schema'),
      'not-allowed-value',
      `The only dialect this platform runs is ${CONFIG_SCHEMA_DIALECT}.`,
    );
  }

  let type: ConfigSchemaType | undefined;
  if (value['type'] !== undefined) {
    if (
      typeof value['type'] !== 'string' ||
      !(CONFIG_SCHEMA_TYPES as readonly string[]).includes(value['type'])
    ) {
      report(
        issues,
        childPath(path, 'type'),
        'not-allowed-value',
        `This has to be one of: ${CONFIG_SCHEMA_TYPES.join(', ')}.`,
      );
    } else {
      type = value['type'] as ConfigSchemaType;
    }
  }

  if (value['title'] !== undefined) {
    checkString(issues, path, 'title', value['title']);
  }
  if (value['description'] !== undefined) {
    checkString(issues, path, 'description', value['description']);
  }
  if (value['deprecated'] !== undefined) {
    checkBoolean(issues, path, 'deprecated', value['deprecated']);
  }
  if (value['default'] !== undefined && !isJsonValue(value['default'], 0)) {
    report(
      issues,
      childPath(path, 'default'),
      'wrong-type',
      'A default has to be a value that survives a round trip through JSON.',
    );
  }

  if (value['enum'] !== undefined) {
    const entries = value['enum'];
    if (!Array.isArray(entries)) {
      report(issues, childPath(path, 'enum'), 'wrong-type', 'This has to be a list.');
    } else if (entries.length === 0) {
      report(
        issues,
        childPath(path, 'enum'),
        'too-short',
        'A list of allowed values cannot be empty, because nothing would pass.',
      );
    } else {
      entries.forEach((entry, index) => {
        if (!isJsonValue(entry, 0)) {
          report(
            issues,
            `${childPath(path, 'enum')}[${index}]`,
            'wrong-type',
            'An allowed value has to survive a round trip through JSON.',
          );
        }
      });
    }
  }

  if (value['const'] !== undefined && !isJsonValue(value['const'], 0)) {
    report(
      issues,
      childPath(path, 'const'),
      'wrong-type',
      'A fixed value has to survive a round trip through JSON.',
    );
  }

  walkObjectKeywords(issues, path, value, type, depth);
  walkArrayKeywords(issues, path, value, type, depth);
  walkStringKeywords(issues, path, value, type);
  walkNumberKeywords(issues, path, value, type);
}

/** Reports a keyword used on a schema whose `type` cannot carry it. */
function checkKeywordApplies(
  issues: MissionConfigIssue[],
  path: string,
  keyword: string,
  type: ConfigSchemaType | undefined,
  allowed: readonly ConfigSchemaType[],
): void {
  if (type !== undefined && !allowed.includes(type)) {
    report(
      issues,
      childPath(path, keyword),
      'inconsistent',
      `"${keyword}" describes ${allowed.join(' or ')}, but this schema is ` +
        `of type "${type}".`,
    );
  }
}

function walkObjectKeywords(
  issues: MissionConfigIssue[],
  path: string,
  value: Record<string, unknown>,
  type: ConfigSchemaType | undefined,
  depth: number,
): void {
  const objectOnly: readonly ConfigSchemaType[] = ['object'];

  if (value['properties'] !== undefined) {
    checkKeywordApplies(issues, path, 'properties', type, objectOnly);
    const properties = value['properties'];
    if (!isPlainObject(properties)) {
      report(
        issues,
        childPath(path, 'properties'),
        'not-an-object',
        'This has to be an object of field name to schema.',
      );
    } else {
      for (const [field, child] of Object.entries(properties)) {
        walkSchema(
          issues,
          childPath(childPath(path, 'properties'), field),
          child,
          depth + 1,
        );
      }
    }
  }

  if (value['required'] !== undefined) {
    checkKeywordApplies(issues, path, 'required', type, objectOnly);
    const required = value['required'];
    if (!Array.isArray(required)) {
      report(issues, childPath(path, 'required'), 'wrong-type', 'This has to be a list.');
    } else {
      const seen = new Set<string>();
      required.forEach((field, index) => {
        const at = `${childPath(path, 'required')}[${index}]`;
        if (typeof field !== 'string') {
          report(issues, at, 'wrong-type', 'This has to be a field name.');
          return;
        }
        if (field === '') {
          report(issues, at, 'empty-string', 'A field name cannot be empty.');
          return;
        }
        if (seen.has(field)) {
          report(issues, at, 'duplicate-item', `"${field}" is listed twice.`);
          return;
        }
        seen.add(field);
        const properties = value['properties'];
        if (isPlainObject(properties) && !Object.hasOwn(properties, field)) {
          report(
            issues,
            at,
            'inconsistent',
            `"${field}" is required but the schema does not describe it.`,
          );
        }
      });
    }
  }

  if (value['additionalProperties'] !== undefined) {
    checkKeywordApplies(issues, path, 'additionalProperties', type, objectOnly);
    checkBoolean(issues, path, 'additionalProperties', value['additionalProperties']);
  }

  let min: number | undefined;
  if (value['minProperties'] !== undefined) {
    checkKeywordApplies(issues, path, 'minProperties', type, objectOnly);
    min = checkCount(issues, path, 'minProperties', value['minProperties'], 0);
  }
  if (value['maxProperties'] !== undefined) {
    checkKeywordApplies(issues, path, 'maxProperties', type, objectOnly);
    const max = checkCount(issues, path, 'maxProperties', value['maxProperties'], 0);
    if (min !== undefined && max !== undefined && max < min) {
      report(
        issues,
        childPath(path, 'maxProperties'),
        'inconsistent',
        'The most fields allowed is below the fewest.',
      );
    }
  }
}

function walkArrayKeywords(
  issues: MissionConfigIssue[],
  path: string,
  value: Record<string, unknown>,
  type: ConfigSchemaType | undefined,
  depth: number,
): void {
  const arrayOnly: readonly ConfigSchemaType[] = ['array'];

  if (value['items'] !== undefined) {
    checkKeywordApplies(issues, path, 'items', type, arrayOnly);
    walkSchema(issues, childPath(path, 'items'), value['items'], depth + 1);
  }

  let min: number | undefined;
  if (value['minItems'] !== undefined) {
    checkKeywordApplies(issues, path, 'minItems', type, arrayOnly);
    min = checkCount(issues, path, 'minItems', value['minItems'], 0);
  }
  if (value['maxItems'] !== undefined) {
    checkKeywordApplies(issues, path, 'maxItems', type, arrayOnly);
    const max = checkCount(issues, path, 'maxItems', value['maxItems'], 0);
    if (min !== undefined && max !== undefined && max < min) {
      report(
        issues,
        childPath(path, 'maxItems'),
        'inconsistent',
        'The most entries allowed is below the fewest.',
      );
    }
  }
  if (value['uniqueItems'] !== undefined) {
    checkKeywordApplies(issues, path, 'uniqueItems', type, arrayOnly);
    checkBoolean(issues, path, 'uniqueItems', value['uniqueItems']);
  }
}

function walkStringKeywords(
  issues: MissionConfigIssue[],
  path: string,
  value: Record<string, unknown>,
  type: ConfigSchemaType | undefined,
): void {
  const stringOnly: readonly ConfigSchemaType[] = ['string'];

  let min: number | undefined;
  if (value['minLength'] !== undefined) {
    checkKeywordApplies(issues, path, 'minLength', type, stringOnly);
    min = checkCount(issues, path, 'minLength', value['minLength'], 0);
  }
  if (value['maxLength'] !== undefined) {
    checkKeywordApplies(issues, path, 'maxLength', type, stringOnly);
    const max = checkCount(issues, path, 'maxLength', value['maxLength'], 0);
    if (min !== undefined && max !== undefined && max < min) {
      report(
        issues,
        childPath(path, 'maxLength'),
        'inconsistent',
        'The most characters allowed is below the fewest.',
      );
    }
  }
  if (value['pattern'] !== undefined) {
    checkKeywordApplies(issues, path, 'pattern', type, stringOnly);
    if (typeof value['pattern'] !== 'string') {
      report(issues, childPath(path, 'pattern'), 'wrong-type', 'This has to be a string.');
    } else if (compilePattern(value['pattern']) === null) {
      report(
        issues,
        childPath(path, 'pattern'),
        'invalid-pattern',
        'This is not a regular expression this platform can compile.',
      );
    }
  }
}

function walkNumberKeywords(
  issues: MissionConfigIssue[],
  path: string,
  value: Record<string, unknown>,
  type: ConfigSchemaType | undefined,
): void {
  const numeric: readonly ConfigSchemaType[] = ['number', 'integer'];

  let min: number | undefined;
  if (value['minimum'] !== undefined) {
    checkKeywordApplies(issues, path, 'minimum', type, numeric);
    min = checkNumber(issues, path, 'minimum', value['minimum']);
  }
  if (value['maximum'] !== undefined) {
    checkKeywordApplies(issues, path, 'maximum', type, numeric);
    const max = checkNumber(issues, path, 'maximum', value['maximum']);
    if (min !== undefined && max !== undefined && max < min) {
      report(
        issues,
        childPath(path, 'maximum'),
        'inconsistent',
        'The largest value allowed is below the smallest.',
      );
    }
  }
  if (value['exclusiveMinimum'] !== undefined) {
    checkKeywordApplies(issues, path, 'exclusiveMinimum', type, numeric);
    checkNumber(issues, path, 'exclusiveMinimum', value['exclusiveMinimum']);
  }
  if (value['exclusiveMaximum'] !== undefined) {
    checkKeywordApplies(issues, path, 'exclusiveMaximum', type, numeric);
    checkNumber(issues, path, 'exclusiveMaximum', value['exclusiveMaximum']);
  }
  if (value['multipleOf'] !== undefined) {
    checkKeywordApplies(issues, path, 'multipleOf', type, numeric);
    const step = checkNumber(issues, path, 'multipleOf', value['multipleOf']);
    if (step !== undefined && step <= 0) {
      report(
        issues,
        childPath(path, 'multipleOf'),
        'out-of-range',
        'A step has to be above zero.',
      );
    }
  }
}

/**
 * Checks that an unknown value is a schema this platform can run.
 *
 * The Mission Type Builder (EXPD-025) calls this before it saves, and the
 * registry calls it before it accepts a mission type, so a schema that would
 * silently check nothing never reaches an expedition.
 */
export function validateConfigSchema(value: unknown): ConfigSchemaResult {
  const issues: MissionConfigIssue[] = [];
  walkSchema(issues, '', value, 0);
  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, schema: value as ConfigSchema };
}
