/**
 * The selected mission's own settings, and every change the property panel
 * can make to them (EXPD-027).
 *
 * The graph editor (EXPD-026) places a mission from its type's defaults. This
 * file is what lets an author change it afterwards without writing JSON: the
 * words students see, how it is judged, what it is worth, how many tries a
 * team has, how long they have, the hints, and the type's own settings.
 *
 * Every change is a pure function from one `GraphState` to the next, the
 * same as `graph.ts`, so the tests hold it to account without a browser.
 *
 * `media` is placed from the media library (EXPD-030): files are added,
 * ordered, given alt text and taken off here. Kept as it is, not edited here:
 * `location` (navigation and location, EXPD-039).
 */

import {
  validateAgainstSchema,
  validateExpeditionDefinition,
  type AttemptPolicy,
  type ConfigSchema,
  type HintDefinition,
  type JsonObject,
  type JsonValue,
  type MediaRef,
  type MissionInstance,
  type MissionScoring,
  type VerificationMode,
} from '@explorer/shared-types';

import { freshId, toDocument, type GraphState } from './graph.ts';

/** What the panel needs to know about a mission's type. */
export interface MissionTypeRef {
  readonly key: string;
  readonly version: string;
  readonly configSchema: ConfigSchema;
}

/** One problem with the selected mission, with its path inside the mission. */
export interface PropertyIssue {
  /** `brief`, `scoring.maxPoints`, `hints[0].text`, `config.species`, or `` for the mission itself. */
  readonly path: string;
  readonly message: string;
}

// --- Changing a mission -----------------------------------------------------

/** Replaces one mission with what `change` makes of it. Nothing else moves. */
export function updateMission(
  state: GraphState,
  missionId: string,
  change: (mission: MissionInstance) => MissionInstance,
): GraphState {
  return {
    ...state,
    missions: state.missions.map((mission) => (mission.id === missionId ? change(mission) : mission)),
  };
}

/**
 * The words students see. An empty `instructions` is left out, as the schema
 * reads a mission with none; `title` and `brief` are required, so an empty one
 * is kept and the check says so.
 */
export function setMissionText(
  state: GraphState,
  missionId: string,
  field: 'title' | 'brief' | 'instructions',
  text: string,
): GraphState {
  return updateMission(state, missionId, (mission) => {
    if (field === 'instructions' && text === '') {
      const { instructions: _dropped, ...rest } = mission;
      return rest;
    }
    return { ...mission, [field]: text };
  });
}

export function setVerification(state: GraphState, missionId: string, mode: VerificationMode): GraphState {
  return updateMission(state, missionId, (mission) => ({ ...mission, verification: mode }));
}

/** What the mission is worth. `maxPoints: undefined` means no cap. */
export function setScoring(state: GraphState, missionId: string, scoring: MissionScoring): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    scoring: {
      basePoints: scoring.basePoints,
      allowPartialCredit: scoring.allowPartialCredit,
      ...(scoring.maxPoints === undefined ? {} : { maxPoints: scoring.maxPoints }),
    },
  }));
}

/** How many tries, and the wait after a wrong one. `cooldownSeconds: undefined` means none. */
export function setAttempts(state: GraphState, missionId: string, attempts: AttemptPolicy): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    attempts: {
      maxAttempts: attempts.maxAttempts,
      ...(attempts.cooldownSeconds === undefined ? {} : { cooldownSeconds: attempts.cooldownSeconds }),
    },
  }));
}

/** How long a team has once it opens the mission. `undefined` means not timed. */
export function setTimeLimit(state: GraphState, missionId: string, seconds: number | undefined): GraphState {
  return updateMission(state, missionId, (mission) => {
    const { timeLimitSeconds: _dropped, ...rest } = mission;
    return seconds === undefined ? rest : { ...rest, timeLimitSeconds: seconds };
  });
}

// --- Hints ------------------------------------------------------------------

/** The hints in the order a team is offered them. */
export function hintsInOrder(mission: MissionInstance): HintDefinition[] {
  return [...mission.hints].sort((a, b) => a.order - b.order);
}

/** Adds an empty, free hint after the last one. */
export function addHint(state: GraphState, missionId: string): GraphState {
  return updateMission(state, missionId, (mission) => {
    const id = freshId('hint', mission.hints.map((hint) => hint.id)) as HintDefinition['id'];
    const order = Math.max(-1, ...mission.hints.map((hint) => hint.order)) + 1;
    return { ...mission, hints: [...mission.hints, { id, text: '', order, tokenCost: 0 }] };
  });
}

export function updateHint(
  state: GraphState,
  missionId: string,
  hintId: string,
  patch: Partial<Pick<HintDefinition, 'text' | 'tokenCost'>>,
): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    hints: mission.hints.map((hint) => (hint.id === hintId ? { ...hint, ...patch } : hint)),
  }));
}

export function removeHint(state: GraphState, missionId: string, hintId: string): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    hints: mission.hints.filter((hint) => hint.id !== hintId),
  }));
}

/** Swaps a hint's place with the one before (`-1`) or after (`1`) it. */
export function moveHint(state: GraphState, missionId: string, hintId: string, step: -1 | 1): GraphState {
  return updateMission(state, missionId, (mission) => {
    const ordered = hintsInOrder(mission);
    const at = ordered.findIndex((hint) => hint.id === hintId);
    const other = ordered[at + step];
    const self = ordered[at];
    if (self === undefined || other === undefined) {
      return mission;
    }
    return {
      ...mission,
      hints: mission.hints.map((hint) => {
        if (hint.id === self.id) return { ...hint, order: other.order };
        if (hint.id === other.id) return { ...hint, order: self.order };
        return hint;
      }),
    };
  });
}

// --- Media from the library (EXPD-030) --------------------------------------

/**
 * Puts a library file on a mission, after the ones already there. A file is
 * placed once: adding it again changes nothing.
 */
export function addMedia(
  state: GraphState,
  missionId: string,
  file: { readonly id: string; readonly kind: MediaRef['kind']; readonly altText: string | null },
): GraphState {
  return updateMission(state, missionId, (mission) => {
    if (mission.media.some((ref) => ref.mediaId === file.id)) {
      return mission;
    }
    const ref: MediaRef = {
      mediaId: file.id as MediaRef['mediaId'],
      kind: file.kind,
      ...(file.altText === null || file.altText.trim() === '' ? {} : { altText: file.altText }),
    };
    return { ...mission, media: [...mission.media, ref] };
  });
}

/** Takes a file off a mission. The file stays in the library. */
export function removeMedia(state: GraphState, missionId: string, mediaId: string): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    media: mission.media.filter((ref) => ref.mediaId !== mediaId),
  }));
}

/** Moves a file one place up or down. The student app shows them in this order. */
export function moveMedia(state: GraphState, missionId: string, mediaId: string, step: -1 | 1): GraphState {
  return updateMission(state, missionId, (mission) => {
    const at = mission.media.findIndex((ref) => ref.mediaId === mediaId);
    const self = mission.media[at];
    const other = mission.media[at + step];
    if (self === undefined || other === undefined) {
      return mission;
    }
    const media = [...mission.media];
    media[at] = other;
    media[at + step] = self;
    return { ...mission, media };
  });
}

/**
 * The words a screen reader says for the file on this mission. Empty takes
 * them out, so nothing is read rather than an empty string.
 */
export function setMediaAltText(state: GraphState, missionId: string, mediaId: string, text: string): GraphState {
  return updateMission(state, missionId, (mission) => ({
    ...mission,
    media: mission.media.map((ref) => {
      if (ref.mediaId !== mediaId) return ref;
      const { altText: _dropped, ...rest } = ref;
      return text === '' ? rest : { ...rest, altText: text };
    }),
  }));
}

// --- The type's own settings ------------------------------------------------

/** Sets one setting. `undefined` takes it out, so the type's rules decide if that is allowed. */
export function setConfigValue(
  state: GraphState,
  missionId: string,
  name: string,
  value: JsonValue | undefined,
): GraphState {
  return updateMission(state, missionId, (mission) => {
    const { [name]: _dropped, ...rest } = mission.config;
    return { ...mission, config: value === undefined ? rest : { ...rest, [name]: value } };
  });
}

/** Replaces every setting at once, for a type whose schema the panel cannot draw as fields. */
export function setConfig(state: GraphState, missionId: string, config: JsonObject): GraphState {
  return updateMission(state, missionId, (mission) => ({ ...mission, config }));
}

/** The type a mission was placed from, by key and pinned version. */
export function typeOf<T extends MissionTypeRef>(types: readonly T[], mission: MissionInstance): T | undefined {
  return types.find((type) => type.key === mission.missionTypeId && type.version === mission.missionTypeVersion);
}

// --- What is wrong with it --------------------------------------------------

/**
 * Every problem with one mission: what `validateExpeditionDefinition` says
 * about it, and what its type's config schema says about its settings (the
 * part the document check cannot do). Paths are made relative to the mission.
 */
export function issuesOfMission(
  state: GraphState,
  missionId: string,
  type: MissionTypeRef | undefined,
): PropertyIssue[] {
  const index = state.missions.findIndex((mission) => mission.id === missionId);
  const mission = state.missions[index];
  if (mission === undefined) {
    return [];
  }
  const prefix = `missions[${index}]`;
  const issues: PropertyIssue[] = [];

  const document = validateExpeditionDefinition(toDocument(state));
  if (!document.valid) {
    for (const issue of document.issues) {
      if (issue.path === prefix || issue.path.startsWith(`${prefix}.`) || issue.path.startsWith(`${prefix}[`)) {
        issues.push({ path: issue.path.slice(prefix.length).replace(/^\./, ''), message: issue.message });
      }
    }
  }

  if (type === undefined) {
    issues.push({
      path: '',
      message: `No mission type ${mission.missionTypeId}@${mission.missionTypeVersion} is available, so its settings cannot be checked.`,
    });
  } else {
    const config = validateAgainstSchema(type.configSchema, mission.config, { path: 'config' });
    if (!config.valid) {
      issues.push(...config.issues.map((issue) => ({ path: issue.path, message: issue.message })));
    }
  }
  return issues;
}

/** The problems at one field, or anywhere under it. */
export function issuesAt(issues: readonly PropertyIssue[], path: string): PropertyIssue[] {
  return issues.filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`),
  );
}

// --- Reading what an author typed -------------------------------------------

/** A number read from an input, or why it could not be. */
export type ReadNumber =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Reads a number an author typed.
 *
 * Empty reads as `undefined` ("none") when `optional`, and as a problem
 * otherwise. The input keeps what was typed, so a half-typed number is not
 * thrown away; only a number that reads is written to the mission.
 */
export function readNumber(
  text: string,
  rules: { readonly whole?: boolean; readonly min?: number; readonly optional?: boolean } = {},
): ReadNumber {
  const trimmed = text.trim();
  if (trimmed === '') {
    return rules.optional === true ? { ok: true, value: undefined } : { ok: false, message: 'This is required.' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: 'This has to be a number.' };
  }
  if (rules.whole === true && !Number.isInteger(value)) {
    return { ok: false, message: 'This has to be a whole number.' };
  }
  if (rules.min !== undefined && value < rules.min) {
    return { ok: false, message: `This has to be at least ${rules.min}.` };
  }
  return { ok: true, value };
}

/** Reads the JSON an author typed for a whole config. */
export function readConfigJson(text: string): { ok: true; value: JsonObject } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: 'This is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'The settings have to be a JSON object: { ... }.' };
  }
  return { ok: true, value: value as JsonObject };
}
