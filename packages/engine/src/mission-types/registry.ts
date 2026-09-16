/**
 * The mission type registry (EXPD-009).
 *
 * One place that maps a mission type key and version to three things: the
 * schema its settings have to match, the rules that check them, and the
 * runtime behaviour that judges a submission. Everything in the engine that
 * needs to know what a mission *is* asks the registry, and nothing in the
 * engine knows what a QR hunt is.
 *
 * That is the point of it. Adding a mission type (EXPD-032 to EXPD-039, and
 * whatever a creator builds in the Studio) is a call to `register`. No file
 * in the engine has a list of types in it, no `switch` grows a case, and
 * nothing here has to be rebuilt.
 *
 * ```ts
 * const registry = createMissionTypeRegistry([qrHunt, photoEvidence]);
 * const result = registry.validateExpedition(definition);
 * ```
 *
 * **There is no shared registry.** The class is instantiated, never reached
 * through a module-level singleton. An organisation's own Studio-built types
 * (EXPD-025) belong only to that organisation, so the API will build one
 * registry per request scope; and a global one is state the simulation
 * harness (EXPD-015) could not isolate between runs.
 *
 * **A registered type never changes.** Registering a key and version that is
 * already held is refused rather than accepted quietly, because the whole
 * reason an expedition pins a version (EXPD-002) is that the thing behind it
 * cannot move underneath it.
 */

import {
  missionTypeRef,
  parseSchemaVersion,
  validateAgainstSchema,
  validateMissionTypeDefinition,
  type ExpeditionDefinition,
  type JsonObject,
  type MissionCapability,
  type MissionConfigIssue,
  type MissionConfigValidationResult,
  type MissionInstance,
  type MissionTypeDefinition,
  type MissionTypeKey,
} from '@explorer/shared-types';

import type { MissionTypeBehaviour } from './behaviour.ts';
import {
  MissionTypeNotRegisteredError,
  MissionTypeRegistrationError,
} from './errors.ts';

/** One mission type as it is offered to the registry. */
export interface MissionTypeEntry {
  /** Everything about the type that could be a database row. */
  definition: MissionTypeDefinition;
  /**
   * The code that judges a submission.
   *
   * Left out by a type an organisation built in the Studio (EXPD-025), which
   * is a row and nothing else. Such a type can be configured, stored and
   * validated; what it cannot do is decide an attempt on its own, so it is
   * reviewed by a teacher (EXPD-037, EXPD-056).
   */
  behaviour?: MissionTypeBehaviour;
}

/** One mission type as the registry holds it. */
export interface RegisteredMissionType {
  readonly definition: MissionTypeDefinition;
  readonly behaviour: MissionTypeBehaviour | undefined;
  /** `key@version`, which is how the registry indexes it. */
  readonly ref: string;
}

/** Which statuses a lookup will settle for. */
export interface StatusFilter {
  /** Include types still being built. Off by default. */
  includeDraft?: boolean;
  /** Include superseded types. Off by default. */
  includeDeprecated?: boolean;
}

/** How strict a whole-expedition check should be. */
export interface ValidateExpeditionOptions {
  /**
   * Let a mission name a type the registry does not hold.
   *
   * A draft expedition may point at a mission type that has not been built
   * yet — `mission_instance.mission_type_id` is nullable for exactly that
   * reason. Publishing one must not, so EXPD-031 leaves this off.
   */
  allowUnregistered?: boolean;
  /** Also settle for draft and deprecated types. Both off by default. */
  status?: StatusFilter;
}

/**
 * Copies a JSON value, so that handing one out cannot let it be changed.
 *
 * `structuredClone` would do the same job, but the student app runs on React
 * Native and the values here are JSON by construction, so the round trip is
 * the one that works everywhere.
 */
function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Orders two versions, oldest first. Unreadable versions sort last. */
function compareVersions(left: string, right: string): number {
  const a = parseSchemaVersion(left);
  const b = parseSchemaVersion(right);
  if (a === null || b === null) {
    if (a === null && b === null) {
      return left.localeCompare(right);
    }
    return a === null ? 1 : -1;
  }
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function acceptsStatus(
  definition: MissionTypeDefinition,
  filter: StatusFilter | undefined,
): boolean {
  switch (definition.status) {
    case 'published':
      return true;
    case 'draft':
      return filter?.includeDraft === true;
    case 'deprecated':
      return filter?.includeDeprecated === true;
  }
}

/** Holds the mission types one engine knows about. */
export class MissionTypeRegistry {
  /** Every type held, by `key@version`. */
  readonly #byRef = new Map<string, RegisteredMissionType>();

  /** The versions held for each key, in the order they were registered. */
  readonly #versionsByKey = new Map<MissionTypeKey, string[]>();

  /**
   * Adds a mission type.
   *
   * The definition is checked in full first — both schemas, the defaults
   * against the config schema, the capabilities, the key and the version — so
   * a type that could never work fails here, when the process starts, rather
   * than on the day a class is standing in a field.
   *
   * @throws MissionTypeRegistrationError when the type is malformed, or when
   * its key and version are already held.
   */
  register(entry: MissionTypeEntry): this {
    const definition = entry.definition;
    const ref =
      typeof definition?.key === 'string' && typeof definition?.version === 'string'
        ? missionTypeRef(definition.key, definition.version)
        : '(unreadable)';

    const result = validateMissionTypeDefinition(definition);
    if (!result.valid) {
      throw new MissionTypeRegistrationError(
        ref,
        `The mission type ${ref} cannot be registered.`,
        result.issues,
      );
    }

    if (this.#byRef.has(ref)) {
      throw new MissionTypeRegistrationError(
        ref,
        `The mission type ${ref} is already registered. A published mission ` +
          'type is never edited, so a change is a new version.',
      );
    }

    if (entry.behaviour !== undefined && typeof entry.behaviour.evaluate !== 'function') {
      throw new MissionTypeRegistrationError(
        ref,
        `The behaviour given for ${ref} has no evaluate function.`,
      );
    }

    this.#byRef.set(ref, {
      definition,
      behaviour: entry.behaviour,
      ref,
    });
    const versions = this.#versionsByKey.get(definition.key) ?? [];
    versions.push(definition.version);
    this.#versionsByKey.set(definition.key, versions);
    return this;
  }

  /** Adds several mission types, in order. */
  registerAll(entries: Iterable<MissionTypeEntry>): this {
    for (const entry of entries) {
      this.register(entry);
    }
    return this;
  }

  /** How many types are held, counting each version separately. */
  get size(): number {
    return this.#byRef.size;
  }

  /** Says whether one exact version of a type is held. */
  has(key: MissionTypeKey, version: string): boolean {
    return this.#byRef.has(missionTypeRef(key, version));
  }

  /** Returns one exact version of a type, or `undefined`. */
  get(key: MissionTypeKey, version: string): RegisteredMissionType | undefined {
    return this.#byRef.get(missionTypeRef(key, version));
  }

  /**
   * Returns one exact version of a type.
   *
   * @throws MissionTypeNotRegisteredError when it is not held. Callers that
   * can carry on without it should use `get` instead.
   */
  require(key: MissionTypeKey, version: string): RegisteredMissionType {
    const found = this.get(key, version);
    if (found === undefined) {
      throw new MissionTypeNotRegisteredError(key, version, this.refs());
    }
    return found;
  }

  /** Every `key@version` held, in alphabetical order. */
  refs(): string[] {
    return [...this.#byRef.keys()].sort();
  }

  /** Every key held, in alphabetical order. Versions are not counted twice. */
  keys(): MissionTypeKey[] {
    return [...this.#versionsByKey.keys()].sort();
  }

  /** The versions held for one key, oldest first. */
  versionsOf(key: MissionTypeKey): string[] {
    return [...(this.#versionsByKey.get(key) ?? [])].sort(compareVersions);
  }

  /**
   * The newest version of one key.
   *
   * Published types only, unless asked otherwise. The Studio's palette shows
   * what this returns, because offering an author a draft or a superseded
   * type is how an expedition ends up pinned to one.
   */
  latest(
    key: MissionTypeKey,
    filter?: StatusFilter,
  ): RegisteredMissionType | undefined {
    const versions = this.versionsOf(key);
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const version = versions[index];
      if (version === undefined) {
        continue;
      }
      const found = this.get(key, version);
      if (found !== undefined && acceptsStatus(found.definition, filter)) {
        return found;
      }
    }
    return undefined;
  }

  /** Every type held, ordered by key and then by version, oldest first. */
  list(filter?: StatusFilter): RegisteredMissionType[] {
    const held: RegisteredMissionType[] = [];
    for (const key of this.keys()) {
      for (const version of this.versionsOf(key)) {
        const found = this.get(key, version);
        if (found !== undefined && acceptsStatus(found.definition, filter)) {
          held.push(found);
        }
      }
    }
    return held;
  }

  /**
   * What a new mission of this type starts out with.
   *
   * A fresh copy every time, so that an author editing their new mission
   * cannot reach into the type and change what everybody else starts from.
   */
  defaultConfigFor(key: MissionTypeKey, version: string): JsonObject {
    return copyJson(this.require(key, version).definition.defaultConfig);
  }

  /** Checks one mission's settings against its type's config schema. */
  validateConfig(
    key: MissionTypeKey,
    version: string,
    config: unknown,
    path = 'config',
  ): MissionConfigValidationResult {
    const { definition } = this.require(key, version);
    return validateAgainstSchema(definition.configSchema, config, { path });
  }

  /** Checks one submission payload against its type's submission schema. */
  validateSubmission(
    key: MissionTypeKey,
    version: string,
    payload: unknown,
    path = 'payload',
  ): MissionConfigValidationResult {
    const { definition } = this.require(key, version);
    return validateAgainstSchema(definition.submissionSchema, payload, { path });
  }

  /** The behaviour registered for a type, or `undefined` when it has none. */
  behaviourFor(
    key: MissionTypeKey,
    version: string,
  ): MissionTypeBehaviour | undefined {
    return this.require(key, version).behaviour;
  }

  /**
   * Runs a type's `prepare` over one mission's settings.
   *
   * The engine calls this once per mission and passes what comes back to
   * every evaluation of that mission. Returns `undefined` when the type has
   * no behaviour, or has one with nothing to prepare.
   */
  prepareConfig(key: MissionTypeKey, version: string, config: JsonObject): unknown {
    const behaviour = this.behaviourFor(key, version);
    if (behaviour?.prepare === undefined) {
      return undefined;
    }
    return behaviour.prepare(config);
  }

  /**
   * Checks one mission placed in an expedition.
   *
   * This is the check the Expedition Definition validator said it could not
   * do (EXPD-002): the type is looked up, and the mission's `config` is
   * checked against that type's schema.
   */
  validateMission(
    mission: MissionInstance,
    path = 'mission',
    options: ValidateExpeditionOptions = {},
  ): MissionConfigValidationResult {
    const issues: MissionConfigIssue[] = [];
    this.#checkMission(issues, mission, path, options);
    return issues.length === 0 ? { valid: true } : { valid: false, issues };
  }

  /**
   * Checks every mission in a whole expedition.
   *
   * Run it after `validateExpeditionDefinition`, not instead of it. That one
   * checks the document; this one checks the part of the document only a
   * mission type can judge. Paths line up with that validator's, so the
   * Studio puts a problem from either on the same field.
   */
  validateExpedition(
    definition: ExpeditionDefinition,
    options: ValidateExpeditionOptions = {},
  ): MissionConfigValidationResult {
    const issues: MissionConfigIssue[] = [];
    const missions = Array.isArray(definition.missions) ? definition.missions : [];
    missions.forEach((mission, index) => {
      this.#checkMission(issues, mission, `missions[${index}]`, options);
    });
    return issues.length === 0 ? { valid: true } : { valid: false, issues };
  }

  /**
   * What the missions in an expedition need from a student's device.
   *
   * The union over every mission, in the order `MISSION_CAPABILITIES` lists
   * them. The join flow (EXPD-040) asks for these once at the start rather
   * than interrupting a team at the third stop to ask for the camera.
   *
   * A mission naming a type the registry does not hold contributes nothing
   * and is not an error here; `validateExpedition` is what reports that.
   */
  capabilitiesFor(definition: ExpeditionDefinition): MissionCapability[] {
    const needed = new Set<MissionCapability>();
    const missions = Array.isArray(definition.missions) ? definition.missions : [];
    for (const mission of missions) {
      if (typeof mission !== 'object' || mission === null) {
        continue;
      }
      const found = this.get(mission.missionTypeId, mission.missionTypeVersion);
      for (const capability of found?.definition.capabilities ?? []) {
        needed.add(capability);
      }
    }
    return [...needed];
  }

  #checkMission(
    issues: MissionConfigIssue[],
    mission: MissionInstance,
    path: string,
    options: ValidateExpeditionOptions,
  ): void {
    if (typeof mission !== 'object' || mission === null) {
      // EXPD-002's validator is what reports a mission that is not an object.
      // Saying it again here would be a second problem about one mistake.
      return;
    }
    const key = mission.missionTypeId;
    const version = mission.missionTypeVersion;
    const found = this.get(key, version);

    if (found === undefined) {
      if (options.allowUnregistered === true) {
        return;
      }
      const others = this.versionsOf(key);
      const hint =
        others.length === 0
          ? 'No version of it is registered.'
          : `Registered versions of it are: ${others.join(', ')}.`;
      issues.push({
        path: `${path}.missionTypeId`,
        code: 'unknown-mission-type',
        message: `No mission type "${missionTypeRef(key, version)}" is registered. ${hint}`,
      });
      return;
    }

    if (!acceptsStatus(found.definition, options.status)) {
      issues.push({
        path: `${path}.missionTypeVersion`,
        code: 'unknown-mission-type',
        message:
          `The mission type ${found.ref} is ${found.definition.status}, so a ` +
          'mission cannot be published against it.',
      });
    }

    const result = validateAgainstSchema(found.definition.configSchema, mission.config, {
      path: `${path}.config`,
    });
    if (!result.valid) {
      issues.push(...result.issues);
    }
  }
}

/** Builds a registry holding the types given, in order. */
export function createMissionTypeRegistry(
  entries: Iterable<MissionTypeEntry> = [],
): MissionTypeRegistry {
  return new MissionTypeRegistry().registerAll(entries);
}

/**
 * Writes one mission type down, with the types checked as you write it.
 *
 * It does nothing at runtime beyond returning what it was given. It exists so
 * that a mistake in a mission type — a capability that is not a capability, a
 * schema keyword that does not exist — is a red squiggle where the type is
 * written rather than a thrown error when the process starts.
 */
export function defineMissionType(entry: MissionTypeEntry): MissionTypeEntry {
  return entry;
}
