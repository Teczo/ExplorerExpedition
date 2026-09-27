/**
 * A mission type, on its way in from the Studio (EXPD-025).
 *
 * The shape is `AuthoredMissionType` from `@explorer/shared-types`, and
 * `validateAuthoredMissionType` owns whether one is any good. This file only
 * puts that check in front of a route, in the API's error contract, and adds
 * the two rules that belong to the endpoint rather than to the type:
 *
 *   - A field the type does not have is refused, as every body here is
 *     (EXPD-016). The shared check ignores extra fields, because a coded type
 *     may carry its own; a body from a form may not.
 *   - Only a draft is saved here. `status` may be left out or be `draft`.
 *     Publishing a type is EXPD-031's, and a type saved as `published`
 *     without going through it would be frozen with nobody having decided to.
 *
 * A type is saved only when it passes. Unlike an expedition draft, a type
 * that does not pass cannot be held as a row: the registry leaves such a row
 * out (`play/mission-types.ts`), so a mission built on it could never be
 * played.
 */

import {
  validateAuthoredMissionType,
  type AuthoredMissionType,
} from '@explorer/shared-types';

import type { FieldIssue } from '../http/errors.ts';
import type { Checker, CheckResult } from '../http/validation.ts';

/** Every field an authored mission type has. */
export const AUTHORED_MISSION_TYPE_FIELDS = [
  'key',
  'version',
  'name',
  'description',
  'status',
  'capabilities',
  'configSchema',
  'submissionSchema',
  'defaultConfig',
  'validationMethod',
  'defaultScoring',
  'studentLayout',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(path: string, inner: string): string {
  if (inner === '') {
    return path;
  }
  if (path === '') {
    return inner;
  }
  return inner.startsWith('[') ? `${path}${inner}` : `${path}.${inner}`;
}

/** The checker a route puts in front of itself for a mission type. */
export function authoredMissionType(): Checker<AuthoredMissionType> {
  return {
    check(value, path): CheckResult<AuthoredMissionType> {
      if (!isPlainObject(value)) {
        return { ok: false, issues: [{ path, message: 'This has to be a mission type.' }] };
      }

      const issues: FieldIssue[] = [];
      for (const field of Object.keys(value)) {
        if (!(AUTHORED_MISSION_TYPE_FIELDS as readonly string[]).includes(field)) {
          issues.push({ path: at(path, field), message: 'A mission type has no such field.' });
        }
      }
      if (value['status'] !== undefined && value['status'] !== 'draft') {
        issues.push({
          path: at(path, 'status'),
          message: 'Only a draft is saved here. Publishing a mission type is its own step.',
        });
      }

      const draft = { ...value, status: 'draft' };
      const result = validateAuthoredMissionType(draft);
      if (!result.valid) {
        for (const issue of result.issues) {
          issues.push({ path: at(path, issue.path), message: issue.message });
        }
      }

      return issues.length === 0
        ? { ok: true, value: draft as unknown as AuthoredMissionType }
        : { ok: false, issues };
    },
  };
}
