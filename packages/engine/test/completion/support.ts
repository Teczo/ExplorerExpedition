/**
 * What the completion tests are played against.
 *
 * The mission types here are made up, the same way the registry tests' are
 * and for the same reason: the real ones are EXPD-032 to EXPD-039, and a test
 * that used them would be testing those tickets rather than this one. What
 * matters is only that one of them can decide, one of them always wants a
 * person, and one of them has no code at all.
 */

import type {
  ExpeditionRules,
  GeoCircle,
  JsonObject,
  LocationConstraint,
  MissionInstance,
  MissionProgress,
  VerificationMode,
} from '@explorer/shared-types';

import {
  defineMissionType,
  type MissionTypeEntry,
} from '../../src/mission-types/index.ts';
import {
  applyMissionTransition,
  createMissionProgress,
} from '../../src/mission-state/index.ts';
import {
  DEFAULT_MISSION_STATE_POLICY,
  type MissionStatePolicy,
} from '../../src/mission-state/policy.ts';

/** A type that can decide for itself: the answer is right or it is not. */
export const codeMatch: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'code-match',
    version: '1.0.0',
    name: 'Match the code',
    description: 'The team reads a code off something and sends it in.',
    status: 'published',
    capabilities: ['qr'],
    configSchema: {
      type: 'object',
      properties: { wanted: { type: 'string', minLength: 1 } },
      required: ['wanted'],
    },
    submissionSchema: {
      type: 'object',
      properties: { scanned: { type: 'string', minLength: 1 } },
      required: ['scanned'],
    },
    defaultConfig: { wanted: 'change-me' },
  },
  behaviour: {
    prepare(config: JsonObject): string {
      return String(config['wanted'] ?? '').toUpperCase();
    },
    evaluate({ prepared, submission }) {
      const wanted = String(prepared ?? '');
      const got = String(submission['scanned'] ?? '').toUpperCase();
      return got === wanted
        ? { outcome: 'correct', progress: 1, feedback: 'That is the one.' }
        : { outcome: 'incorrect', progress: 0, feedback: 'That is not it. Keep looking.' };
    },
  },
});

/** A type whose code can never decide: it always hands over to a person. */
export const evidence: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'evidence',
    version: '1.0.0',
    name: 'Send the evidence',
    description: 'The team sends a picture of what they did.',
    status: 'published',
    capabilities: ['camera'],
    configSchema: { type: 'object', properties: { asking: { type: 'string' } } },
    submissionSchema: {
      type: 'object',
      properties: { mediaId: { type: 'string', minLength: 1 } },
      required: ['mediaId'],
    },
    defaultConfig: { asking: 'A picture of the team by the gate.' },
  },
  behaviour: {
    evaluate({ submission }) {
      return { outcome: 'needs-review', detail: { mediaId: submission['mediaId'] ?? null } };
    },
  },
});

/** A type an organisation built in the Studio: a row, and no code at all. */
export const byHand: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'by-hand',
    version: '1.0.0',
    name: 'A teacher looks',
    description: 'A type with no code behind it.',
    status: 'published',
    capabilities: [],
    configSchema: { type: 'object', properties: { asking: { type: 'string' } } },
    submissionSchema: { type: 'object', properties: { note: { type: 'string' } } },
    defaultConfig: { asking: 'Tidy the shelf.' },
  },
});

/** A type whose code throws. A mission type with a bug in it. */
export const brokenType: MissionTypeEntry = defineMissionType({
  definition: { ...byHand.definition, key: 'broken', name: 'Broken' },
  behaviour: {
    evaluate() {
      throw new Error('cannot read the answer key');
    },
  },
});

/** A type whose code answers with something that is not an outcome. */
export const nonsenseType: MissionTypeEntry = defineMissionType({
  definition: { ...byHand.definition, key: 'nonsense', name: 'Nonsense' },
  behaviour: {
    evaluate() {
      return { outcome: 'maybe' } as unknown as { outcome: 'correct' };
    },
  },
});

/** A circle round the middle of Trafalgar Square, fifty metres across. */
export const square: GeoCircle = {
  centre: { latitude: 51.508, longitude: -0.128 },
  radiusMetres: 50,
};

/** That circle as a mission's own requirement. */
export function mustBeAt(
  area: GeoCircle = square,
  onPoorAccuracy: LocationConstraint['onPoorAccuracy'] = 'block',
): LocationConstraint {
  return { area, onPoorAccuracy };
}

/** One mission placed in an expedition, with only the fields a check reads. */
export function missionOf(
  key: string,
  options: {
    version?: string;
    config?: JsonObject;
    verification?: VerificationMode;
    maxAttempts?: number | null;
    timeLimitSeconds?: number;
    location?: LocationConstraint;
  } = {},
): MissionInstance {
  return {
    id: `mission-${key}` as MissionInstance['id'],
    missionTypeId: key,
    missionTypeVersion: options.version ?? '1.0.0',
    title: 'A mission',
    brief: 'Do the thing.',
    config: options.config ?? {},
    scoring: { basePoints: 10, allowPartialCredit: false },
    attempts: { maxAttempts: options.maxAttempts ?? null },
    verification: options.verification ?? 'automatic',
    hints: [],
    media: [],
    ...(options.timeLimitSeconds === undefined
      ? {}
      : { timeLimitSeconds: options.timeLimitSeconds }),
    ...(options.location === undefined ? {} : { location: options.location }),
  };
}

/** Expedition rules holding only what the completion policy reads. */
export function rulesOf(requireReviewForAll: boolean): ExpeditionRules {
  return {
    progression: 'open',
    allowSkip: false,
    teams: {} as ExpeditionRules['teams'],
    timing: {} as ExpeditionRules['timing'],
    hints: {} as ExpeditionRules['hints'],
    submissions: {
      requireReviewForAll,
      latePolicy: 'reject',
      allowOfflineQueue: false,
    },
  };
}

/** A time, so that a test never has to write one out. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 4, 12, 10, 0, seconds)).toISOString();
}

/**
 * A mission a team has opened and is working on.
 *
 * Unlocked, started, and nothing handed in. It is where five of the six ways
 * to finish a mission begin, so every test but the locked ones starts here.
 */
export function openedMission(
  missionId: string,
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
  startedAt = at(0),
): MissionProgress {
  let progress = createMissionProgress(missionId as MissionProgress['missionInstanceId'], {
    state: 'available',
  });
  const started = applyMissionTransition(
    progress,
    { trigger: 'start', actor: 'team', at: startedAt },
    policy,
  );
  if (!started.applied) {
    throw new Error(started.refusal.message);
  }
  progress = started.progress;
  return progress;
}
