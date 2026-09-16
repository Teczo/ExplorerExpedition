/**
 * Mission types the registry tests register.
 *
 * They are made up on purpose. The real ones are EXPD-032 to EXPD-039, and a
 * test that used them would be testing those tickets rather than this one —
 * which would also quietly make the engine depend on knowing what a QR hunt
 * is, the one thing the registry exists to prevent.
 */

import type {
  ExpeditionDefinition,
  JsonObject,
  MissionInstance,
} from '@explorer/shared-types';

import { defineMissionType, type MissionTypeEntry } from '../../src/mission-types/index.ts';

/** A type with settings, a submission shape and behaviour that can decide. */
export const wordHunt: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'word-hunt',
    version: '1.0.0',
    name: 'Word hunt',
    description: 'Teams find words written around a site and type them in.',
    status: 'published',
    capabilities: ['camera'],
    configSchema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        caseSensitive: { type: 'boolean' },
      },
      required: ['words'],
    },
    submissionSchema: {
      type: 'object',
      properties: { found: { type: 'array', items: { type: 'string' } } },
      required: ['found'],
    },
    defaultConfig: { words: ['change-me'], caseSensitive: false },
  },
  behaviour: {
    prepare(config: JsonObject): string[] {
      const words = Array.isArray(config['words']) ? config['words'] : [];
      const sensitive = config['caseSensitive'] === true;
      return words.map((word) => (sensitive ? String(word) : String(word).toLowerCase()));
    },
    evaluate({ prepared, submission }) {
      const wanted = (prepared as string[] | undefined) ?? [];
      const raw = Array.isArray(submission['found']) ? submission['found'] : [];
      const found = new Set(raw.map((word) => String(word).toLowerCase()));
      const hits = wanted.filter((word) => found.has(word.toLowerCase()));
      return {
        outcome: hits.length === wanted.length ? 'correct' : 'incorrect',
        progress: wanted.length === 0 ? 1 : hits.length / wanted.length,
        detail: { found: hits },
      };
    },
  },
});

/** The same type, one version on. Registered alongside, never instead. */
export const wordHuntV2: MissionTypeEntry = defineMissionType({
  definition: {
    ...wordHunt.definition,
    version: '2.0.0',
    configSchema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        caseSensitive: { type: 'boolean' },
        // The change that made it a new version: a per-word time limit.
        secondsPerWord: { type: 'integer', minimum: 1, maximum: 600 },
      },
      required: ['words', 'secondsPerWord'],
    },
    defaultConfig: { words: ['change-me'], secondsPerWord: 60 },
  },
  behaviour: wordHunt.behaviour,
});

/** A type an organisation built in the Studio: a row, and no code at all. */
export const shelfTidy: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'shelf-tidy',
    version: '1.0.0',
    name: 'Tidy the shelf',
    description: 'A teacher looks at what the team did and decides.',
    status: 'published',
    capabilities: ['camera'],
    configSchema: {
      type: 'object',
      properties: { shelf: { type: 'string', minLength: 1 } },
      required: ['shelf'],
    },
    submissionSchema: { type: 'object', properties: { note: { type: 'string' } } },
    defaultConfig: { shelf: 'the one by the door' },
  },
});

/** A type still being built. Usable inside its organisation, not publishable. */
export const draftType: MissionTypeEntry = defineMissionType({
  definition: {
    ...shelfTidy.definition,
    key: 'half-built',
    name: 'Half built',
    status: 'draft',
  },
});

/** A type that has been superseded. Old expeditions keep playing it. */
export const deprecatedType: MissionTypeEntry = defineMissionType({
  definition: {
    ...shelfTidy.definition,
    key: 'old-fashioned',
    name: 'Old fashioned',
    status: 'deprecated',
  },
});

/** One mission placed in an expedition, with only the fields a check reads. */
export function missionOf(
  key: string,
  version: string,
  config: JsonObject,
): MissionInstance {
  return {
    id: `mission-${key}` as MissionInstance['id'],
    missionTypeId: key,
    missionTypeVersion: version,
    title: 'A mission',
    brief: 'Do the thing.',
    config,
    scoring: { basePoints: 10, allowPartialCredit: false },
    attempts: { maxAttempts: null },
    verification: 'automatic',
    hints: [],
    media: [],
  };
}

/** An expedition holding the missions given, with the rest left bare. */
export function expeditionOf(missions: MissionInstance[]): ExpeditionDefinition {
  return {
    schemaVersion: '1.0.0',
    id: 'expedition-1' as ExpeditionDefinition['id'],
    definitionVersion: 1,
    status: 'draft',
    metadata: {} as ExpeditionDefinition['metadata'],
    missions,
    graph: {} as ExpeditionDefinition['graph'],
    rules: {} as ExpeditionDefinition['rules'],
    scoring: {} as ExpeditionDefinition['scoring'],
  };
}
