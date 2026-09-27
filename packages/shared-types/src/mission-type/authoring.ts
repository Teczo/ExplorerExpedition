/**
 * What the Mission Type Builder (EXPD-025) adds to a mission type.
 *
 * `MissionTypeDefinition` is what the registry needs to hold a type: its key,
 * its schemas and its starting settings. An author building a type in the
 * Studio decides three more things, and none of them is the registry's
 * business:
 *
 *   1. **How it is judged by default.** The `verification` a new mission of
 *      this type starts with. An author placing one can still change it.
 *   2. **What it is worth by default.** The `scoring` a new mission of this
 *      type starts with. Rules that adjust it are EXPD-028's.
 *   3. **What the student sees.** The order the student app draws a mission
 *      of this type in, and which of the author's settings it shows.
 *
 * They are kept out of `MissionTypeDefinition` on purpose. That shape is what
 * the registry registers and what every coded type (EXPD-032 to EXPD-039)
 * writes, and none of them needs these to be judged. They are stored beside
 * it, on the same `mission_type` row (migration 0007).
 *
 * A type built in the Studio has no code, so it cannot judge work on its own.
 * `automatic` on such a type finishes a mission only when the team reaches
 * the place the mission names, and sends everything else to a teacher. That
 * is the completion interface's rule (EXPD-011), not this file's; it is
 * written here because an author choosing `automatic` should know it.
 */

import type { MissionScoring } from '../expedition/scoring.ts';
import { VERIFICATION_MODES, type VerificationMode } from '../expedition/mission.ts';
import { validateConfigSchema } from './config-schema.ts';
import { validateMissionTypeDefinition, type MissionTypeDefinition } from './definition.ts';
import {
  toMissionConfigResult,
  type MissionConfigIssue,
  type MissionConfigValidationResult,
} from './issues.ts';

/** One part of the screen a student sees for a mission of this type. */
export type StudentLayoutBlock =
  /** The short task description from the mission board. */
  | { kind: 'brief' }
  /** The full instructions the author wrote on the mission. */
  | { kind: 'instructions' }
  /** The images, audio and video the author attached to the mission. */
  | { kind: 'media' }
  /**
   * One of the type's own settings, shown to the team.
   *
   * `field` names a top-level field of the config schema. Only the fields
   * placed here are shown, so an answer kept in the config stays hidden.
   */
  | { kind: 'config-field'; field: string; heading?: string }
  /** The time left, when the mission has a time limit. */
  | { kind: 'timer' }
  /** The hints the team may open. */
  | { kind: 'hints' }
  /** Where the team hands their work in. */
  | { kind: 'submission' };

/** The `kind` of a layout block. */
export type StudentLayoutBlockKind = StudentLayoutBlock['kind'];

/** Every layout block kind, in the order the Studio offers them. */
export const STUDENT_LAYOUT_BLOCK_KINDS = [
  'brief',
  'instructions',
  'media',
  'config-field',
  'timer',
  'hints',
  'submission',
] as const satisfies readonly StudentLayoutBlockKind[];

/** How a mission of this type is drawn in the student app (EXPD-042). */
export interface StudentLayout {
  /**
   * The blocks, top to bottom. The mission title is always drawn above them.
   *
   * `submission` appears exactly once. Every other kind but `config-field`
   * appears at most once, and a config field is placed at most once.
   */
  blocks: StudentLayoutBlock[];
  /** The words on the button a team hands work in with, such as "Scan". */
  submitLabel: string;
}

/** The most blocks one layout may hold. */
export const MAX_LAYOUT_BLOCKS = 20;

/** The longest a submit label may be. It has to fit on a phone button. */
export const MAX_SUBMIT_LABEL_LENGTH = 40;

/** The longest a config field heading may be. */
export const MAX_LAYOUT_HEADING_LENGTH = 80;

/** What the Mission Type Builder decides, beyond the registry's fields. */
export interface MissionTypeAuthoring {
  /** The `verification` a new mission of this type starts with. */
  validationMethod: VerificationMode;
  /** The `scoring` a new mission of this type starts with. */
  defaultScoring: MissionScoring;
  studentLayout: StudentLayout;
}

/** A mission type as the Studio builds and stores it. */
export interface AuthoredMissionType extends MissionTypeDefinition, MissionTypeAuthoring {}

/**
 * What a type that has not been given any of the three starts with.
 *
 * The same values migration 0007 gives the columns, so a row written before
 * the builder existed reads the same as one the builder wrote.
 */
export const DEFAULT_MISSION_TYPE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'teacher',
  defaultScoring: { basePoints: 0, allowPartialCredit: false },
  studentLayout: {
    blocks: [{ kind: 'brief' }, { kind: 'instructions' }, { kind: 'submission' }],
    submitLabel: 'Submit',
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a whole mission type the Studio built.
 *
 * `validateMissionTypeDefinition` first, for everything the registry needs,
 * then the three fields above. Every issue is reported at once, each with the
 * path to the field, so the builder can put it next to the input.
 */
export function validateAuthoredMissionType(value: unknown): MissionConfigValidationResult {
  const base = validateMissionTypeDefinition(value);
  if (!isPlainObject(value)) {
    return base;
  }
  const issues: MissionConfigIssue[] = base.valid ? [] : [...base.issues];
  issues.push(...authoringIssues(value));
  return toMissionConfigResult(issues);
}

/** The issues in the three authoring fields of a type. */
function authoringIssues(type: Record<string, unknown>): MissionConfigIssue[] {
  const issues: MissionConfigIssue[] = [];

  const method = type['validationMethod'];
  if (typeof method !== 'string' || !(VERIFICATION_MODES as readonly string[]).includes(method)) {
    issues.push({
      path: 'validationMethod',
      code: 'not-allowed-value',
      message: `This has to be one of: ${VERIFICATION_MODES.join(', ')}.`,
    });
  }

  checkScoring(issues, type['defaultScoring']);
  checkLayout(issues, type['studentLayout'], topLevelFields(type['configSchema']));

  return issues;
}

/** The same rules EXPD-002 holds `MissionInstance.scoring` to. */
function checkScoring(issues: MissionConfigIssue[], value: unknown): void {
  const path = 'defaultScoring';
  if (!isPlainObject(value)) {
    issues.push({ path, code: 'not-an-object', message: 'This has to be an object.' });
    return;
  }

  for (const field of Object.keys(value)) {
    if (!['basePoints', 'allowPartialCredit', 'maxPoints'].includes(field)) {
      issues.push({
        path: `${path}.${field}`,
        code: 'unknown-field',
        message: 'Default scoring has no such field.',
      });
    }
  }

  const base = checkPoints(issues, `${path}.basePoints`, value['basePoints'], true);

  if (typeof value['allowPartialCredit'] !== 'boolean') {
    issues.push({
      path: `${path}.allowPartialCredit`,
      code: 'wrong-type',
      message: 'This has to be true or false.',
    });
  }

  const max = checkPoints(issues, `${path}.maxPoints`, value['maxPoints'], false);
  if (base !== undefined && max !== undefined && max < base) {
    issues.push({
      path: `${path}.maxPoints`,
      code: 'inconsistent',
      message: 'The most a mission can be worth cannot be less than its base points.',
    });
  }
}

/** A whole number of points, not below zero. */
function checkPoints(
  issues: MissionConfigIssue[],
  path: string,
  value: unknown,
  required: boolean,
): number | undefined {
  if (value === undefined) {
    if (required) {
      issues.push({ path, code: 'missing', message: 'This is required.' });
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, code: 'wrong-type', message: 'This has to be a number.' });
    return undefined;
  }
  if (!Number.isInteger(value)) {
    issues.push({ path, code: 'not-an-integer', message: 'Points are whole numbers.' });
    return undefined;
  }
  if (value < 0) {
    issues.push({ path, code: 'out-of-range', message: 'This cannot be below 0.' });
    return undefined;
  }
  return value;
}

/**
 * The fields a layout may place: the top-level properties of the config
 * schema. `null` when the schema is not usable, so a layout is not blamed for
 * a problem the schema check has already reported.
 */
function topLevelFields(schema: unknown): ReadonlySet<string> | null {
  const result = validateConfigSchema(schema);
  if (!result.valid) {
    return null;
  }
  return new Set(Object.keys(result.schema.properties ?? {}));
}

function checkLayout(
  issues: MissionConfigIssue[],
  value: unknown,
  fields: ReadonlySet<string> | null,
): void {
  const path = 'studentLayout';
  if (!isPlainObject(value)) {
    issues.push({ path, code: 'not-an-object', message: 'This has to be an object.' });
    return;
  }

  for (const field of Object.keys(value)) {
    if (field !== 'blocks' && field !== 'submitLabel') {
      issues.push({
        path: `${path}.${field}`,
        code: 'unknown-field',
        message: 'A layout has no such field.',
      });
    }
  }

  const label = value['submitLabel'];
  if (typeof label !== 'string') {
    issues.push({
      path: `${path}.submitLabel`,
      code: 'wrong-type',
      message: 'This has to be a string.',
    });
  } else if (label.trim() === '') {
    issues.push({
      path: `${path}.submitLabel`,
      code: 'empty-string',
      message: 'The submit button needs words on it.',
    });
  } else if (label.length > MAX_SUBMIT_LABEL_LENGTH) {
    issues.push({
      path: `${path}.submitLabel`,
      code: 'too-long',
      message: `This cannot be longer than ${MAX_SUBMIT_LABEL_LENGTH} characters.`,
    });
  }

  const blocks = value['blocks'];
  if (!Array.isArray(blocks)) {
    issues.push({ path: `${path}.blocks`, code: 'wrong-type', message: 'This has to be a list.' });
    return;
  }
  if (blocks.length > MAX_LAYOUT_BLOCKS) {
    issues.push({
      path: `${path}.blocks`,
      code: 'too-long',
      message: `A layout cannot hold more than ${MAX_LAYOUT_BLOCKS} blocks.`,
    });
    return;
  }

  const seenKinds = new Set<string>();
  const seenFields = new Set<string>();
  let submissions = 0;

  blocks.forEach((block, index) => {
    const at = `${path}.blocks[${index}]`;
    if (!isPlainObject(block)) {
      issues.push({ path: at, code: 'not-an-object', message: 'This has to be an object.' });
      return;
    }
    const kind = block['kind'];
    if (
      typeof kind !== 'string' ||
      !(STUDENT_LAYOUT_BLOCK_KINDS as readonly string[]).includes(kind)
    ) {
      issues.push({
        path: `${at}.kind`,
        code: 'not-allowed-value',
        message: `This has to be one of: ${STUDENT_LAYOUT_BLOCK_KINDS.join(', ')}.`,
      });
      return;
    }

    const allowed = kind === 'config-field' ? ['kind', 'field', 'heading'] : ['kind'];
    for (const field of Object.keys(block)) {
      if (!allowed.includes(field)) {
        issues.push({
          path: `${at}.${field}`,
          code: 'unknown-field',
          message: `A "${kind}" block has no such field.`,
        });
      }
    }

    if (kind === 'config-field') {
      checkFieldBlock(issues, at, block, fields, seenFields);
      return;
    }
    if (kind === 'submission') {
      submissions += 1;
    }
    if (seenKinds.has(kind)) {
      issues.push({
        path: `${at}.kind`,
        code: 'duplicate-item',
        message: `A layout shows "${kind}" once.`,
      });
    }
    seenKinds.add(kind);
  });

  if (submissions === 0) {
    issues.push({
      path: `${path}.blocks`,
      code: 'missing',
      message: 'A layout needs a "submission" block, or a team has nowhere to hand work in.',
    });
  }
}

function checkFieldBlock(
  issues: MissionConfigIssue[],
  at: string,
  block: Record<string, unknown>,
  fields: ReadonlySet<string> | null,
  seen: Set<string>,
): void {
  const field = block['field'];
  if (typeof field !== 'string' || field === '') {
    issues.push({
      path: `${at}.field`,
      code: 'missing',
      message: 'Name the setting this block shows.',
    });
  } else {
    if (fields !== null && !fields.has(field)) {
      issues.push({
        path: `${at}.field`,
        code: 'inconsistent',
        message: `The config schema has no top-level field "${field}".`,
      });
    }
    if (seen.has(field)) {
      issues.push({
        path: `${at}.field`,
        code: 'duplicate-item',
        message: `"${field}" is already placed in this layout.`,
      });
    }
    seen.add(field);
  }

  const heading = block['heading'];
  if (heading === undefined) {
    return;
  }
  if (typeof heading !== 'string') {
    issues.push({ path: `${at}.heading`, code: 'wrong-type', message: 'This has to be a string.' });
  } else if (heading.length > MAX_LAYOUT_HEADING_LENGTH) {
    issues.push({
      path: `${at}.heading`,
      code: 'too-long',
      message: `This cannot be longer than ${MAX_LAYOUT_HEADING_LENGTH} characters.`,
    });
  }
}
