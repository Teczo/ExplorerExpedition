/**
 * What the mission type endpoints answer with (EXPD-025).
 *
 * A row is what PostgreSQL returned. A view is what the Studio reads: the
 * `AuthoredMissionType` it sent, plus where the row came from and whether
 * this organisation may still change it.
 */

import type {
  AuthoredMissionType,
  ConfigSchema,
  MissionCapability,
  MissionScoring,
  StudentLayout,
} from '@explorer/shared-types';

import type { AuthoredMissionTypeRow } from '../repositories/rows.ts';

/** One mission type. */
export interface MissionTypeView extends AuthoredMissionType {
  readonly id: string;
  /**
   * Whose it is. `platform` rows belong to no organisation and every
   * organisation may read them; nothing here writes one.
   */
  readonly owner: 'organisation' | 'platform';
  /** True for this organisation's own drafts, the only rows a save may change. */
  readonly editable: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Every mission type this organisation can see. */
export interface MissionTypeListView {
  readonly missionTypes: readonly MissionTypeView[];
}

/**
 * A time as ISO 8601. A missing one is now: the column defaults to `now()`,
 * and the same rule the expedition service follows (EXPD-017).
 */
function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return new Date().toISOString();
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** A row, as the Studio reads it. */
export function toMissionTypeView(row: AuthoredMissionTypeRow): MissionTypeView {
  const owner = row.organisation_id === null ? 'platform' : 'organisation';
  return {
    id: row.id,
    key: row.type_key,
    version: row.version,
    name: row.name,
    description: row.description,
    status: row.status,
    capabilities: [...row.capabilities] as MissionCapability[],
    configSchema: row.config_schema as ConfigSchema,
    submissionSchema: row.submission_schema as ConfigSchema,
    defaultConfig: row.default_config,
    validationMethod: row.validation_method,
    defaultScoring: row.default_scoring as unknown as MissionScoring,
    studentLayout: row.student_layout as unknown as StudentLayout,
    owner,
    editable: owner === 'organisation' && row.status === 'draft',
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
