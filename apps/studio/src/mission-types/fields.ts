/**
 * The builder's field list, and the config schema it stands for (EXPD-025).
 *
 * An author thinks in fields: "a species name, required; a count, at least
 * zero". The platform stores a config schema (EXPD-009). This file turns the
 * first into the second, and back again when a saved type is opened.
 *
 * Six kinds of field cover what a mission's settings are made of. A schema
 * that uses anything else — nesting, a list of objects, a keyword no kind
 * here writes — cannot be drawn as fields, and `fieldsFromSchema` says so by
 * returning `null`. The builder then shows the schema as JSON instead, so
 * nothing the schema language allows is out of an author's reach.
 *
 * Every value in a `FieldDraft` is what the input holds, so a half-typed
 * number is kept as the author typed it. Turning it into a schema is where it
 * is read, and where a problem with it is reported.
 */

import type { ConfigSchema, JsonObject, JsonValue } from '@explorer/shared-types';

/** The kinds of field the builder offers. */
export type FieldKind = 'text' | 'number' | 'whole-number' | 'yes-no' | 'choice' | 'text-list';

/** Every kind, with what the builder calls it. */
export const FIELD_KINDS: readonly { readonly kind: FieldKind; readonly label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' },
  { kind: 'whole-number', label: 'Whole number' },
  { kind: 'yes-no', label: 'Yes or no' },
  { kind: 'choice', label: 'Choice from a list' },
  { kind: 'text-list', label: 'List of text' },
];

/** One field, as the builder's inputs hold it. */
export interface FieldDraft {
  /** The key in the config, such as `species`. */
  name: string;
  /** The label an author placing the mission sees. */
  label: string;
  /** Help text shown under that label. */
  help: string;
  kind: FieldKind;
  required: boolean;
  /**
   * The starting value, as typed. Empty means none. A yes-no field holds
   * `true` or `false`; a text list holds one entry per line.
   */
  defaultValue: string;
  /** The allowed values of a choice field, one per entry. */
  options: string[];
  /**
   * The lower and upper bound, as typed. Characters for text, the value for a
   * number, entries for a list. Empty means no bound.
   */
  min: string;
  max: string;
  /** A regular expression a text field has to match. Empty means none. */
  pattern: string;
}

/** A field with nothing filled in. */
export function blankField(kind: FieldKind = 'text'): FieldDraft {
  return {
    name: '',
    label: '',
    help: '',
    kind,
    required: false,
    defaultValue: '',
    options: [],
    min: '',
    max: '',
    pattern: '',
  };
}

/** A problem with one field that stops it becoming a schema. */
export interface FieldProblem {
  /** Which field, by its place in the list. */
  readonly index: number;
  /** Which input: `name`, `defaultValue`, `min`, `max` or `options`. */
  readonly input: keyof FieldDraft;
  readonly message: string;
}

/** What a field list turns into. */
export interface FieldsResult {
  readonly schema: ConfigSchema;
  /** The starting value of every field that has one. */
  readonly defaults: JsonObject;
  /** Empty when every field could be read. */
  readonly problems: readonly FieldProblem[];
}

/** A field name: a plain identifier, so a layout and a config can both name it. */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Turns the field list into a config schema and the defaults it starts with. */
export function schemaFromFields(fields: readonly FieldDraft[]): FieldsResult {
  const problems: FieldProblem[] = [];
  const properties: Record<string, ConfigSchema> = {};
  const required: string[] = [];
  const defaults: JsonObject = {};

  fields.forEach((field, index) => {
    const name = field.name.trim();
    if (!FIELD_NAME_PATTERN.test(name)) {
      problems.push({
        index,
        input: 'name',
        message: 'A name is letters, digits and _, and does not start with a digit.',
      });
      return;
    }
    if (Object.hasOwn(properties, name)) {
      problems.push({ index, input: 'name', message: `"${name}" is used by another field.` });
      return;
    }

    const property = propertyOf(field, index, problems);
    const value = defaultOf(field, index, problems);
    if (value !== undefined) {
      property.default = value;
      defaults[name] = value;
    }
    properties[name] = property;
    if (field.required) {
      required.push(name);
    }
  });

  const schema: ConfigSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) {
    schema.required = required;
  }
  return { schema, defaults, problems };
}

function propertyOf(field: FieldDraft, index: number, problems: FieldProblem[]): ConfigSchema {
  const property: ConfigSchema = {};
  switch (field.kind) {
    case 'text':
    case 'choice':
      property.type = 'string';
      break;
    case 'number':
      property.type = 'number';
      break;
    case 'whole-number':
      property.type = 'integer';
      break;
    case 'yes-no':
      property.type = 'boolean';
      break;
    case 'text-list':
      property.type = 'array';
      property.items = { type: 'string', minLength: 1 };
      break;
  }
  if (field.label.trim() !== '') {
    property.title = field.label.trim();
  }
  if (field.help.trim() !== '') {
    property.description = field.help.trim();
  }

  if (field.kind === 'choice') {
    const options = field.options.map((option) => option.trim()).filter((option) => option !== '');
    if (options.length === 0) {
      problems.push({ index, input: 'options', message: 'A choice needs at least one option.' });
    } else if (new Set(options).size !== options.length) {
      problems.push({ index, input: 'options', message: 'Each option is listed once.' });
    }
    property.enum = options;
  }

  const bounds: Partial<Record<FieldKind, readonly [keyof ConfigSchema, keyof ConfigSchema, boolean]>> = {
    text: ['minLength', 'maxLength', true],
    number: ['minimum', 'maximum', false],
    'whole-number': ['minimum', 'maximum', true],
    'text-list': ['minItems', 'maxItems', true],
  };
  const bound = bounds[field.kind];
  if (bound !== undefined) {
    const [low, high, whole] = bound;
    const min = readNumber(field.min, whole, index, 'min', problems);
    const max = readNumber(field.max, whole, index, 'max', problems);
    if (min !== undefined) {
      (property as Record<string, unknown>)[low] = min;
    }
    if (max !== undefined) {
      (property as Record<string, unknown>)[high] = max;
    }
    if (min !== undefined && max !== undefined && min > max) {
      problems.push({ index, input: 'max', message: 'The upper bound is below the lower bound.' });
    }
  }

  if (field.kind === 'text' && field.pattern !== '') {
    property.pattern = field.pattern;
  }
  return property;
}

function readNumber(
  text: string,
  whole: boolean,
  index: number,
  input: keyof FieldDraft,
  problems: FieldProblem[],
): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    problems.push({ index, input, message: 'This has to be a number.' });
    return undefined;
  }
  if (whole && !Number.isInteger(value)) {
    problems.push({ index, input, message: 'This has to be a whole number.' });
    return undefined;
  }
  return value;
}

function defaultOf(
  field: FieldDraft,
  index: number,
  problems: FieldProblem[],
): JsonValue | undefined {
  const text = field.defaultValue;
  if (text.trim() === '') {
    return undefined;
  }
  switch (field.kind) {
    case 'text':
    case 'choice':
      return text;
    case 'number':
    case 'whole-number':
      return readNumber(text, field.kind === 'whole-number', index, 'defaultValue', problems);
    case 'yes-no':
      if (text === 'true' || text === 'false') {
        return text === 'true';
      }
      problems.push({ index, input: 'defaultValue', message: 'This has to be yes or no.' });
      return undefined;
    case 'text-list':
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
  }
}

const OBJECT_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties']);

const KEYWORDS_BY_KIND: Record<FieldKind, ReadonlySet<string>> = {
  text: new Set(['type', 'title', 'description', 'default', 'minLength', 'maxLength', 'pattern']),
  number: new Set(['type', 'title', 'description', 'default', 'minimum', 'maximum']),
  'whole-number': new Set(['type', 'title', 'description', 'default', 'minimum', 'maximum']),
  'yes-no': new Set(['type', 'title', 'description', 'default']),
  choice: new Set(['type', 'title', 'description', 'default', 'enum']),
  'text-list': new Set(['type', 'title', 'description', 'default', 'items', 'minItems', 'maxItems']),
};

/**
 * Reads a saved config schema back into fields.
 *
 * `null` when the schema holds anything the six kinds cannot say, so the
 * builder shows it as JSON rather than dropping part of it on the next save.
 */
export function fieldsFromSchema(schema: ConfigSchema): FieldDraft[] | null {
  if (schema.type !== 'object' || schema.additionalProperties === true) {
    return null;
  }
  if (Object.keys(schema).some((keyword) => !OBJECT_KEYWORDS.has(keyword))) {
    return null;
  }
  const required = new Set(schema.required ?? []);
  const fields: FieldDraft[] = [];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      return null;
    }
    const kind = kindOf(property);
    if (kind === null) {
      return null;
    }
    if (Object.keys(property).some((keyword) => !KEYWORDS_BY_KIND[kind].has(keyword))) {
      return null;
    }
    const field = fieldOf(name, kind, property, required.has(name));
    if (field === null) {
      return null;
    }
    fields.push(field);
  }
  return fields;
}

function kindOf(property: ConfigSchema): FieldKind | null {
  switch (property.type) {
    case 'string':
      return property.enum === undefined ? 'text' : 'choice';
    case 'number':
      return 'number';
    case 'integer':
      return 'whole-number';
    case 'boolean':
      return 'yes-no';
    case 'array': {
      const items = property.items;
      const plain =
        items !== undefined &&
        items.type === 'string' &&
        items.minLength === 1 &&
        Object.keys(items).length === 2;
      return plain ? 'text-list' : null;
    }
    default:
      return null;
  }
}

function fieldOf(
  name: string,
  kind: FieldKind,
  property: ConfigSchema,
  required: boolean,
): FieldDraft | null {
  const field = blankField(kind);
  field.name = name;
  field.label = property.title ?? '';
  field.help = property.description ?? '';
  field.required = required;

  if (kind === 'choice') {
    if (!property.enum?.every((option) => typeof option === 'string')) {
      return null;
    }
    field.options = property.enum as string[];
  }

  const low = property.minLength ?? property.minimum ?? property.minItems;
  const high = property.maxLength ?? property.maximum ?? property.maxItems;
  field.min = low === undefined ? '' : String(low);
  field.max = high === undefined ? '' : String(high);
  field.pattern = property.pattern ?? '';

  const value = property.default;
  if (value !== undefined) {
    if (kind === 'text-list') {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return null;
      }
      field.defaultValue = value.join('\n');
    } else if (typeof value === 'object' && value !== null) {
      return null;
    } else {
      field.defaultValue = String(value);
    }
  }
  return field;
}
