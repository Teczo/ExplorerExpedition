/**
 * The mission types one submission is judged against (EXPD-020).
 *
 * A registry is per request scope, never shared (EXPD-009), so one is built
 * here for each submission, holding only the types the mission names.
 *
 * Two places a type can come from, and the first wins:
 *
 *   1. **Code the process was started with.** A type that can judge an answer
 *      on its own — a QR hunt matching a code, a puzzle checking an answer —
 *      is a `MissionTypeEntry` with a `behaviour`, and code is not a row. The
 *      mission type tickets (EXPD-032 to EXPD-039) are what will hand these to
 *      `createApp`; until then there are none.
 *   2. **A row of `mission_type`.** A definition and nothing else. The
 *      completion interface (EXPD-011) already knows what to do with a type
 *      that has no code: a reached place finishes the mission, and anything
 *      else goes to a teacher. That is not this file deciding anything.
 *
 * A type named by neither is not registered, and the engine refuses the
 * submission with `unknown-mission-type` — which is its answer to give.
 */

import { createMissionTypeRegistry, type MissionTypeEntry, type MissionTypeRegistry } from '@explorer/engine';
import {
  missionTypeRef,
  type MissionCapability,
  type MissionTypeDefinition,
  type ConfigSchema,
} from '@explorer/shared-types';

import type { TenantRepository } from '../db/tenant-repository.ts';
import type { MissionTypeDefinitionRow } from '../repositories/rows.ts';

/** A mission type as the row describes it. */
export function definitionOfRow(row: MissionTypeDefinitionRow): MissionTypeDefinition {
  return {
    key: row.type_key,
    version: row.version,
    name: row.name,
    description: row.description,
    status: row.status,
    capabilities: [...row.capabilities] as MissionCapability[],
    configSchema: row.config_schema as ConfigSchema,
    submissionSchema: row.submission_schema as ConfigSchema,
    defaultConfig: row.default_config,
  };
}

/**
 * Builds the registry for one mission.
 *
 * `tenant` has to include the platform-wide rows, because `qr-hunt` belongs
 * to the platform and not to the school using it. An organisation's own type
 * under the same key and version wins, the same rule `MissionTypeResolver`
 * (EXPD-017) applies.
 *
 * A row that does not make a valid definition is left out rather than
 * thrown: a class standing in a field is the wrong place to find a broken
 * row, and the engine's refusal says plainly that nothing could check it.
 */
export async function registryForMission(
  tenant: TenantRepository,
  coded: readonly MissionTypeEntry[],
  typeKey: string,
  version: string,
): Promise<MissionTypeRegistry> {
  const registry = createMissionTypeRegistry();
  const ref = missionTypeRef(typeKey, version);

  const fromCode = coded.find(
    (entry) => missionTypeRef(entry.definition.key, entry.definition.version) === ref,
  );
  if (fromCode !== undefined) {
    return registry.register(fromCode);
  }

  const rows = await tenant.find<MissionTypeDefinitionRow>('mission_type', {
    where: { type_key: typeKey, version },
  });
  const row = rows.find((candidate) => candidate.organisation_id !== null) ?? rows[0];
  if (row === undefined) {
    return registry;
  }

  try {
    registry.register({ definition: definitionOfRow(row) });
  } catch {
    // Left unregistered; the engine refuses with `unknown-mission-type`.
  }
  return registry;
}
