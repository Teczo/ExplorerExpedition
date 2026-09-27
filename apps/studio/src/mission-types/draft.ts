/**
 * Everything the Mission Type Builder's form holds, and the type it saves
 * (EXPD-025).
 *
 * The form keeps what the inputs hold: numbers as typed, schemas as fields or
 * as JSON text. `toAuthored` reads all of it into an `AuthoredMissionType`
 * and runs the same check the API runs (`validateAuthoredMissionType`), so an
 * author sees every problem next to its input before they press save, and a
 * save that the API would refuse is never sent.
 */

import {
  DEFAULT_MISSION_TYPE_AUTHORING,
  validateAuthoredMissionType,
  type AuthoredMissionType,
  type ConfigSchema,
  type JsonObject,
  type MissionCapability,
  type StudentLayout,
  type VerificationMode,
} from '@explorer/shared-types';

import { blankField, fieldsFromSchema, schemaFromFields, type FieldDraft } from './fields.ts';

/** A schema as the builder edits it: as fields when it can, as JSON when not. */
export type SchemaDraft =
  | { readonly mode: 'fields'; readonly fields: readonly FieldDraft[] }
  | { readonly mode: 'json'; readonly text: string };

/** The whole form. */
export interface BuilderDraft {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly MissionCapability[];
  /** The settings an author placing a mission fills in. */
  readonly config: SchemaDraft;
  /**
   * The starting settings, as JSON text. Only read when `config` is JSON;
   * in fields mode they come from each field's default.
   */
  readonly defaultConfigText: string;
  /** What a team hands in. */
  readonly submission: SchemaDraft;
  readonly validationMethod: VerificationMode;
  readonly basePoints: string;
  readonly allowPartialCredit: boolean;
  /** Empty means no cap. */
  readonly maxPoints: string;
  readonly layout: StudentLayout;
}

/** A form for a new type. */
export function blankDraft(): BuilderDraft {
  const defaults = DEFAULT_MISSION_TYPE_AUTHORING;
  return {
    key: '',
    version: '1.0.0',
    name: '',
    description: '',
    capabilities: [],
    config: { mode: 'fields', fields: [] },
    defaultConfigText: '{}',
    submission: { mode: 'fields', fields: [{ ...blankField('text'), name: 'answer', label: 'Answer' }] },
    validationMethod: defaults.validationMethod,
    basePoints: String(defaults.defaultScoring.basePoints),
    allowPartialCredit: defaults.defaultScoring.allowPartialCredit,
    maxPoints: '',
    layout: structuredClone(defaults.studentLayout),
  };
}

function schemaDraftOf(schema: ConfigSchema): SchemaDraft {
  const fields = fieldsFromSchema(schema);
  return fields === null ? { mode: 'json', text: pretty(schema) } : { mode: 'fields', fields };
}

/** A form holding a saved type. */
export function draftOf(type: AuthoredMissionType): BuilderDraft {
  return {
    key: type.key,
    version: type.version,
    name: type.name,
    description: type.description,
    capabilities: [...type.capabilities],
    config: schemaDraftOf(type.configSchema),
    defaultConfigText: pretty(type.defaultConfig),
    submission: schemaDraftOf(type.submissionSchema),
    validationMethod: type.validationMethod,
    basePoints: String(type.defaultScoring.basePoints),
    allowPartialCredit: type.defaultScoring.allowPartialCredit,
    maxPoints: type.defaultScoring.maxPoints === undefined ? '' : String(type.defaultScoring.maxPoints),
    layout: structuredClone(type.studentLayout),
  };
}

/** Switches a schema between fields and JSON. `null` when the JSON cannot be drawn as fields. */
export function switchMode(draft: SchemaDraft): SchemaDraft | null {
  if (draft.mode === 'fields') {
    return { mode: 'json', text: pretty(schemaFromFields(draft.fields).schema) };
  }
  const parsed = parseObject(draft.text);
  if (parsed === null) {
    return null;
  }
  const fields = fieldsFromSchema(parsed as ConfigSchema);
  return fields === null ? null : { mode: 'fields', fields };
}

/** One problem, with the path of the input it belongs to. */
export interface DraftIssue {
  /**
   * Where the problem is. A path the API would report (`defaultScoring.basePoints`),
   * or a field in the list (`configSchema.fields[2].name`).
   */
  readonly path: string;
  readonly message: string;
}

/** What the form comes to. */
export interface DraftResult {
  /** The type to save. Sent only when `issues` is empty. */
  readonly type: AuthoredMissionType;
  readonly issues: readonly DraftIssue[];
}

/** Reads the form into a mission type, and says everything wrong with it. */
export function toAuthored(draft: BuilderDraft): DraftResult {
  const issues: DraftIssue[] = [];

  const config = readSchema(draft.config, 'configSchema', issues);
  const submission = readSchema(draft.submission, 'submissionSchema', issues);

  let defaultConfig: JsonObject = config.defaults;
  if (draft.config.mode === 'json') {
    const parsed = parseObject(draft.defaultConfigText);
    if (parsed === null) {
      issues.push({ path: 'defaultConfig', message: 'This has to be a JSON object.' });
      defaultConfig = {};
    } else {
      defaultConfig = parsed;
    }
  }

  const type: AuthoredMissionType = {
    key: draft.key.trim(),
    version: draft.version.trim(),
    name: draft.name,
    description: draft.description,
    status: 'draft',
    capabilities: [...draft.capabilities],
    configSchema: config.schema,
    submissionSchema: submission.schema,
    defaultConfig,
    validationMethod: draft.validationMethod,
    defaultScoring: {
      basePoints: numberOrText(draft.basePoints) as number,
      allowPartialCredit: draft.allowPartialCredit,
      ...(draft.maxPoints.trim() === ''
        ? {}
        : { maxPoints: numberOrText(draft.maxPoints) as number }),
    },
    studentLayout: draft.layout,
  };

  // The local problems stop a schema being read at all, so the shared check
  // would only repeat them in other words. It runs once they are gone.
  if (issues.length === 0) {
    const result = validateAuthoredMissionType(type);
    if (!result.valid) {
      issues.push(...result.issues.map(({ path, message }) => ({ path, message })));
    }
  }
  return { type, issues };
}

function readSchema(
  draft: SchemaDraft,
  path: string,
  issues: DraftIssue[],
): { schema: ConfigSchema; defaults: JsonObject } {
  if (draft.mode === 'json') {
    const parsed = parseObject(draft.text);
    if (parsed === null) {
      issues.push({ path, message: 'This has to be a JSON object.' });
      return { schema: {}, defaults: {} };
    }
    return { schema: parsed as ConfigSchema, defaults: {} };
  }
  const result = schemaFromFields(draft.fields);
  for (const problem of result.problems) {
    issues.push({ path: `${path}.fields[${problem.index}].${problem.input}`, message: problem.message });
  }
  return { schema: result.schema, defaults: result.defaults };
}

/** A number when the text is one; otherwise the text, so the shared check names it. */
function numberOrText(text: string): number | string {
  const trimmed = text.trim();
  const value = Number(trimmed);
  return trimmed !== '' && Number.isFinite(value) ? value : trimmed;
}

function parseObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** The issues whose path is `path` or inside it. */
export function issuesAt(issues: readonly DraftIssue[], path: string): DraftIssue[] {
  return issues.filter(
    (issue) =>
      issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`),
  );
}
