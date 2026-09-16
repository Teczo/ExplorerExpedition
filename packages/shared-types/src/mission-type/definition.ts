/**
 * What one mission type is.
 *
 * A *mission type* is the kind of task — scan a QR code, take a photo, solve
 * a puzzle. A *mission instance* (EXPD-002) is one use of a type inside one
 * expedition. This file describes the first of those two.
 *
 * The shape here is the `mission_type` row from migration 0001 and nothing
 * more, on purpose. A mission type has two homes:
 *
 *   - Built into the platform, as code that also brings runtime behaviour
 *     (EXPD-032 to EXPD-039).
 *   - Built by an organisation in the Studio (EXPD-025), where there is no
 *     code at all — only a row.
 *
 * Both have to be describable, so everything a type says about itself before
 * it runs has to fit in a row. Behaviour is the part that cannot, and it
 * lives in the engine rather than here.
 */

import type { JsonObject } from '../expedition/common.ts';
import { parseSchemaVersion } from '../expedition/version.ts';
import type { MissionCapability } from './capabilities.ts';
import { isMissionCapability, MISSION_CAPABILITIES } from './capabilities.ts';
import {
  validateConfigSchema,
  type ConfigSchema,
} from './config-schema.ts';
import {
  toMissionConfigResult,
  type MissionConfigIssue,
  type MissionConfigValidationResult,
} from './issues.ts';
import { validateAgainstSchema } from './validate-config.ts';

/**
 * The key an expedition pins to, such as `qr-hunt`.
 *
 * It is the `missionTypeId` on an EXPD-002 `MissionInstance` and the
 * `type_key` column on a `mission_type` row.
 */
export type MissionTypeKey = string;

/** Where a mission type is in its life. Matches the `mission_type_status` enum. */
export type MissionTypeStatus =
  /** Being built. It may be used inside the organisation that owns it. */
  | 'draft'
  /** Finished. Expeditions may pin to it, and it will never change again. */
  | 'published'
  /** Superseded. Existing expeditions keep working; new ones should not use it. */
  | 'deprecated';

/** Every mission type status. */
export const MISSION_TYPE_STATUSES = [
  'draft',
  'published',
  'deprecated',
] as const satisfies readonly MissionTypeStatus[];

/**
 * The shape a mission type key has to take.
 *
 * Lower-case words joined by single hyphens: `qr-hunt`, `photo-evidence`.
 * The same expression the `mission_type.type_key` column checks, so a key the
 * registry accepts is a key the database will store.
 */
export const MISSION_TYPE_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Says whether a string is a well-formed mission type key. */
export function isMissionTypeKey(value: unknown): value is MissionTypeKey {
  return typeof value === 'string' && MISSION_TYPE_KEY_PATTERN.test(value);
}

/**
 * One mission type, as everything but the engine sees it.
 *
 * Every field maps to a `mission_type` column. `organisation_id`,
 * `created_by` and the timestamps are not here, because they say where the
 * row came from rather than what the type is, and the registry does not care.
 */
export interface MissionTypeDefinition {
  /** The key an expedition pins to. */
  key: MissionTypeKey;
  /**
   * The version an expedition pins to, as three dot-separated numbers.
   *
   * A published type is never edited. A change is a new version, so that an
   * expedition pinned to the old one keeps playing exactly as it did.
   */
  version: string;
  /** The name shown in the Studio's mission palette. */
  name: string;
  /** One or two sentences saying what an author would use this type for. */
  description: string;
  status: MissionTypeStatus;
  /** What this type needs from the student's device. May be empty. */
  capabilities: readonly MissionCapability[];
  /** The shape of `MissionInstance.config` for this type. */
  configSchema: ConfigSchema;
  /** The shape of a submission payload for this type. */
  submissionSchema: ConfigSchema;
  /** What a new mission of this type starts out with in the Studio. */
  defaultConfig: JsonObject;
}

/**
 * Writes a key and a version the way the platform says one out loud.
 *
 * `qr-hunt@1.2.0`. Used in error messages and as the registry's own index,
 * so that two versions of a type are two entries and never one.
 */
export function missionTypeRef(key: MissionTypeKey, version: string): string {
  return `${key}@${version}`;
}

/**
 * Checks that an unknown value is a mission type this platform can run.
 *
 * The registry calls this before it accepts a type, and the API will call it
 * before it stores a row the Studio built (EXPD-025). It checks four things
 * the database cannot:
 *
 *   1. Both schemas are schemas the platform runs, keyword by keyword.
 *   2. `defaultConfig` passes `configSchema`. A type whose own starting
 *      settings are invalid hands every author a broken mission.
 *   3. Capabilities are words from the closed list.
 *   4. The key and the version are shaped the way the columns require, so a
 *      type the registry accepts is one the database will take.
 */
export function validateMissionTypeDefinition(
  value: unknown,
): MissionConfigValidationResult {
  const issues: MissionConfigIssue[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      issues: [
        { path: '', code: 'not-an-object', message: 'A mission type has to be an object.' },
      ],
    };
  }
  const type = value as Record<string, unknown>;

  if (typeof type['key'] !== 'string') {
    issues.push({ path: 'key', code: 'missing', message: 'A mission type needs a key.' });
  } else if (!MISSION_TYPE_KEY_PATTERN.test(type['key'])) {
    issues.push({
      path: 'key',
      code: 'pattern-mismatch',
      message:
        'A key is lower-case words joined by single hyphens, such as "qr-hunt".',
    });
  }

  if (typeof type['version'] !== 'string') {
    issues.push({
      path: 'version',
      code: 'missing',
      message: 'A mission type needs a version.',
    });
  } else if (parseSchemaVersion(type['version']) === null) {
    // The same three-number rule the Expedition Definition schema uses, and
    // the same one `mission_type.version` checks.
    issues.push({
      path: 'version',
      code: 'pattern-mismatch',
      message: 'A version is three dot-separated whole numbers, such as "1.0.0".',
    });
  }

  if (typeof type['name'] !== 'string' || type['name'].trim() === '') {
    issues.push({
      path: 'name',
      code: 'empty-string',
      message: 'A mission type needs a name an author can recognise.',
    });
  }

  if (typeof type['description'] !== 'string') {
    issues.push({
      path: 'description',
      code: 'wrong-type',
      message: 'This has to be a string. Use "" when there is nothing to say yet.',
    });
  }

  if (
    typeof type['status'] !== 'string' ||
    !(MISSION_TYPE_STATUSES as readonly string[]).includes(type['status'])
  ) {
    issues.push({
      path: 'status',
      code: 'not-allowed-value',
      message: `This has to be one of: ${MISSION_TYPE_STATUSES.join(', ')}.`,
    });
  }

  if (!Array.isArray(type['capabilities'])) {
    issues.push({
      path: 'capabilities',
      code: 'wrong-type',
      message: 'This has to be a list. Use [] when the type needs nothing special.',
    });
  } else {
    const seen = new Set<string>();
    type['capabilities'].forEach((entry, index) => {
      if (!isMissionCapability(entry)) {
        issues.push({
          path: `capabilities[${index}]`,
          code: 'not-allowed-value',
          message: `This has to be one of: ${MISSION_CAPABILITIES.join(', ')}.`,
        });
        return;
      }
      if (seen.has(entry)) {
        issues.push({
          path: `capabilities[${index}]`,
          code: 'duplicate-item',
          message: `"${entry}" is listed twice.`,
        });
        return;
      }
      seen.add(entry);
    });
  }

  const configSchema = checkSchemaField(issues, 'configSchema', type['configSchema']);
  checkSchemaField(issues, 'submissionSchema', type['submissionSchema']);

  if (
    typeof type['defaultConfig'] !== 'object' ||
    type['defaultConfig'] === null ||
    Array.isArray(type['defaultConfig'])
  ) {
    issues.push({
      path: 'defaultConfig',
      code: 'not-an-object',
      message: 'This has to be an object. Use {} when there is nothing to start with.',
    });
  } else if (configSchema !== null) {
    const result = validateAgainstSchema(configSchema, type['defaultConfig'], {
      path: 'defaultConfig',
    });
    if (!result.valid) {
      issues.push(...result.issues);
    }
  }

  return toMissionConfigResult(issues);
}

/** Checks one of the two schema fields, and returns it when it is usable. */
function checkSchemaField(
  issues: MissionConfigIssue[],
  field: string,
  value: unknown,
): ConfigSchema | null {
  if (value === undefined) {
    issues.push({
      path: field,
      code: 'missing',
      message: 'This is required. Use {} to accept any shape.',
    });
    return null;
  }
  const result = validateConfigSchema(value);
  if (!result.valid) {
    for (const issue of result.issues) {
      issues.push({ ...issue, path: joinSchemaPath(field, issue.path) });
    }
    return null;
  }
  return result.schema;
}

/**
 * Puts a field name in front of a path reported inside that field's schema.
 *
 * A path can start with a bracket, because `childPath` writes a field name
 * that is not a plain identifier as `["two words"]`. Joining that with a dot
 * would produce a path no form could match up with a field.
 */
function joinSchemaPath(field: string, inner: string): string {
  if (inner === '') {
    return field;
  }
  return inner.startsWith('[') ? `${field}${inner}` : `${field}.${inner}`;
}
