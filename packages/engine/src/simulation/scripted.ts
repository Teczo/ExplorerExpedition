/**
 * Playing an expedition whose mission types have no code (EXPD-015).
 *
 * The harness has three jobs, and two of them do not need a mission type to
 * work at all. Whether the graph can be walked from the start to a finish,
 * and how long an afternoon of it takes, are questions about the expedition
 * rather than about what a QR code says. The AI builder (EXPD-066) asks
 * exactly those two about a document it has just generated, whose missions
 * may well be pinned to types nobody has built yet.
 *
 * The obvious way to answer them is to let the harness decide an outcome and
 * move the mission itself. That would be wrong: mapping an outcome to a
 * trigger is the completion interface's job (EXPD-011), and a second place
 * doing it is a second place for it to be wrong — which is the one thing
 * every note in this package is written to prevent.
 *
 * So the harness does it the other way round. It builds a **stand-in
 * registry**: one mission type per `key@version` the expedition names, whose
 * behaviour reads the intended outcome straight out of the submission. The
 * run then goes through `completeMission` exactly as it would on the day —
 * the attempt is counted, the location is checked, the teacher review still
 * happens, the mission's own clock still runs — and nothing anywhere has a
 * second opinion about what `correct` means.
 *
 * A type whose key or version is not one the platform could hold — a
 * generated document with `Qr Hunt` in it — is not registered and is listed
 * in `unusable`. Missions of that type are then refused by the completion
 * interface in the ordinary way, and the report says so.
 */

import {
  missionTypeRef,
  type ExpeditionDefinition,
  type JsonObject,
  type MissionTypeDefinition,
} from '@explorer/shared-types';

import { MissionTypeRegistry } from '../mission-types/registry.ts';
import type { MissionOutcome } from '../mission-types/behaviour.ts';
import type { SimulatedPlayer } from './players.ts';

/** The field a scripted payload carries its intended outcome on. */
export const SCRIPTED_OUTCOME_FIELD = 'outcome';

/** What a scripted stand-in accepts as a submission. */
const SCRIPTED_SUBMISSION_SCHEMA: MissionTypeDefinition['submissionSchema'] = {
  type: 'object',
  properties: {
    [SCRIPTED_OUTCOME_FIELD]: { type: 'string', enum: ['correct', 'incorrect'] },
  },
  required: [SCRIPTED_OUTCOME_FIELD],
};

/** One stand-in mission type, taking the place of a real one. */
export function scriptedMissionType(key: string, version: string): MissionTypeDefinition {
  return {
    key,
    version,
    name: `Scripted ${key}`,
    description:
      'A stand-in used by the simulation harness. It judges nothing: the ' +
      'submission says what the attempt was meant to come to.',
    status: 'published',
    capabilities: [],
    // Anything at all, because the real type's settings are passed through
    // untouched and this one has no business checking them.
    configSchema: {},
    submissionSchema: SCRIPTED_SUBMISSION_SCHEMA,
    defaultConfig: {},
  };
}

/** Reads the intended outcome off a scripted payload. */
function scriptedOutcome(submission: JsonObject): MissionOutcome {
  return submission[SCRIPTED_OUTCOME_FIELD] === 'correct' ? 'correct' : 'incorrect';
}

/** What came of building a stand-in registry for one expedition. */
export interface ScriptedRegistry {
  /** The registry to play the run with. */
  readonly registry: MissionTypeRegistry;
  /** The `key@version` refs a stand-in was built for, in the order found. */
  readonly refs: readonly string[];
  /**
   * The refs no stand-in could be built for, because the key or the version
   * is not one the platform could ever hold.
   */
  readonly unusable: readonly string[];
}

/**
 * A registry holding one stand-in for every mission type the document names.
 *
 * The expedition's own missions are not touched: their `config` is whatever
 * the author wrote, and the stand-in accepts it because it checks nothing.
 */
export function scriptedRegistryFor(definition: ExpeditionDefinition): ScriptedRegistry {
  const registry = new MissionTypeRegistry();
  const refs: string[] = [];
  const unusable: string[] = [];
  const seen = new Set<string>();

  for (const mission of definition.missions ?? []) {
    if (typeof mission !== 'object' || mission === null) {
      continue;
    }
    const key = mission.missionTypeId;
    const version = mission.missionTypeVersion;
    if (typeof key !== 'string' || typeof version !== 'string') {
      continue;
    }
    const ref = missionTypeRef(key, version);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);

    try {
      registry.register({
        definition: scriptedMissionType(key, version),
        behaviour: {
          evaluate: ({ submission }) => {
            const outcome = scriptedOutcome(submission);
            return {
              outcome,
              progress: outcome === 'correct' ? 1 : 0,
              feedback:
                outcome === 'correct'
                  ? 'The simulated team got this one.'
                  : 'The simulated team did not get this one.',
            };
          },
        },
      });
      refs.push(ref);
    } catch {
      // A key or version the registry will not take is a document problem,
      // not a reason to stop a run. The mission is unplayable and the report
      // says which one and why.
      unusable.push(ref);
    }
  }

  return { registry, refs, unusable };
}

/**
 * The player that goes with a stand-in registry.
 *
 * It writes the intent down and hands it over, which is the whole of what a
 * scripted run does differently from a real one.
 */
export const scriptedPlayer: SimulatedPlayer = ({ intent }) => ({
  [SCRIPTED_OUTCOME_FIELD]: intent,
});
