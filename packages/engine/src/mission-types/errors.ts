/**
 * What goes wrong in the mission type registry.
 *
 * Both errors here are programming mistakes rather than bad requests. A
 * registration that fails means a mission type was built wrong, which is
 * caught the moment the process starts rather than on the day a class plays.
 * A lookup that fails means the engine was handed an expedition nobody
 * checked, and the check that should have caught it is
 * `MissionTypeRegistry.validateExpedition`.
 */

import type { MissionConfigIssue } from '@explorer/shared-types';

/** A mission type was offered to the registry and could not be accepted. */
export class MissionTypeRegistrationError extends Error {
  override readonly name = 'MissionTypeRegistrationError';

  /** The type as it was offered, written `key@version` when that much was readable. */
  readonly ref: string;

  /** Everything wrong with it. Empty when the problem was not the shape. */
  readonly issues: readonly MissionConfigIssue[];

  constructor(ref: string, message: string, issues: readonly MissionConfigIssue[] = []) {
    const detail = issues
      .map((issue) => `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
      .join('\n');
    super(detail === '' ? message : `${message}\n${detail}`);
    this.ref = ref;
    this.issues = issues;
  }
}

/** Something asked the registry for a mission type it does not hold. */
export class MissionTypeNotRegisteredError extends Error {
  override readonly name = 'MissionTypeNotRegisteredError';

  /** The key that was asked for. */
  readonly key: string;

  /** The version that was asked for. */
  readonly version: string;

  constructor(key: string, version: string, known: readonly string[]) {
    const listed =
      known.length === 0
        ? 'The registry holds no mission types at all.'
        : `The registry holds: ${known.join(', ')}.`;
    super(`No mission type "${key}@${version}" is registered. ${listed}`);
    this.key = key;
    this.version = version;
  }
}
