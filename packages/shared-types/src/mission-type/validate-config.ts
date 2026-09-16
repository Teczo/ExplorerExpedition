/**
 * Checking a value against a mission type's schema.
 *
 * This is the check the Expedition Definition validator could not do. EXPD-002
 * says of `MissionInstance.config`: "Only the mission type knows the right
 * shape, so only the registry (EXPD-009) can check it." This file is that
 * check, and the registry is what joins a mission to the schema to run it
 * against.
 *
 * The same function checks a submission payload against
 * `mission_type.submission_schema`, because a submission is a JSON object
 * described by a schema in exactly the same way.
 *
 * It is written by hand and pulls in no library, so the Studio, the API, the
 * engine and the student app all run the same rules.
 */

import type { JsonValue } from '../expedition/common.ts';
import {
  childPath,
  compilePattern,
  jsonEquals,
  MAX_CONFIG_SCHEMA_DEPTH,
  type ConfigSchema,
  type ConfigSchemaType,
} from './config-schema.ts';
import {
  toMissionConfigResult,
  type MissionConfigIssue,
  type MissionConfigIssueCode,
  type MissionConfigValidationResult,
} from './issues.ts';

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

/** Names the kind of a value the way the schema's `type` keyword would. */
function kindOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return typeof value;
}

/** Says whether a value is of the type the schema asks for. */
function matchesType(value: unknown, type: ConfigSchemaType): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

function walkValue(
  issues: MissionConfigIssue[],
  path: string,
  value: unknown,
  schema: ConfigSchema,
  depth: number,
): void {
  if (depth > MAX_CONFIG_SCHEMA_DEPTH) {
    report(
      issues,
      path,
      'too-deep',
      `A value may not nest more than ${MAX_CONFIG_SCHEMA_DEPTH} levels deep.`,
    );
    return;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    report(
      issues,
      path,
      'wrong-type',
      'This has to be a number that survives a round trip through JSON.',
    );
    return;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    report(issues, path, 'wrong-type', 'This has to be a value JSON can hold.');
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    report(
      issues,
      path,
      'wrong-type',
      `This has to be ${schema.type}, but it is ${kindOf(value)}.`,
    );
    return;
  }

  if (schema.const !== undefined && !jsonEquals(value as JsonValue, schema.const)) {
    report(
      issues,
      path,
      'not-allowed-value',
      `The only value allowed here is ${JSON.stringify(schema.const)}.`,
    );
    return;
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum.some((entry) => jsonEquals(value as JsonValue, entry));
    if (!allowed) {
      report(
        issues,
        path,
        'not-allowed-value',
        `This has to be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`,
      );
      return;
    }
  }

  if (isPlainObject(value)) {
    walkObject(issues, path, value, schema, depth);
    return;
  }
  if (Array.isArray(value)) {
    walkArray(issues, path, value, schema, depth);
    return;
  }
  if (typeof value === 'string') {
    walkString(issues, path, value, schema);
    return;
  }
  if (typeof value === 'number') {
    walkNumber(issues, path, value, schema);
  }
}

function walkObject(
  issues: MissionConfigIssue[],
  path: string,
  value: Record<string, unknown>,
  schema: ConfigSchema,
  depth: number,
): void {
  // A field explicitly set to `undefined` is the same as one that is absent.
  // JSON cannot carry it, so treating it as present would let a value pass
  // here and fail the moment it was stored.
  const present = Object.keys(value).filter((field) => value[field] !== undefined);

  if (schema.required !== undefined) {
    for (const field of schema.required) {
      if (!present.includes(field)) {
        report(issues, childPath(path, field), 'missing', 'This field is required.');
      }
    }
  }

  if (schema.minProperties !== undefined && present.length < schema.minProperties) {
    report(
      issues,
      path,
      'too-short',
      `This has to hold at least ${schema.minProperties} fields.`,
    );
  }
  if (schema.maxProperties !== undefined && present.length > schema.maxProperties) {
    report(
      issues,
      path,
      'too-long',
      `This cannot hold more than ${schema.maxProperties} fields.`,
    );
  }

  const properties = schema.properties;
  if (properties === undefined) {
    // The schema does not describe the fields, so there is nothing to check.
    return;
  }

  for (const field of present) {
    const child = properties[field];
    if (child === undefined) {
      if (schema.additionalProperties !== true) {
        report(
          issues,
          childPath(path, field),
          'unknown-field',
          `This mission type does not have a setting called "${field}".`,
        );
      }
      continue;
    }
    walkValue(issues, childPath(path, field), value[field], child, depth + 1);
  }
}

function walkArray(
  issues: MissionConfigIssue[],
  path: string,
  value: unknown[],
  schema: ConfigSchema,
  depth: number,
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    report(issues, path, 'too-short', `This has to hold at least ${schema.minItems} entries.`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    report(issues, path, 'too-long', `This cannot hold more than ${schema.maxItems} entries.`);
  }

  if (schema.uniqueItems === true) {
    for (let index = 1; index < value.length; index += 1) {
      const entry = value[index] as JsonValue;
      const earlier = value
        .slice(0, index)
        .findIndex((other) => jsonEquals(other as JsonValue, entry));
      if (earlier !== -1) {
        report(
          issues,
          `${path}[${index}]`,
          'duplicate-item',
          `This is the same as entry ${earlier}, and every entry has to differ.`,
        );
      }
    }
  }

  const items = schema.items;
  if (items === undefined) {
    return;
  }
  value.forEach((entry, index) => {
    walkValue(issues, `${path}[${index}]`, entry, items, depth + 1);
  });
}

function walkString(
  issues: MissionConfigIssue[],
  path: string,
  value: string,
  schema: ConfigSchema,
): void {
  // Counted in code points rather than UTF-16 units, so an emoji is one
  // character, the way the person typing it would count.
  const length = [...value].length;

  if (schema.minLength !== undefined && length < schema.minLength) {
    if (schema.minLength === 1 && length === 0) {
      report(issues, path, 'empty-string', 'This cannot be empty.');
    } else {
      report(
        issues,
        path,
        'too-short',
        `This has to be at least ${schema.minLength} characters.`,
      );
    }
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    report(issues, path, 'too-long', `This cannot be longer than ${schema.maxLength} characters.`);
  }
  if (schema.pattern !== undefined) {
    const expression = compilePattern(schema.pattern);
    if (expression !== null && !expression.test(value)) {
      report(issues, path, 'pattern-mismatch', `This has to match ${schema.pattern}.`);
    }
  }
}

function walkNumber(
  issues: MissionConfigIssue[],
  path: string,
  value: number,
  schema: ConfigSchema,
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    report(issues, path, 'out-of-range', `This cannot be below ${schema.minimum}.`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    report(issues, path, 'out-of-range', `This cannot be above ${schema.maximum}.`);
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    report(issues, path, 'out-of-range', `This has to be above ${schema.exclusiveMinimum}.`);
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    report(issues, path, 'out-of-range', `This has to be below ${schema.exclusiveMaximum}.`);
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const steps = value / schema.multipleOf;
    // Rounded before the comparison, because 0.3 / 0.1 is not exactly 3 in
    // binary floating point and a step of 0.1 is a thing an author will set.
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      report(
        issues,
        path,
        'not-a-multiple',
        `This has to be a multiple of ${schema.multipleOf}.`,
      );
    }
  }
}

/** Where to start the paths in the issues that come back. */
export interface ValidateAgainstSchemaOptions {
  /**
   * The path the value sits at inside a larger document.
   *
   * The registry passes `missions[2].config` when it checks a whole
   * expedition, so the Studio can put the problem on the right mission.
   * Left out, paths start at the value itself.
   */
  path?: string;
}

/**
 * Checks a value against a schema.
 *
 * The schema is trusted: it is expected to have been through
 * `validateConfigSchema` already, which the registry does once at
 * registration rather than once per mission.
 */
export function validateAgainstSchema(
  schema: ConfigSchema,
  value: unknown,
  options: ValidateAgainstSchemaOptions = {},
): MissionConfigValidationResult {
  const issues: MissionConfigIssue[] = [];
  walkValue(issues, options.path ?? '', value, schema, 0);
  return toMissionConfigResult(issues);
}
