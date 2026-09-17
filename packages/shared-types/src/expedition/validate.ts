/**
 * Checking that an unknown value really is an Expedition Definition.
 *
 * The types in this folder describe the contract, but types vanish once the
 * code runs. Anything arriving from outside the process — a request body, a
 * row read back from the database, a document the AI builder generated — has
 * to be checked before it is trusted.
 *
 * This validator checks the shape of the document and the way its parts refer
 * to each other. It does not check two things on purpose:
 *
 *   1. `MissionInstance.config`, because only the mission type knows the right
 *      shape for it (EXPD-009).
 *   2. Whether an expedition is any *good*. A dull expedition is still a valid
 *      one. Simulating a run is EXPD-015.
 *
 * It is written by hand and pulls in no library, so the contract can be
 * checked anywhere the types can be imported, the student app included.
 */

import {
  MEDIA_KINDS,
  POOR_ACCURACY_ACTIONS,
} from './common.ts';
import { EXPEDITION_STATUSES, type ExpeditionDefinition } from './definition.ts';
import {
  EDGE_AUDIENCE_KINDS,
  EXPEDITION_NODE_KINDS,
  UNLOCK_CONDITION_TYPES,
  type ExpeditionNode,
} from './graph.ts';
import { AUTHORING_SOURCES, EXPEDITION_SETTINGS } from './metadata.ts';
import { VERIFICATION_MODES } from './mission.ts';
import {
  END_MODES,
  LATE_SUBMISSION_POLICIES,
  PROGRESSION_MODES,
  START_MODES,
} from './rules.ts';
import {
  LEADERBOARD_TIE_BREAKS,
  LEADERBOARD_VISIBILITIES,
  SCORING_RULE_TYPES,
} from './scoring.ts';
import { isReadableSchemaVersion } from './version.ts';

/** What kind of problem was found. */
export type ValidationIssueCode =
  /** A value that had to be an object was not one. */
  | 'not-an-object'
  /** A required field was absent. */
  | 'missing'
  /** A field held the wrong kind of value. */
  | 'wrong-type'
  /** A string that had to hold something was empty. */
  | 'empty-string'
  /** A number that had to be whole was not. */
  | 'not-an-integer'
  /** A number fell outside the range the schema allows. */
  | 'out-of-range'
  /** A value was not one of the values the schema lists. */
  | 'not-allowed-value'
  /** Two things shared an id that has to be unique. */
  | 'duplicate-id'
  /** Something pointed at an id that is not in the document. */
  | 'unknown-reference'
  /** A mission exists but no node uses it. */
  | 'unused-mission'
  /** The graph breaks a rule about starts, finishes or edges. */
  | 'graph-shape'
  /** A node cannot be reached from the start node. */
  | 'unreachable-node'
  /** The graph loops back on itself, so progress could never be made. */
  | 'cycle'
  /** The document was written against a schema version we cannot read. */
  | 'unsupported-schema-version'
  /** Two fields that have to agree did not. */
  | 'inconsistent'
  /** A nested structure was nested more deeply than the schema allows. */
  | 'too-deep';

/** One problem found in a document. */
export interface ValidationIssue {
  /**
   * Where the problem is, written the way the field would be reached in code.
   *
   * Example: `graph.edges[3].condition.missionInstanceId`. The Studio uses
   * this to put the error next to the field the author has to fix.
   */
  path: string;
  code: ValidationIssueCode;
  /** A sentence a person can read. */
  message: string;
}

/** What came back from checking a document. */
export type ValidationResult =
  | {
      valid: true;
      /** The same value, now safe to treat as an ExpeditionDefinition. */
      definition: ExpeditionDefinition;
    }
  | {
      valid: false;
      /** Every problem found, in the order the document was walked. */
      issues: ValidationIssue[];
    };

/**
 * How deeply unlock conditions may nest.
 *
 * The limit exists so that a hand-written or generated document cannot make
 * the validator recurse without end.
 */
export const MAX_UNLOCK_CONDITION_DEPTH = 10;

/** Collects problems as the document is walked. */
interface Context {
  issues: ValidationIssue[];
}

function report(
  ctx: Context,
  path: string,
  code: ValidationIssueCode,
  message: string,
): void {
  ctx.issues.push({ path, code, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/**
 * Checks that a field is an object, reporting a problem when it is not.
 *
 * Returns the object, or `null` when there was nothing usable to walk into.
 */
function readObject(
  ctx: Context,
  path: string,
  value: unknown,
  required: boolean,
): Record<string, unknown> | null {
  if (value === undefined) {
    if (required) {
      report(ctx, path, 'missing', 'This section is required.');
    }
    return null;
  }
  if (!isPlainObject(value)) {
    report(ctx, path, 'not-an-object', 'This has to be an object.');
    return null;
  }
  return value;
}

/** Checks that a field is an array. Returns it, or `null`. */
function readArray(
  ctx: Context,
  path: string,
  value: unknown,
  required: boolean,
): unknown[] | null {
  if (value === undefined) {
    if (required) {
      report(ctx, path, 'missing', 'This list is required.');
    }
    return null;
  }
  if (!Array.isArray(value)) {
    report(ctx, path, 'wrong-type', 'This has to be a list.');
    return null;
  }
  return value;
}

interface StringOptions {
  required: boolean;
  /** When true an empty string is accepted. Defaults to false. */
  allowEmpty?: boolean;
}

/** Checks that a field is a string. Returns it, or `undefined`. */
function readString(
  ctx: Context,
  path: string,
  value: unknown,
  options: StringOptions,
): string | undefined {
  if (value === undefined) {
    if (options.required) {
      report(ctx, path, 'missing', 'This field is required.');
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    report(ctx, path, 'wrong-type', 'This has to be a string.');
    return undefined;
  }
  if (value.trim() === '' && options.allowEmpty !== true) {
    report(ctx, path, 'empty-string', 'This cannot be empty.');
    return undefined;
  }
  return value;
}

interface NumberOptions {
  required: boolean;
  /** The smallest value allowed. */
  min?: number;
  /** The largest value allowed. */
  max?: number;
}

/** Checks that a field is a whole number in range. Returns it, or `undefined`. */
function readInteger(
  ctx: Context,
  path: string,
  value: unknown,
  options: NumberOptions,
): number | undefined {
  if (value === undefined) {
    if (options.required) {
      report(ctx, path, 'missing', 'This field is required.');
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    report(ctx, path, 'wrong-type', 'This has to be a number.');
    return undefined;
  }
  if (!Number.isInteger(value)) {
    report(ctx, path, 'not-an-integer', 'This has to be a whole number.');
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    report(ctx, path, 'out-of-range', `This cannot be below ${options.min}.`);
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    report(ctx, path, 'out-of-range', `This cannot be above ${options.max}.`);
    return undefined;
  }
  return value;
}

/** Checks that a field is a number in range, whole or not. */
function readNumber(
  ctx: Context,
  path: string,
  value: unknown,
  options: NumberOptions,
): number | undefined {
  if (value === undefined) {
    if (options.required) {
      report(ctx, path, 'missing', 'This field is required.');
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    report(ctx, path, 'wrong-type', 'This has to be a number.');
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    report(ctx, path, 'out-of-range', `This cannot be below ${options.min}.`);
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    report(ctx, path, 'out-of-range', `This cannot be above ${options.max}.`);
    return undefined;
  }
  return value;
}

/** Checks that a field is a boolean. */
function readBoolean(
  ctx: Context,
  path: string,
  value: unknown,
  required: boolean,
): boolean | undefined {
  if (value === undefined) {
    if (required) {
      report(ctx, path, 'missing', 'This field is required.');
    }
    return undefined;
  }
  if (typeof value !== 'boolean') {
    report(ctx, path, 'wrong-type', 'This has to be true or false.');
    return undefined;
  }
  return value;
}

/** Checks that a field holds one of a fixed set of strings. */
function readEnum<T extends string>(
  ctx: Context,
  path: string,
  value: unknown,
  allowed: readonly T[],
  required: boolean,
): T | undefined {
  if (value === undefined) {
    if (required) {
      report(ctx, path, 'missing', 'This field is required.');
    }
    return undefined;
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    report(
      ctx,
      path,
      'not-allowed-value',
      `This has to be one of: ${allowed.join(', ')}.`,
    );
    return undefined;
  }
  return value as T;
}

/** Checks that a field is a list of non-empty strings. */
function readStringList(
  ctx: Context,
  path: string,
  value: unknown,
  required: boolean,
): string[] {
  const list = readArray(ctx, path, value, required);
  if (list === null) {
    return [];
  }
  const result: string[] = [];
  list.forEach((entry, index) => {
    const text = readString(ctx, `${path}[${index}]`, entry, { required: true });
    if (text !== undefined) {
      result.push(text);
    }
  });
  return result;
}

/** Matches an ISO 8601 instant in UTC, as `IsoTimestamp` describes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Checks that a field is an ISO 8601 UTC timestamp. */
function readTimestamp(
  ctx: Context,
  path: string,
  value: unknown,
  required: boolean,
): string | undefined {
  const text = readString(ctx, path, value, { required });
  if (text === undefined) {
    return undefined;
  }
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    report(
      ctx,
      path,
      'wrong-type',
      'This has to be an ISO 8601 time in UTC, such as 2026-09-11T14:03:00Z.',
    );
    return undefined;
  }
  return text;
}

/** Checks a `{ min, max }` pair where both ends are whole numbers. */
function readIntRange(
  ctx: Context,
  path: string,
  value: unknown,
  options: { required: boolean; min?: number },
): void {
  const range = readObject(ctx, path, value, options.required);
  if (range === null) {
    return;
  }
  const min = readInteger(ctx, `${path}.min`, range['min'], {
    required: true,
    min: options.min,
  });
  const max = readInteger(ctx, `${path}.max`, range['max'], {
    required: true,
    min: options.min,
  });
  if (min !== undefined && max !== undefined && min > max) {
    report(ctx, `${path}.max`, 'inconsistent', 'The maximum is below the minimum.');
  }
}

/** Checks one reference to a media file. */
function validateMediaRef(ctx: Context, path: string, value: unknown): void {
  const media = readObject(ctx, path, value, true);
  if (media === null) {
    return;
  }
  readString(ctx, `${path}.mediaId`, media['mediaId'], { required: true });
  readEnum(ctx, `${path}.kind`, media['kind'], MEDIA_KINDS, true);
  if (media['altText'] !== undefined) {
    readString(ctx, `${path}.altText`, media['altText'], { required: false });
  }
}

/** Checks one point on the earth. */
function validateGeoPoint(ctx: Context, path: string, value: unknown): void {
  const point = readObject(ctx, path, value, true);
  if (point === null) {
    return;
  }
  readNumber(ctx, `${path}.latitude`, point['latitude'], {
    required: true,
    min: -90,
    max: 90,
  });
  readNumber(ctx, `${path}.longitude`, point['longitude'], {
    required: true,
    min: -180,
    max: 180,
  });
}

/** Checks where a team has to be. */
function validateLocationConstraint(
  ctx: Context,
  path: string,
  value: unknown,
): void {
  const constraint = readObject(ctx, path, value, true);
  if (constraint === null) {
    return;
  }
  const area = readObject(ctx, `${path}.area`, constraint['area'], true);
  if (area !== null) {
    validateGeoPoint(ctx, `${path}.area.centre`, area['centre']);
    readNumber(ctx, `${path}.area.radiusMetres`, area['radiusMetres'], {
      required: true,
      min: 1,
    });
  }
  readEnum(
    ctx,
    `${path}.onPoorAccuracy`,
    constraint['onPoorAccuracy'],
    POOR_ACCURACY_ACTIONS,
    true,
  );
}

/** Checks the descriptive part of an expedition. */
function validateMetadata(ctx: Context, path: string, value: unknown): void {
  const metadata = readObject(ctx, path, value, true);
  if (metadata === null) {
    return;
  }

  readString(ctx, `${path}.title`, metadata['title'], { required: true });
  readString(ctx, `${path}.summary`, metadata['summary'], { required: true });
  if (metadata['description'] !== undefined) {
    readString(ctx, `${path}.description`, metadata['description'], {
      required: false,
    });
  }

  const locale = readString(ctx, `${path}.locale`, metadata['locale'], {
    required: true,
  });
  if (locale !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    report(
      ctx,
      `${path}.locale`,
      'wrong-type',
      'This has to be a language tag such as en-GB.',
    );
  }

  readIntRange(ctx, `${path}.ageRange`, metadata['ageRange'], {
    required: true,
    min: 0,
  });
  readIntRange(
    ctx,
    `${path}.expectedDurationMinutes`,
    metadata['expectedDurationMinutes'],
    { required: true, min: 1 },
  );
  readStringList(ctx, `${path}.subjects`, metadata['subjects'], true);
  readStringList(ctx, `${path}.tags`, metadata['tags'], true);
  readEnum(ctx, `${path}.setting`, metadata['setting'], EXPEDITION_SETTINGS, true);

  if (metadata['coverMedia'] !== undefined) {
    validateMediaRef(ctx, `${path}.coverMedia`, metadata['coverMedia']);
  }

  const authoring = readObject(
    ctx,
    `${path}.authoring`,
    metadata['authoring'],
    true,
  );
  if (authoring !== null) {
    const authoringPath = `${path}.authoring`;
    readString(ctx, `${authoringPath}.organisationId`, authoring['organisationId'], {
      required: true,
    });
    readString(ctx, `${authoringPath}.createdBy`, authoring['createdBy'], {
      required: true,
    });
    readString(ctx, `${authoringPath}.updatedBy`, authoring['updatedBy'], {
      required: true,
    });
    const createdAt = readTimestamp(
      ctx,
      `${authoringPath}.createdAt`,
      authoring['createdAt'],
      true,
    );
    const updatedAt = readTimestamp(
      ctx,
      `${authoringPath}.updatedAt`,
      authoring['updatedAt'],
      true,
    );
    if (
      createdAt !== undefined &&
      updatedAt !== undefined &&
      Date.parse(updatedAt) < Date.parse(createdAt)
    ) {
      report(
        ctx,
        `${authoringPath}.updatedAt`,
        'inconsistent',
        'The expedition cannot have been changed before it was created.',
      );
    }
    readEnum(
      ctx,
      `${authoringPath}.source`,
      authoring['source'],
      AUTHORING_SOURCES,
      true,
    );
    if (authoring['templateId'] !== undefined) {
      readString(ctx, `${authoringPath}.templateId`, authoring['templateId'], {
        required: true,
      });
    }
  }
}

/** Checks what one mission is worth. */
function validateMissionScoring(ctx: Context, path: string, value: unknown): void {
  const scoring = readObject(ctx, path, value, true);
  if (scoring === null) {
    return;
  }
  const basePoints = readInteger(ctx, `${path}.basePoints`, scoring['basePoints'], {
    required: true,
    min: 0,
  });
  readBoolean(ctx, `${path}.allowPartialCredit`, scoring['allowPartialCredit'], true);
  if (scoring['maxPoints'] !== undefined) {
    const maxPoints = readInteger(ctx, `${path}.maxPoints`, scoring['maxPoints'], {
      required: true,
      min: 0,
    });
    if (
      basePoints !== undefined &&
      maxPoints !== undefined &&
      maxPoints < basePoints
    ) {
      report(
        ctx,
        `${path}.maxPoints`,
        'inconsistent',
        'The cap is below the points the mission always awards.',
      );
    }
  }
}

/** Checks one mission placed in the expedition. */
function validateMissionInstance(
  ctx: Context,
  path: string,
  value: unknown,
  seenIds: Set<string>,
): void {
  const mission = readObject(ctx, path, value, true);
  if (mission === null) {
    return;
  }

  const id = readString(ctx, `${path}.id`, mission['id'], { required: true });
  if (id !== undefined) {
    if (seenIds.has(id)) {
      report(ctx, `${path}.id`, 'duplicate-id', `Two missions share the id "${id}".`);
    } else {
      seenIds.add(id);
    }
  }

  readString(ctx, `${path}.missionTypeId`, mission['missionTypeId'], {
    required: true,
  });
  readString(ctx, `${path}.missionTypeVersion`, mission['missionTypeVersion'], {
    required: true,
  });
  readString(ctx, `${path}.title`, mission['title'], { required: true });
  readString(ctx, `${path}.brief`, mission['brief'], { required: true });
  if (mission['instructions'] !== undefined) {
    readString(ctx, `${path}.instructions`, mission['instructions'], {
      required: false,
    });
  }

  // The mission type owns the shape of `config` (EXPD-009). All this document
  // can say is that it is an object.
  readObject(ctx, `${path}.config`, mission['config'], true);

  validateMissionScoring(ctx, `${path}.scoring`, mission['scoring']);

  const attempts = readObject(ctx, `${path}.attempts`, mission['attempts'], true);
  if (attempts !== null) {
    const maxAttempts = attempts['maxAttempts'];
    if (maxAttempts === undefined) {
      report(ctx, `${path}.attempts.maxAttempts`, 'missing', 'This field is required.');
    } else if (maxAttempts !== null) {
      readInteger(ctx, `${path}.attempts.maxAttempts`, maxAttempts, {
        required: true,
        min: 1,
      });
    }
    if (attempts['cooldownSeconds'] !== undefined) {
      readInteger(
        ctx,
        `${path}.attempts.cooldownSeconds`,
        attempts['cooldownSeconds'],
        { required: true, min: 0 },
      );
    }
  }

  if (mission['timeLimitSeconds'] !== undefined) {
    readInteger(ctx, `${path}.timeLimitSeconds`, mission['timeLimitSeconds'], {
      required: true,
      min: 1,
    });
  }

  readEnum(
    ctx,
    `${path}.verification`,
    mission['verification'],
    VERIFICATION_MODES,
    true,
  );

  const hints = readArray(ctx, `${path}.hints`, mission['hints'], true);
  if (hints !== null) {
    const hintIds = new Set<string>();
    const hintOrders = new Set<number>();
    hints.forEach((entry, index) => {
      const hintPath = `${path}.hints[${index}]`;
      const hint = readObject(ctx, hintPath, entry, true);
      if (hint === null) {
        return;
      }
      const hintId = readString(ctx, `${hintPath}.id`, hint['id'], {
        required: true,
      });
      if (hintId !== undefined) {
        if (hintIds.has(hintId)) {
          report(
            ctx,
            `${hintPath}.id`,
            'duplicate-id',
            `Two hints on this mission share the id "${hintId}".`,
          );
        } else {
          hintIds.add(hintId);
        }
      }
      readString(ctx, `${hintPath}.text`, hint['text'], { required: true });
      const order = readInteger(ctx, `${hintPath}.order`, hint['order'], {
        required: true,
        min: 0,
      });
      if (order !== undefined) {
        if (hintOrders.has(order)) {
          report(
            ctx,
            `${hintPath}.order`,
            'inconsistent',
            `Two hints on this mission are both at order ${order}.`,
          );
        } else {
          hintOrders.add(order);
        }
      }
      readInteger(ctx, `${hintPath}.tokenCost`, hint['tokenCost'], {
        required: true,
        min: 0,
      });
    });
  }

  const media = readArray(ctx, `${path}.media`, mission['media'], true);
  if (media !== null) {
    media.forEach((entry, index) => {
      validateMediaRef(ctx, `${path}.media[${index}]`, entry);
    });
  }

  if (mission['location'] !== undefined) {
    validateLocationConstraint(ctx, `${path}.location`, mission['location']);
  }
}

/**
 * Checks one unlock condition, and every condition nested inside it.
 *
 * `missionIds` holds every mission id in the document, so a condition that
 * names a mission that was deleted is caught here.
 */
function validateUnlockCondition(
  ctx: Context,
  path: string,
  value: unknown,
  missionIds: Set<string>,
  depth: number,
): void {
  if (depth > MAX_UNLOCK_CONDITION_DEPTH) {
    report(
      ctx,
      path,
      'too-deep',
      `Conditions cannot nest more than ${MAX_UNLOCK_CONDITION_DEPTH} deep.`,
    );
    return;
  }

  const condition = readObject(ctx, path, value, true);
  if (condition === null) {
    return;
  }

  const type = readEnum(
    ctx,
    `${path}.type`,
    condition['type'],
    UNLOCK_CONDITION_TYPES,
    true,
  );
  if (type === undefined) {
    return;
  }

  /** Checks that a named mission is really in the document. */
  const checkMissionRef = (field: string): void => {
    const missionId = readString(ctx, `${path}.${field}`, condition[field], {
      required: true,
    });
    if (missionId !== undefined && !missionIds.has(missionId)) {
      report(
        ctx,
        `${path}.${field}`,
        'unknown-reference',
        `No mission in this expedition has the id "${missionId}".`,
      );
    }
  };

  switch (type) {
    case 'always':
      break;

    case 'mission-completed':
      checkMissionRef('missionInstanceId');
      break;

    case 'mission-score-at-least':
      checkMissionRef('missionInstanceId');
      readInteger(ctx, `${path}.points`, condition['points'], {
        required: true,
        min: 0,
      });
      break;

    case 'total-score-at-least':
      readInteger(ctx, `${path}.points`, condition['points'], {
        required: true,
        min: 0,
      });
      break;

    case 'missions-completed-at-least': {
      const count = readInteger(ctx, `${path}.count`, condition['count'], {
        required: true,
        min: 1,
      });
      const ids = readArray(
        ctx,
        `${path}.missionInstanceIds`,
        condition['missionInstanceIds'],
        true,
      );
      if (ids !== null) {
        ids.forEach((entry, index) => {
          const missionId = readString(
            ctx,
            `${path}.missionInstanceIds[${index}]`,
            entry,
            { required: true },
          );
          if (missionId !== undefined && !missionIds.has(missionId)) {
            report(
              ctx,
              `${path}.missionInstanceIds[${index}]`,
              'unknown-reference',
              `No mission in this expedition has the id "${missionId}".`,
            );
          }
        });
        if (count !== undefined && ids.length < count) {
          report(
            ctx,
            `${path}.count`,
            'inconsistent',
            `This asks for ${count} missions but only lists ${ids.length}.`,
          );
        }
      }
      break;
    }

    case 'elapsed-time-at-least':
      readInteger(ctx, `${path}.seconds`, condition['seconds'], {
        required: true,
        min: 1,
      });
      break;

    case 'all-of':
    case 'any-of': {
      const nested = readArray(ctx, `${path}.conditions`, condition['conditions'], true);
      if (nested !== null) {
        nested.forEach((entry, index) => {
          validateUnlockCondition(
            ctx,
            `${path}.conditions[${index}]`,
            entry,
            missionIds,
            depth + 1,
          );
        });
      }
      break;
    }

    case 'not':
      validateUnlockCondition(
        ctx,
        `${path}.condition`,
        condition['condition'],
        missionIds,
        depth + 1,
      );
      break;
  }
}

/**
 * Checks which teams an edge is for.
 *
 * `routeIds` holds every route the expedition's rules declare, so an edge
 * naming a route that was deleted is caught here. The routes themselves are
 * checked in `validateRules`; this only checks that the edge names ones that
 * exist.
 */
function validateEdgeAudience(
  ctx: Context,
  path: string,
  value: unknown,
  routeIds: Set<string>,
): void {
  const audience = readObject(ctx, path, value, true);
  if (audience === null) {
    return;
  }

  const kind = readEnum(
    ctx,
    `${path}.kind`,
    audience['kind'],
    EDGE_AUDIENCE_KINDS,
    true,
  );
  if (kind !== 'routes') {
    return;
  }

  const ids = readArray(ctx, `${path}.routeIds`, audience['routeIds'], true);
  if (ids === null) {
    return;
  }
  if (ids.length === 0) {
    report(
      ctx,
      `${path}.routeIds`,
      'out-of-range',
      'An edge for no route is an edge no team can take. Delete it instead.',
    );
  }

  const seen = new Set<string>();
  ids.forEach((entry, index) => {
    const routeId = readString(ctx, `${path}.routeIds[${index}]`, entry, {
      required: true,
    });
    if (routeId === undefined) {
      return;
    }
    if (!routeIds.has(routeId)) {
      report(
        ctx,
        `${path}.routeIds[${index}]`,
        'unknown-reference',
        `No route in this expedition has the id "${routeId}".`,
      );
    }
    if (seen.has(routeId)) {
      report(
        ctx,
        `${path}.routeIds[${index}]`,
        'inconsistent',
        `The route "${routeId}" is named twice on this edge.`,
      );
    } else {
      seen.add(routeId);
    }
  });
}

/**
 * The route ids the rules declare, read without reporting on them.
 *
 * The graph is walked before the rules, because a node pointing at a missing
 * mission is a more useful thing to hear about first, and the order issues
 * come back in is the order the document is walked. An edge still has to be
 * told whether the route it names exists, so the ids are picked up ahead of
 * time here. Anything wrong with the routes themselves is reported once, by
 * `validateRules`.
 */
function declaredRouteIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(value)) {
    return ids;
  }
  const routes = value['routes'];
  if (!Array.isArray(routes)) {
    return ids;
  }
  for (const route of routes) {
    if (isPlainObject(route) && typeof route['id'] === 'string' && route['id'] !== '') {
      ids.add(route['id']);
    }
  }
  return ids;
}

/** What the graph check learned about one node, used by the later checks. */
interface NodeSummary {
  id: string;
  kind: ExpeditionNode['kind'] | undefined;
}

/**
 * Checks the stops and the links between them.
 *
 * This runs after the missions have been walked, so `missionIds` is complete
 * and a node pointing at a mission that is not there can be caught.
 *
 * `usedMissionIds` is filled in as mission nodes are read, so that the caller
 * can report missions that no node uses.
 *
 * `routeIds` holds every route the expedition declares, so that an edge for
 * a route that is not there can be caught.
 */
function validateGraph(
  ctx: Context,
  path: string,
  value: unknown,
  missionIds: Set<string>,
  usedMissionIds: Set<string>,
  routeIds: Set<string>,
): void {
  const graph = readObject(ctx, path, value, true);
  if (graph === null) {
    return;
  }

  // Remembered so that the walk below can be skipped when *the graph* has a
  // problem, without being thrown off by a problem somewhere else in the
  // document.
  const issuesBeforeGraph = ctx.issues.length;

  const rawNodes = readArray(ctx, `${path}.nodes`, graph['nodes'], true);
  const rawEdges = readArray(ctx, `${path}.edges`, graph['edges'], true);

  const nodes: NodeSummary[] = [];
  const nodeIds = new Set<string>();
  let startCount = 0;
  let finishCount = 0;

  if (rawNodes !== null) {
    rawNodes.forEach((entry, index) => {
      const nodePath = `${path}.nodes[${index}]`;
      const node = readObject(ctx, nodePath, entry, true);
      if (node === null) {
        return;
      }

      const id = readString(ctx, `${nodePath}.id`, node['id'], { required: true });
      if (id !== undefined) {
        if (nodeIds.has(id)) {
          report(
            ctx,
            `${nodePath}.id`,
            'duplicate-id',
            `Two nodes share the id "${id}".`,
          );
        } else {
          nodeIds.add(id);
        }
      }

      readString(ctx, `${nodePath}.title`, node['title'], { required: true });
      if (node['notes'] !== undefined) {
        readString(ctx, `${nodePath}.notes`, node['notes'], { required: false });
      }
      if (node['layout'] !== undefined) {
        const layout = readObject(ctx, `${nodePath}.layout`, node['layout'], true);
        if (layout !== null) {
          readNumber(ctx, `${nodePath}.layout.x`, layout['x'], { required: true });
          readNumber(ctx, `${nodePath}.layout.y`, layout['y'], { required: true });
        }
      }

      const kind = readEnum(
        ctx,
        `${nodePath}.kind`,
        node['kind'],
        EXPEDITION_NODE_KINDS,
        true,
      );

      if (kind === 'start') {
        startCount += 1;
      } else if (kind === 'finish') {
        finishCount += 1;
        if (node['message'] !== undefined) {
          readString(ctx, `${nodePath}.message`, node['message'], {
            required: false,
          });
        }
      } else if (kind === 'mission') {
        const missionId = readString(
          ctx,
          `${nodePath}.missionInstanceId`,
          node['missionInstanceId'],
          { required: true },
        );
        if (missionId !== undefined) {
          if (!missionIds.has(missionId)) {
            report(
              ctx,
              `${nodePath}.missionInstanceId`,
              'unknown-reference',
              `No mission in this expedition has the id "${missionId}".`,
            );
          } else if (usedMissionIds.has(missionId)) {
            report(
              ctx,
              `${nodePath}.missionInstanceId`,
              'inconsistent',
              `Mission "${missionId}" is already used by another node.`,
            );
          } else {
            usedMissionIds.add(missionId);
          }
        }
        if (node['optional'] !== undefined) {
          readBoolean(ctx, `${nodePath}.optional`, node['optional'], false);
        }
        if (node['secret'] !== undefined) {
          readBoolean(ctx, `${nodePath}.secret`, node['secret'], false);
        }
      }

      if (id !== undefined) {
        nodes.push({ id, kind });
      }
    });

    if (startCount === 0) {
      report(
        ctx,
        `${path}.nodes`,
        'graph-shape',
        'An expedition needs exactly one start node, and there is none.',
      );
    } else if (startCount > 1) {
      report(
        ctx,
        `${path}.nodes`,
        'graph-shape',
        `An expedition needs exactly one start node, and there are ${startCount}.`,
      );
    }
    if (finishCount === 0) {
      report(
        ctx,
        `${path}.nodes`,
        'graph-shape',
        'An expedition needs at least one finish node, and there is none.',
      );
    }
  }

  if (rawEdges === null) {
    return;
  }

  const kindById = new Map<string, ExpeditionNode['kind'] | undefined>();
  for (const node of nodes) {
    kindById.set(node.id, node.kind);
  }

  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  /** Who each node leads to, used for the reachability and cycle checks. */
  const outgoing = new Map<string, string[]>();

  rawEdges.forEach((entry, index) => {
    const edgePath = `${path}.edges[${index}]`;
    const edge = readObject(ctx, edgePath, entry, true);
    if (edge === null) {
      return;
    }

    const id = readString(ctx, `${edgePath}.id`, edge['id'], { required: true });
    if (id !== undefined) {
      if (edgeIds.has(id)) {
        report(ctx, `${edgePath}.id`, 'duplicate-id', `Two edges share the id "${id}".`);
      } else {
        edgeIds.add(id);
      }
    }

    const from = readString(ctx, `${edgePath}.from`, edge['from'], { required: true });
    const to = readString(ctx, `${edgePath}.to`, edge['to'], { required: true });

    if (from !== undefined && !nodeIds.has(from)) {
      report(
        ctx,
        `${edgePath}.from`,
        'unknown-reference',
        `No node has the id "${from}".`,
      );
    }
    if (to !== undefined && !nodeIds.has(to)) {
      report(ctx, `${edgePath}.to`, 'unknown-reference', `No node has the id "${to}".`);
    }

    if (edge['label'] !== undefined) {
      readString(ctx, `${edgePath}.label`, edge['label'], { required: false });
    }
    if (edge['condition'] !== undefined) {
      validateUnlockCondition(
        ctx,
        `${edgePath}.condition`,
        edge['condition'],
        missionIds,
        1,
      );
    }
    if (edge['audience'] !== undefined) {
      validateEdgeAudience(ctx, `${edgePath}.audience`, edge['audience'], routeIds);
    }

    if (from === undefined || to === undefined) {
      return;
    }

    if (from === to) {
      report(
        ctx,
        edgePath,
        'graph-shape',
        'An edge cannot lead from a node back to itself.',
      );
      return;
    }

    const pair = `${from}->${to}`;
    if (edgePairs.has(pair)) {
      report(
        ctx,
        edgePath,
        'graph-shape',
        'There is already an edge between these two nodes.',
      );
    } else {
      edgePairs.add(pair);
    }

    if (kindById.get(to) === 'start') {
      report(
        ctx,
        `${edgePath}.to`,
        'graph-shape',
        'Nothing may lead back into the start node.',
      );
    }
    if (kindById.get(from) === 'finish') {
      report(
        ctx,
        `${edgePath}.from`,
        'graph-shape',
        'Nothing may lead out of a finish node.',
      );
    }

    const existing = outgoing.get(from);
    if (existing === undefined) {
      outgoing.set(from, [to]);
    } else {
      existing.push(to);
    }
  });

  // Walking the graph only makes sense once its own pieces line up.
  if (ctx.issues.length > issuesBeforeGraph || startCount !== 1) {
    return;
  }

  const startNode = nodes.find((node) => node.kind === 'start');
  if (startNode === undefined) {
    return;
  }

  validateReachability(ctx, path, nodes, startNode.id, outgoing);
  validateNoCycles(ctx, path, nodes, outgoing);
}

/** Reports any node the team could never arrive at. */
function validateReachability(
  ctx: Context,
  path: string,
  nodes: NodeSummary[],
  startId: string,
  outgoing: Map<string, string[]>,
): void {
  const reached = new Set<string>([startId]);
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    for (const next of outgoing.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  for (const node of nodes) {
    if (!reached.has(node.id)) {
      report(
        ctx,
        `${path}.nodes`,
        'unreachable-node',
        `Node "${node.id}" cannot be reached from the start node.`,
      );
    }
  }
}

/**
 * Reports a loop in the graph.
 *
 * A loop means a node that can only be opened by finishing something that is
 * itself behind that node. No team could ever get past it.
 *
 * The walk is a loop rather than a recursive call, because the document being
 * checked comes from outside the platform and a very long chain of nodes must
 * not be able to exhaust the call stack.
 */
function validateNoCycles(
  ctx: Context,
  path: string,
  nodes: NodeSummary[],
  outgoing: Map<string, string[]>,
): void {
  /** Nodes fully explored, which can never be part of a new loop. */
  const finished = new Set<string>();
  /** Nodes on the path being walked right now. */
  const onPath = new Set<string>();

  for (const node of nodes) {
    if (finished.has(node.id)) {
      continue;
    }

    /**
     * The path being walked, held here instead of on the call stack.
     *
     * `next` is how many of a node's outgoing edges have been taken so far.
     */
    const stack: { nodeId: string; next: number }[] = [
      { nodeId: node.id, next: 0 },
    ];
    onPath.add(node.id);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        break;
      }
      const children = outgoing.get(top.nodeId) ?? [];

      if (top.next >= children.length) {
        // Every way out of this node has been followed.
        onPath.delete(top.nodeId);
        finished.add(top.nodeId);
        stack.pop();
        continue;
      }

      const child = children[top.next];
      top.next += 1;
      if (child === undefined || finished.has(child)) {
        continue;
      }
      if (onPath.has(child)) {
        report(
          ctx,
          `${path}.edges`,
          'cycle',
          `The graph loops back on itself at node "${child}", so no team could get past it.`,
        );
        return;
      }
      onPath.add(child);
      stack.push({ nodeId: child, next: 0 });
    }
  }
}


/** Checks how the expedition is played. */
function validateRules(ctx: Context, path: string, value: unknown): void {
  const rules = readObject(ctx, path, value, true);
  if (rules === null) {
    return;
  }

  readEnum(ctx, `${path}.progression`, rules['progression'], PROGRESSION_MODES, true);
  readBoolean(ctx, `${path}.allowSkip`, rules['allowSkip'], true);

  if (rules['routes'] !== undefined) {
    const routes = readArray(ctx, `${path}.routes`, rules['routes'], true);
    if (routes !== null) {
      const routeIds = new Set<string>();
      routes.forEach((entry, index) => {
        const routePath = `${path}.routes[${index}]`;
        const route = readObject(ctx, routePath, entry, true);
        if (route === null) {
          return;
        }
        const routeId = readString(ctx, `${routePath}.id`, route['id'], {
          required: true,
        });
        if (routeId !== undefined) {
          if (routeIds.has(routeId)) {
            report(
              ctx,
              `${routePath}.id`,
              'duplicate-id',
              `Two routes share the id "${routeId}".`,
            );
          } else {
            routeIds.add(routeId);
          }
        }
        readString(ctx, `${routePath}.name`, route['name'], { required: true });
        if (route['description'] !== undefined) {
          readString(ctx, `${routePath}.description`, route['description'], {
            required: false,
          });
        }
      });
    }
  }

  const teams = readObject(ctx, `${path}.teams`, rules['teams'], true);
  if (teams !== null) {
    readIntRange(ctx, `${path}.teams.size`, teams['size'], {
      required: true,
      min: 1,
    });
    const maxTeams = teams['maxTeams'];
    if (maxTeams === undefined) {
      report(ctx, `${path}.teams.maxTeams`, 'missing', 'This field is required.');
    } else if (maxTeams !== null) {
      readInteger(ctx, `${path}.teams.maxTeams`, maxTeams, {
        required: true,
        min: 1,
      });
    }
    const roles = readStringList(ctx, `${path}.teams.roles`, teams['roles'], true);
    const seenRoles = new Set<string>();
    roles.forEach((role, index) => {
      if (seenRoles.has(role)) {
        report(
          ctx,
          `${path}.teams.roles[${index}]`,
          'inconsistent',
          `The role "${role}" is listed twice.`,
        );
      } else {
        seenRoles.add(role);
      }
    });
    readBoolean(
      ctx,
      `${path}.teams.requireFullTeamToStart`,
      teams['requireFullTeamToStart'],
      true,
    );
  }

  const timing = readObject(ctx, `${path}.timing`, rules['timing'], true);
  if (timing !== null) {
    const startMode = readEnum(
      ctx,
      `${path}.timing.startMode`,
      timing['startMode'],
      START_MODES,
      true,
    );
    const endMode = readEnum(
      ctx,
      `${path}.timing.endMode`,
      timing['endMode'],
      END_MODES,
      true,
    );

    const hasLimit = timing['totalTimeLimitSeconds'] !== undefined;
    if (hasLimit) {
      readInteger(
        ctx,
        `${path}.timing.totalTimeLimitSeconds`,
        timing['totalTimeLimitSeconds'],
        { required: true, min: 1 },
      );
    }
    if (endMode === 'time-limit' && !hasLimit) {
      report(
        ctx,
        `${path}.timing.totalTimeLimitSeconds`,
        'inconsistent',
        'An expedition that ends on a time limit has to say what that limit is.',
      );
    }

    if (timing['countdownSeconds'] !== undefined) {
      readInteger(ctx, `${path}.timing.countdownSeconds`, timing['countdownSeconds'], {
        required: true,
        min: 0,
      });
      if (startMode === 'on-join') {
        report(
          ctx,
          `${path}.timing.countdownSeconds`,
          'inconsistent',
          'A countdown only applies when every team starts together.',
        );
      }
    }
  }

  const hints = readObject(ctx, `${path}.hints`, rules['hints'], true);
  if (hints !== null) {
    const enabled = readBoolean(ctx, `${path}.hints.enabled`, hints['enabled'], true);
    readInteger(ctx, `${path}.hints.tokensPerTeam`, hints['tokensPerTeam'], {
      required: true,
      min: 0,
    });
    if (hints['refillEverySeconds'] !== undefined) {
      readInteger(
        ctx,
        `${path}.hints.refillEverySeconds`,
        hints['refillEverySeconds'],
        { required: true, min: 1 },
      );
      if (enabled === false) {
        report(
          ctx,
          `${path}.hints.refillEverySeconds`,
          'inconsistent',
          'Tokens cannot be topped up while hints are switched off.',
        );
      }
    }
  }

  const submissions = readObject(ctx, `${path}.submissions`, rules['submissions'], true);
  if (submissions !== null) {
    readBoolean(
      ctx,
      `${path}.submissions.requireReviewForAll`,
      submissions['requireReviewForAll'],
      true,
    );
    readEnum(
      ctx,
      `${path}.submissions.latePolicy`,
      submissions['latePolicy'],
      LATE_SUBMISSION_POLICIES,
      true,
    );
    readBoolean(
      ctx,
      `${path}.submissions.allowOfflineQueue`,
      submissions['allowOfflineQueue'],
      true,
    );
  }
}

/** Checks which missions a scoring rule applies to. */
function validateScoringRuleTarget(
  ctx: Context,
  path: string,
  value: unknown,
  missionIds: Set<string>,
): void {
  const target = readObject(ctx, path, value, true);
  if (target === null) {
    return;
  }
  const kind = readEnum(
    ctx,
    `${path}.kind`,
    target['kind'],
    ['all', 'missions'] as const,
    true,
  );
  if (kind !== 'missions') {
    return;
  }
  const ids = readArray(
    ctx,
    `${path}.missionInstanceIds`,
    target['missionInstanceIds'],
    true,
  );
  if (ids === null) {
    return;
  }
  if (ids.length === 0) {
    report(
      ctx,
      `${path}.missionInstanceIds`,
      'inconsistent',
      'A rule aimed at named missions has to name at least one.',
    );
  }
  ids.forEach((entry, index) => {
    const missionId = readString(ctx, `${path}.missionInstanceIds[${index}]`, entry, {
      required: true,
    });
    if (missionId !== undefined && !missionIds.has(missionId)) {
      report(
        ctx,
        `${path}.missionInstanceIds[${index}]`,
        'unknown-reference',
        `No mission in this expedition has the id "${missionId}".`,
      );
    }
  });
}

/** Checks how points are earned and lost. */
function validateScoring(
  ctx: Context,
  path: string,
  value: unknown,
  missionIds: Set<string>,
): void {
  const scoring = readObject(ctx, path, value, true);
  if (scoring === null) {
    return;
  }

  readInteger(ctx, `${path}.minimumTotal`, scoring['minimumTotal'], {
    required: true,
  });

  const rules = readArray(ctx, `${path}.rules`, scoring['rules'], true);
  if (rules !== null) {
    const ruleIds = new Set<string>();
    rules.forEach((entry, index) => {
      const rulePath = `${path}.rules[${index}]`;
      const rule = readObject(ctx, rulePath, entry, true);
      if (rule === null) {
        return;
      }

      const id = readString(ctx, `${rulePath}.id`, rule['id'], { required: true });
      if (id !== undefined) {
        if (ruleIds.has(id)) {
          report(
            ctx,
            `${rulePath}.id`,
            'duplicate-id',
            `Two scoring rules share the id "${id}".`,
          );
        } else {
          ruleIds.add(id);
        }
      }

      const type = readEnum(
        ctx,
        `${rulePath}.type`,
        rule['type'],
        SCORING_RULE_TYPES,
        true,
      );
      if (type === undefined) {
        return;
      }

      // Every rule except the late penalty and the streak bonus picks the
      // missions it applies to.
      if (type !== 'late-penalty' && type !== 'streak-bonus') {
        validateScoringRuleTarget(ctx, `${rulePath}.target`, rule['target'], missionIds);
      }

      switch (type) {
        case 'speed-bonus':
          readInteger(ctx, `${rulePath}.withinSeconds`, rule['withinSeconds'], {
            required: true,
            min: 1,
          });
          readInteger(ctx, `${rulePath}.points`, rule['points'], {
            required: true,
            min: 1,
          });
          break;

        case 'first-to-complete-bonus':
        case 'completion-bonus':
          readInteger(ctx, `${rulePath}.points`, rule['points'], {
            required: true,
            min: 1,
          });
          break;

        case 'streak-bonus':
          readInteger(ctx, `${rulePath}.length`, rule['length'], {
            required: true,
            min: 2,
          });
          readInteger(ctx, `${rulePath}.points`, rule['points'], {
            required: true,
            min: 1,
          });
          break;

        case 'hint-penalty':
          readInteger(ctx, `${rulePath}.pointsPerHint`, rule['pointsPerHint'], {
            required: true,
            min: 1,
          });
          break;

        case 'attempt-penalty':
          readInteger(
            ctx,
            `${rulePath}.pointsPerFailedAttempt`,
            rule['pointsPerFailedAttempt'],
            { required: true, min: 1 },
          );
          break;

        case 'late-penalty':
          readInteger(ctx, `${rulePath}.graceSeconds`, rule['graceSeconds'], {
            required: true,
            min: 0,
          });
          readInteger(ctx, `${rulePath}.pointsPerMinute`, rule['pointsPerMinute'], {
            required: true,
            min: 1,
          });
          break;
      }
    });
  }

  const leaderboard = readObject(ctx, `${path}.leaderboard`, scoring['leaderboard'], true);
  if (leaderboard !== null) {
    readEnum(
      ctx,
      `${path}.leaderboard.visibility`,
      leaderboard['visibility'],
      LEADERBOARD_VISIBILITIES,
      true,
    );
    const tieBreaks = readArray(
      ctx,
      `${path}.leaderboard.tieBreaks`,
      leaderboard['tieBreaks'],
      true,
    );
    if (tieBreaks !== null) {
      const seen = new Set<string>();
      tieBreaks.forEach((entry, index) => {
        const tieBreak = readEnum(
          ctx,
          `${path}.leaderboard.tieBreaks[${index}]`,
          entry,
          LEADERBOARD_TIE_BREAKS,
          true,
        );
        if (tieBreak === undefined) {
          return;
        }
        if (seen.has(tieBreak)) {
          report(
            ctx,
            `${path}.leaderboard.tieBreaks[${index}]`,
            'inconsistent',
            `"${tieBreak}" is listed twice, and the second one could never apply.`,
          );
        } else {
          seen.add(tieBreak);
        }
      });
    }
  }
}

/**
 * Checks that an unknown value is a valid Expedition Definition.
 *
 * Pass anything at all. When the result says `valid`, the `definition` it
 * carries can be used as an `ExpeditionDefinition` with no further checking.
 * When it does not, `issues` says what is wrong and where.
 *
 * The whole document is walked every time, so an author sees every problem at
 * once rather than fixing them one at a time.
 */
export function validateExpeditionDefinition(value: unknown): ValidationResult {
  const ctx: Context = { issues: [] };

  const root = readObject(ctx, '', value, true);
  if (root === null) {
    return { valid: false, issues: ctx.issues };
  }

  const schemaVersion = readString(ctx, 'schemaVersion', root['schemaVersion'], {
    required: true,
  });
  if (schemaVersion !== undefined && !isReadableSchemaVersion(schemaVersion)) {
    report(
      ctx,
      'schemaVersion',
      'unsupported-schema-version',
      `This build cannot read schema version "${schemaVersion}".`,
    );
    // Reading on would only produce misleading problems, because the fields
    // below may not mean what this build thinks they mean.
    return { valid: false, issues: ctx.issues };
  }

  readString(ctx, 'id', root['id'], { required: true });
  readInteger(ctx, 'definitionVersion', root['definitionVersion'], {
    required: true,
    min: 1,
  });

  const status = readEnum(ctx, 'status', root['status'], EXPEDITION_STATUSES, true);
  const publishedAt = root['publishedAt'];
  if (publishedAt !== undefined) {
    readTimestamp(ctx, 'publishedAt', publishedAt, true);
    if (status === 'draft') {
      report(
        ctx,
        'publishedAt',
        'inconsistent',
        'A draft has not been published, so it cannot carry a published time.',
      );
    }
  } else if (status === 'published') {
    report(
      ctx,
      'publishedAt',
      'missing',
      'A published expedition has to say when it was published.',
    );
  }

  validateMetadata(ctx, 'metadata', root['metadata']);

  const missionIds = new Set<string>();
  const rawMissions = readArray(ctx, 'missions', root['missions'], true);
  if (rawMissions !== null) {
    rawMissions.forEach((entry, index) => {
      validateMissionInstance(ctx, `missions[${index}]`, entry, missionIds);
    });
  }

  const usedMissionIds = new Set<string>();
  validateGraph(
    ctx,
    'graph',
    root['graph'],
    missionIds,
    usedMissionIds,
    declaredRouteIds(root['rules']),
  );

  if (rawMissions !== null) {
    rawMissions.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        return;
      }
      const id = entry['id'];
      if (typeof id === 'string' && missionIds.has(id) && !usedMissionIds.has(id)) {
        report(
          ctx,
          `missions[${index}]`,
          'unused-mission',
          `Mission "${id}" is not placed on any node, so no team could reach it.`,
        );
      }
    });
  }

  validateRules(ctx, 'rules', root['rules']);
  validateScoring(ctx, 'scoring', root['scoring'], missionIds);

  if (ctx.issues.length > 0) {
    return { valid: false, issues: ctx.issues };
  }
  return { valid: true, definition: value as ExpeditionDefinition };
}

/**
 * The same check, but it throws instead of returning problems.
 *
 * Use this where a failure is a bug rather than something a person can fix,
 * such as reading a document back out of the platform's own database.
 */
export function assertExpeditionDefinition(
  value: unknown,
): ExpeditionDefinition {
  const result = validateExpeditionDefinition(value);
  if (result.valid) {
    return result.definition;
  }
  const summary = result.issues
    .map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
    .join('\n');
  throw new Error(`This is not a valid expedition definition:\n${summary}`);
}
