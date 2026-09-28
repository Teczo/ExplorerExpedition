/**
 * The rules for building a mission type in the Studio (EXPD-025).
 *
 * Four things, and nothing else:
 *
 *   1. **Every type this organisation can see is listed**, its own and the
 *      platform's, because an author building a type wants to see what
 *      already exists before adding another.
 *   2. **A new type is always a draft, and belongs to the caller's
 *      organisation.** `TenantRepository` sets the organisation on the row;
 *      nothing here can name another one.
 *   3. **A key and version are held once.** Not twice in one organisation,
 *      which the unique index would refuse anyway, and not over a platform
 *      type either. An organisation's type wins over the platform's under the
 *      same key and version (EXPD-017), so a draft called `qr-hunt@1.0.0`
 *      would quietly change every expedition the organisation has that uses
 *      the real one.
 *   4. **Only a draft of this organisation's own is changed, and its key and
 *      version are fixed.** A mission in some expedition already points at
 *      the row by key and version (`mission_instance`), and renaming the type
 *      under it would leave that mission pointing at nothing.
 *
 * And two more, for publishing and versioning (EXPD-031):
 *
 *   5. **Publishing freezes a draft.** Only this organisation's own draft is
 *      published, and only when it still passes the check. Nothing writes to
 *      it again, so a mission pinned to it keeps what its author placed.
 *   6. **A change to a published type is a new version.** It is a new draft
 *      row under the same key, copied from the one it came from, with a
 *      version higher than every version of that key this organisation or
 *      the platform holds. A key has at most one draft at a time, so there is
 *      never a question of which draft is the next version.
 *
 * Deleting a type and deprecating one are not here.
 *
 * Every write is one transaction with its audit entry, the same promise the
 * expedition service makes.
 */

import {
  compareMissionTypeVersions,
  highestMissionTypeVersion,
  validateAuthoredMissionType,
  type AuthoredMissionType,
  type UserPrincipal,
} from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound, ValidationError } from '../http/errors.ts';
import type { AuthoredMissionTypeRow } from '../repositories/rows.ts';
import { toMissionTypeView, type MissionTypeListView, type MissionTypeView } from './views.ts';

/** The most rows a list returns. Mission types are few; this is a guard, not a page. */
export const MAX_MISSION_TYPE_LIST = 500;

export class MissionTypeService {
  readonly #db: Queryable;
  readonly #tenant: TenantRepository;
  readonly #audit: AuditLog;
  readonly #principal: UserPrincipal;

  constructor(options: {
    readonly db: Queryable;
    /** Built with `includeSharedRows`, so reads see the platform's types too. */
    readonly tenant: TenantRepository;
    readonly audit: AuditLog;
    readonly principal: UserPrincipal;
  }) {
    this.#db = options.db;
    this.#tenant = options.tenant;
    this.#audit = options.audit;
    this.#principal = options.principal;
  }

  /** Every type this organisation can see, by key and then version. */
  async list(): Promise<MissionTypeListView> {
    const rows = await this.#tenant.find<AuthoredMissionTypeRow>('mission_type', {
      orderBy: [
        { column: 'type_key', direction: 'asc' },
        { column: 'version', direction: 'asc' },
      ],
      limit: MAX_MISSION_TYPE_LIST,
    });
    return { missionTypes: rows.map(toMissionTypeView) };
  }

  /** One type, this organisation's or the platform's. */
  async get(id: string): Promise<MissionTypeView> {
    const row = await this.#tenant.findById<AuthoredMissionTypeRow>('mission_type', id);
    if (row === null) {
      throw notFound('mission type');
    }
    return toMissionTypeView(row);
  }

  /** Saves a new type, as a draft of this organisation's. */
  async create(type: AuthoredMissionType): Promise<MissionTypeView> {
    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const taken = await tenant.exists('mission_type', {
        type_key: type.key,
        version: type.version,
      });
      if (taken) {
        throw new ApiError('conflict', {
          message: `There is already a mission type ${type.key}@${type.version}. Choose another key or version.`,
        });
      }

      const row = await tenant.insert<AuthoredMissionTypeRow>('mission_type', {
        type_key: type.key,
        version: type.version,
        status: 'draft',
        created_by: this.#principal.userId,
        ...columnsOf(type),
      });

      await this.#audit.withConnection(tx).record('mission-type.created', {
        entityId: row.id,
        after: summaryOf(row),
      });
      return toMissionTypeView(row);
    });
  }

  /** Saves over one of this organisation's drafts. */
  async update(id: string, type: AuthoredMissionType): Promise<MissionTypeView> {
    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const before = await tenant.findById<AuthoredMissionTypeRow>('mission_type', id, {
        forUpdate: true,
      });
      if (before === null) {
        throw notFound('mission type');
      }
      if (before.organisation_id === null) {
        throw new ApiError('conflict', {
          message: 'This mission type belongs to the platform, and is not changed here.',
        });
      }
      if (before.status !== 'draft') {
        throw new ApiError('conflict', {
          message: `This mission type is ${before.status}. Only a draft can be changed.`,
        });
      }
      if (before.type_key !== type.key || before.version !== type.version) {
        throw new ApiError('conflict', {
          message: 'The key and version of a mission type are fixed once it is created.',
        });
      }

      const row = await tenant.updateById<AuthoredMissionTypeRow>(
        'mission_type',
        id,
        columnsOf(type),
      );
      if (row === null) {
        throw notFound('mission type');
      }

      await this.#audit.withConnection(tx).record('mission-type.updated', {
        entityId: row.id,
        before: summaryOf(before),
        after: summaryOf(row),
      });
      return toMissionTypeView(row);
    });
  }

  /**
   * Freezes one of this organisation's drafts.
   *
   * The draft is checked again, because a row written before a rule was added
   * could have been saved without passing it, and a published type is not
   * changed afterwards to put it right.
   */
  async publish(id: string): Promise<MissionTypeView> {
    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const before = await this.#ownRow(tenant, id);
      if (before.status !== 'draft') {
        throw new ApiError('conflict', {
          message: `This mission type is already ${before.status}. Only a draft can be published.`,
        });
      }

      const check = validateAuthoredMissionType({ ...toMissionTypeView(before), status: 'draft' });
      if (!check.valid) {
        throw new ValidationError(
          check.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          'This mission type cannot be published until its problems are fixed.',
        );
      }

      const row = await tenant.updateById<AuthoredMissionTypeRow>('mission_type', id, {
        status: 'published',
      });
      if (row === null) {
        throw notFound('mission type');
      }

      await this.#audit.withConnection(tx).record('mission-type.published', {
        entityId: row.id,
        before: summaryOf(before),
        after: summaryOf(row),
      });
      return toMissionTypeView(row);
    });
  }

  /**
   * Starts the next version of one of this organisation's published types,
   * as a draft copied from it.
   */
  async newVersion(id: string, version: string): Promise<MissionTypeView> {
    return inTransaction(this.#db, async (tx) => {
      const tenant = this.#tenant.withConnection(tx);
      const source = await this.#ownRow(tenant, id);
      if (source.status === 'draft') {
        throw new ApiError('conflict', {
          message: 'This mission type is still a draft. Change it and publish it instead.',
        });
      }

      const siblings = await tenant.find<AuthoredMissionTypeRow>('mission_type', {
        where: { type_key: source.type_key },
        limit: MAX_MISSION_TYPE_LIST,
      });
      const draft = siblings.find(
        (row) => row.organisation_id !== null && row.status === 'draft',
      );
      if (draft !== undefined) {
        throw new ApiError('conflict', {
          message: `${source.type_key}@${draft.version} is already a draft. Publish it or change it first.`,
        });
      }
      const highest = highestMissionTypeVersion(siblings.map((row) => row.version));
      if (highest !== null && (compareMissionTypeVersions(version, highest) ?? 0) <= 0) {
        throw new ApiError('conflict', {
          message: `A new version of ${source.type_key} has to be higher than ${highest}.`,
        });
      }

      const row = await tenant.insert<AuthoredMissionTypeRow>('mission_type', {
        type_key: source.type_key,
        version,
        status: 'draft',
        created_by: this.#principal.userId,
        name: source.name,
        description: source.description,
        capabilities: [...source.capabilities],
        config_schema: source.config_schema,
        submission_schema: source.submission_schema,
        default_config: source.default_config,
        validation_method: source.validation_method,
        default_scoring: source.default_scoring,
        student_layout: source.student_layout,
      });

      await this.#audit.withConnection(tx).record('mission-type.created', {
        entityId: row.id,
        after: { ...summaryOf(row), copied_from: source.version },
      });
      return toMissionTypeView(row);
    });
  }

  /** One of this organisation's own rows, locked. A platform row is not ours to change. */
  async #ownRow(tenant: TenantRepository, id: string): Promise<AuthoredMissionTypeRow> {
    const row = await tenant.findById<AuthoredMissionTypeRow>('mission_type', id, {
      forUpdate: true,
    });
    if (row === null) {
      throw notFound('mission type');
    }
    if (row.organisation_id === null) {
      throw new ApiError('conflict', {
        message: 'This mission type belongs to the platform, and is not changed here.',
      });
    }
    return row;
  }
}

/** The columns a save writes. Key, version and status are the caller's to set. */
function columnsOf(type: AuthoredMissionType) {
  return {
    name: type.name.trim(),
    description: type.description,
    capabilities: [...type.capabilities],
    config_schema: type.configSchema,
    submission_schema: type.submissionSchema,
    default_config: type.defaultConfig,
    validation_method: type.validationMethod,
    default_scoring: type.defaultScoring,
    student_layout: type.studentLayout,
  };
}

/**
 * What the audit entry keeps of a row.
 *
 * The schemas are left out: they can be long, and the row itself holds them.
 * The entry says who changed which type, and what it was called and worth.
 */
function summaryOf(row: AuthoredMissionTypeRow): Record<string, unknown> {
  return {
    type_key: row.type_key,
    version: row.version,
    name: row.name,
    status: row.status,
    validation_method: row.validation_method,
    default_scoring: row.default_scoring,
  };
}
