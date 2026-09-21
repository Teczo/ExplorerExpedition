/**
 * The shape of the rows the API reads (EXPD-004, EXPD-006).
 *
 * One interface per table, named after it, with the columns spelled exactly
 * as PostgreSQL spells them. Nothing is renamed to camel case on the way out
 * of the driver: a row is what the database returned, and the mapping into a
 * domain shape happens in the repository that owns it, once.
 *
 * Times are `Date`, because that is what `pg` gives back for `timestamptz`.
 */

import type {
  AuditAction,
  AuditActorKind,
  AuditChanges,
  AuditEntityType,
  AuthoringSource,
  ExpeditionStatus,
  JsonObject,
  MembershipRole,
  ParticipantStatus,
  ProgressionEventReason,
  ScoreEventReason,
  ScoreLimitKind,
  SessionStatus,
  TeamStatus,
} from '@explorer/shared-types';

/** Why a sign-in or a device stopped being usable. Matches the enum in 0002. */
export type AuthRevocationReason =
  | 'logout'
  | 'rotated'
  | 'reuse-detected'
  | 'password-changed'
  | 'membership-revoked'
  | 'admin';

/** A row of `app_user`. */
export interface AppUserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: 'invited' | 'active' | 'suspended' | 'deactivated';
  readonly locale: string;
  readonly is_platform_admin: boolean;
  readonly last_seen_at: Date | null;
}

/** A row of `user_credential`. */
export interface UserCredentialRow {
  readonly user_id: string;
  readonly password_hash: string;
  readonly password_changed_at: Date;
}

/** A row of `membership`. */
export interface MembershipRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly user_id: string;
  readonly role: MembershipRole;
  readonly status: 'invited' | 'active' | 'revoked';
}

/** A row of `organisation`. */
export interface OrganisationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly timezone: string;
  readonly locale: string;
}

/** A row of `auth_session`. */
export interface AuthSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly refresh_token_hash: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly rotated_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_reason: AuthRevocationReason | null;
}

/**
 * A row of `participant`.
 *
 * One student in one run, and not an account: most students play without one.
 * `joined_at` and `left_at` were added by EXPD-018, which needs to know when
 * somebody arrived to list a team sheet in the order it filled up, and when
 * they went so that a student who was removed is not counted as present.
 */
export interface ParticipantRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_session_id: string;
  readonly display_name: string;
  readonly status: ParticipantStatus;
  readonly device_id: string | null;
  readonly joined_at: Date;
  readonly left_at: Date | null;
}

/** A row of `participant_device`. */
export interface ParticipantDeviceRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly participant_id: string;
  readonly expedition_session_id: string;
  readonly device_id: string;
  readonly device_token_hash: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: AuthRevocationReason | null;
}

/**
 * A row of `audit_log` (EXPD-006).
 *
 * `sequence` is a `bigint`, and `pg` hands a bigint back as a string rather
 * than a number, because not every bigint fits in one. It is spelled as a
 * string here for that reason; `toAuditEntry` is where it becomes a number.
 *
 * Three columns are nullable, and each for its own reason.
 * `organisation_id` is NULL on an action that belongs to the platform rather
 * than to any organisation. The two actor ids are NULL on the kinds of actor
 * that have none: a `CHECK` constraint in 0001 means a `user` row always
 * carries a user id and a `participant` row always carries a participant id,
 * while a `system` or `service` row carries neither.
 */
export interface AuditLogRow {
  readonly id: string;
  readonly sequence: string;
  readonly organisation_id: string | null;
  readonly actor_kind: AuditActorKind;
  readonly actor_user_id: string | null;
  readonly actor_participant_id: string | null;
  readonly actor_label: string;
  readonly action: AuditAction;
  readonly entity_type: AuditEntityType;
  readonly entity_id: string | null;
  readonly changes: AuditChanges;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly request_id: string | null;
  readonly occurred_at: Date;
}

/**
 * A row of `score_event` (EXPD-012, EXPD-014).
 *
 * `points` is what actually moved the total, never what a rule asked for, so
 * adding a team's rows up gives `team.total_score` back. The last three
 * columns are 0004's: where the line sits in its team's stream, and the seal
 * that says nobody edited it since.
 *
 * Every id out of it is a plain uuid with no foreign key, for the reason
 * 0004 gives: a line about a team that has been deleted is exactly the line
 * somebody will want to read.
 */
export interface ScoreEventRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_session_id: string;
  readonly team_id: string;
  readonly participant_id: string | null;
  readonly reason: ScoreEventReason;
  readonly points: number;
  readonly mission_instance_id: string | null;
  readonly mission_attempt_id: string | null;
  readonly submission_id: string | null;
  readonly hint_id: string | null;
  readonly scoring_rule_key: string | null;
  readonly created_by: string | null;
  readonly note: string | null;
  readonly metadata: JsonObject;
  readonly mission_instance_key: string | null;
  readonly hint_key: string | null;
  readonly attempt_number: number | null;
  readonly limit_kind: ScoreLimitKind | null;
  readonly limit_would_have_been: number | null;
  readonly stream_sequence: string;
  readonly previous_hash: string;
  readonly hash: string;
  readonly occurred_at: Date;
  readonly created_at: Date;
}

/**
 * A row of `progression_event` (EXPD-014).
 *
 * The other half of the same stream: the doors that opened for a team, rather
 * than what they earned. `node_key` is the document's own `ExpeditionNode.id`
 * rather than a database key, the same way `scoring_rule_key` is.
 */
export interface ProgressionEventRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_session_id: string;
  readonly team_id: string;
  readonly reason: ProgressionEventReason;
  readonly node_key: string | null;
  readonly mission_instance_key: string | null;
  readonly note: string | null;
  readonly metadata: JsonObject;
  readonly stream_sequence: string;
  readonly previous_hash: string;
  readonly hash: string;
  readonly occurred_at: Date;
  readonly created_at: Date;
}

/**
 * The columns of `team` that carry the head of its stream (EXPD-014).
 *
 * A cache of the stream, the way `total_score` is: `stream_length` is how
 * many lines the team has and so which number the next one takes, and
 * `stream_head_hash` is the seal the next one seals against. NULL before the
 * first line.
 */
export interface TeamStreamHeadRow {
  readonly id: string;
  readonly total_score: number;
  readonly stream_length: string;
  readonly stream_head_hash: string | null;
}

/**
 * A row of `expedition` (EXPD-017).
 *
 * The expedition itself, across every revision. Nothing about what it holds
 * is here: the document lives in `expedition_version`, and this row carries
 * only what is true of the expedition however many revisions it has had.
 */
export interface ExpeditionRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly status: ExpeditionStatus;
  readonly source: AuthoringSource;
  readonly created_by: string | null;
  readonly updated_by: string | null;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * A row of `expedition_version` (EXPD-017).
 *
 * One revision. `definition` is the whole EXPD-002 document and the source of
 * truth for the revision; `title`, `summary` and `locale` are copied out of
 * `definition.metadata` so that a list can be drawn without opening every
 * document, and `VERSION_SUMMARY_COLUMNS` is the read that leaves the
 * document behind.
 */
export interface ExpeditionVersionRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_id: string;
  readonly definition_version: number;
  readonly schema_version: string;
  readonly status: ExpeditionStatus;
  readonly definition: JsonObject;
  readonly title: string;
  readonly summary: string;
  readonly locale: string;
  readonly published_at: Date | null;
  readonly published_by: string | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * A row of `mission_instance` (EXPD-017).
 *
 * Part of the flat copy of a revision: the mission as the rest of the
 * platform points at it. Only the columns this ticket writes and reads back
 * are spelled out; a ticket that reads more adds them here.
 */
export interface MissionInstanceRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_version_id: string;
  readonly instance_key: string;
  readonly mission_type_key: string;
  readonly mission_type_version: string;
  readonly mission_type_id: string | null;
  readonly title: string;
}

/** A row of `mission_node` (EXPD-017). The flat copy of one stop. */
export interface MissionNodeRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_version_id: string;
  readonly node_key: string;
  readonly kind: 'start' | 'mission' | 'checkpoint' | 'finish';
  readonly title: string;
  readonly mission_instance_id: string | null;
}

/** A row of `mission_type`, as far as EXPD-017 reads it. */
export interface MissionTypeRow {
  readonly id: string;
  readonly organisation_id: string | null;
  readonly type_key: string;
  readonly version: string;
}

/**
 * A row of `expedition_session` (EXPD-018).
 *
 * One run of one expedition with one group of students. Only the columns the
 * students, the teams and the join code need are spelled out; the clock
 * columns belong to the ticket that owns the lifecycle (EXPD-019) and are
 * added here by it.
 */
export interface ExpeditionSessionRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_id: string;
  /** The revision this run is pinned to. Publishing a new one does not move it. */
  readonly expedition_version_id: string;
  readonly name: string;
  readonly join_code: string;
  readonly status: SessionStatus;
  readonly host_user_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** A row of `team` (EXPD-018). One team in one run. */
export interface TeamRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_session_id: string;
  readonly name: string;
  readonly status: TeamStatus;
  readonly total_score: number;
  readonly hint_tokens_remaining: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * A row of `team_member` (EXPD-018).
 *
 * Which student is on which team, and what they are doing there. `left_at` is
 * what makes a row live: the two partial unique indexes in migration 0001
 * count only the rows where it is NULL, so a student is on one team at a time
 * and a team has at most one leader.
 */
export interface TeamMemberRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly team_id: string;
  readonly participant_id: string;
  /** One of the names `rules.teams.roles` lists, or NULL for no role. */
  readonly role: string | null;
  readonly is_leader: boolean;
  readonly joined_at: Date;
  readonly left_at: Date | null;
}
