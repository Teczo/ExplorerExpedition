/**
 * The flat copy of a revision (EXPD-017).
 *
 * The document in `expedition_version.definition` is the source of truth, and
 * migration 0001 says so. But other rows have to *point* at parts of it — a
 * mission attempt points at a mission (EXPD-020), a QR marker points at one
 * too (EXPD-032), a node is what a team's progress is recorded against
 * (EXPD-013) — and a foreign key cannot point inside a JSON document. So the
 * parts that are pointed at are copied out into `mission_instance`,
 * `mission_node` and `hint` whenever a revision is saved, which is what 0001
 * asks this ticket to do.
 *
 * Three things are worth knowing about the copy.
 *
 * **It is derived, never authoritative.** Nothing edits these rows. They are
 * deleted and written again from the document every time the document
 * changes, so they cannot drift from it, and a disagreement between the two
 * is always the copy's fault.
 *
 * **Only a valid document is copied.** A draft is allowed to be halfway
 * through — two start nodes, a mission placed nowhere, a node holding a
 * mission that was deleted — and the database is right to refuse every one of
 * those. So `project` is called for a document that passed
 * `validateExpeditionDefinition` and `clear` for one that did not, which
 * leaves a half-finished draft with no copy rather than with a stale one. A
 * published revision is always valid, so a published revision always has one.
 *
 * **It is written inside the caller's transaction.** Clearing the old rows
 * and writing the new ones is not two operations anybody should be able to
 * observe between.
 */

import type {
  ExpeditionDefinition,
  ExpeditionEdge,
  ExpeditionNode,
  MissionInstance,
} from '@explorer/shared-types';

import type { SqlValue } from '../db/sql.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  MissionInstanceRow,
  MissionNodeRow,
  MissionTypeRow,
} from '../repositories/rows.ts';

/**
 * Looks up the registry row a mission's type and version resolve to.
 *
 * Built on a repository whose scope includes the platform-wide rows, because
 * `qr-hunt` belongs to the platform and not to the school using it. A draft
 * may name a type nobody has registered, and 0001 makes the column nullable
 * for exactly that reason, so a miss is not an error.
 */
export class MissionTypeResolver {
  readonly #tenant: TenantRepository;
  readonly #cache = new Map<string, string | null>();

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /** The registry row's id, or null when this build has no such type. */
  async resolve(typeKey: string, version: string): Promise<string | null> {
    const key = `${typeKey}@${version}`;
    const known = this.#cache.get(key);
    if (known !== undefined) {
      return known;
    }

    const rows = await this.#tenant.find<MissionTypeRow>('mission_type', {
      where: { type_key: typeKey, version },
      columns: ['id', 'organisation_id', 'type_key', 'version'],
    });

    // An organisation may register its own type under a key the platform also
    // uses. Its own wins: it is the one its authors were choosing from.
    const own = rows.find((row) => row.organisation_id !== null);
    const found = (own ?? rows[0])?.id ?? null;
    this.#cache.set(key, found);
    return found;
  }
}

/**
 * Deletes the flat copy of a revision.
 *
 * Hints are deleted through the missions they belong to, because `hint` has
 * no `expedition_version_id` of its own — a hint belongs to a mission, and
 * the mission is what belongs to the revision. PostgreSQL would cascade them,
 * but a cascade is the database tidying up after a statement that did not say
 * what it meant, and doing it here means the same rows go whichever driver is
 * underneath.
 */
export async function clear(
  tenant: TenantRepository,
  expeditionVersionId: string,
): Promise<void> {
  const missions = await tenant.find<Pick<MissionInstanceRow, 'id'>>(
    'mission_instance',
    { where: { expedition_version_id: expeditionVersionId }, columns: ['id'] },
  );

  await tenant.delete('mission_node', {
    expedition_version_id: expeditionVersionId,
  });

  if (missions.length > 0) {
    await tenant.delete('hint', { mission_instance_id: missions.map((row) => row.id) });
  }

  await tenant.delete('mission_instance', {
    expedition_version_id: expeditionVersionId,
  });
}

/**
 * Writes the flat copy of a revision, replacing whatever was there.
 *
 * Takes a document that has already been validated, so the shapes the
 * database insists on — one start node, every mission placed on exactly one
 * node, no edge leaving a finish — are already true of it. A document that
 * had not been validated would be refused by a `CHECK` constraint rather than
 * by anything here, which is the right way round but a poor error message.
 */
export async function project(
  tenant: TenantRepository,
  expeditionVersionId: string,
  definition: ExpeditionDefinition,
  types: MissionTypeResolver,
): Promise<void> {
  await clear(tenant, expeditionVersionId);

  const missionIds = new Map<string, string>();
  for (const mission of definition.missions) {
    const row = await tenant.insert<MissionInstanceRow>('mission_instance', {
      expedition_version_id: expeditionVersionId,
      instance_key: mission.id,
      ...(await missionColumns(mission, types)),
    });
    missionIds.set(mission.id, row.id);

    for (const hint of mission.hints) {
      await tenant.insert('hint', {
        mission_instance_id: row.id,
        hint_key: hint.id,
        text: hint.text,
        display_order: hint.order,
        token_cost: hint.tokenCost,
      });
    }
  }

  const leaving = edgesByNode(definition.graph.edges);
  for (const node of definition.graph.nodes) {
    await tenant.insert<MissionNodeRow>('mission_node', {
      expedition_version_id: expeditionVersionId,
      node_key: node.id,
      ...nodeColumns(node, missionIds, leaving.get(node.id) ?? []),
    });
  }
}

/** The columns one mission is copied into. */
async function missionColumns(
  mission: MissionInstance,
  types: MissionTypeResolver,
): Promise<Record<string, SqlValue>> {
  const location = mission.location;

  return {
    // Copied from the document and never rewritten, so that a revision keeps
    // pointing at the type version its author configured (0001).
    mission_type_key: mission.missionTypeId,
    mission_type_version: mission.missionTypeVersion,
    mission_type_id: await types.resolve(
      mission.missionTypeId,
      mission.missionTypeVersion,
    ),
    title: mission.title,
    brief: mission.brief,
    instructions: mission.instructions ?? null,
    config: mission.config,
    scoring: mission.scoring,
    media: mission.media,
    max_attempts: mission.attempts.maxAttempts,
    cooldown_seconds: mission.attempts.cooldownSeconds ?? 0,
    time_limit_seconds: mission.timeLimitSeconds ?? null,
    verification: mission.verification,
    // All four together or none of them: 0001 has a constraint saying so, and
    // a half-written location would be a mission nobody could reach.
    location_latitude: location === undefined ? null : location.area.centre.latitude,
    location_longitude: location === undefined ? null : location.area.centre.longitude,
    location_radius_metres: location === undefined ? null : location.area.radiusMetres,
    location_on_poor_accuracy: location === undefined ? null : location.onPoorAccuracy,
  };
}

/** The columns one node is copied into. */
function nodeColumns(
  node: ExpeditionNode,
  missionIds: ReadonlyMap<string, string>,
  outgoing: readonly ExpeditionEdge[],
): Record<string, SqlValue> {
  return {
    kind: node.kind,
    title: node.title,
    notes: node.notes ?? null,
    mission_instance_id:
      node.kind === 'mission' ? missionIds.get(node.missionInstanceId) ?? null : null,
    finish_message: node.kind === 'finish' ? node.message ?? null : null,
    layout_x: node.layout?.x ?? null,
    layout_y: node.layout?.y ?? null,
    outgoing_edges: [...outgoing],
  };
}

/** The edges that leave each node, in the order the document lists them. */
function edgesByNode(
  edges: readonly ExpeditionEdge[],
): ReadonlyMap<string, ExpeditionEdge[]> {
  const grouped = new Map<string, ExpeditionEdge[]>();
  for (const edge of edges) {
    const existing = grouped.get(edge.from);
    if (existing === undefined) {
      grouped.set(edge.from, [edge]);
    } else {
      existing.push(edge);
    }
  }
  return grouped;
}
