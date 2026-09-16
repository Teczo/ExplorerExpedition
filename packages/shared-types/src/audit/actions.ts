/**
 * What an audit entry can say happened (EXPD-006).
 *
 * The audit log answers one question: who changed this, and when. For that to
 * be answerable the vocabulary has to be a closed list rather than whatever
 * string the calling route happened to type, so this file is the list.
 *
 * Two groups, because the log covers two kinds of event.
 *
 *   A **scoring change** is anything that moves a team's points. The engine
 *   awards them, a rule takes them away, a teacher adjusts them by hand. The
 *   points themselves live in `score_event`; the entry here says who caused
 *   the change and from where.
 *
 *   An **administrative action** is somebody changing the shape of the
 *   organisation or of what it owns: inviting a member, publishing a
 *   revision, ending a run, accepting a submission, revoking a sign-in.
 *
 * Names are `<thing>.<what-happened>`, past tense, because an entry is a
 * record of something that already happened and can never be edited.
 *
 * Later tickets add the actions their endpoints need. Adding one means adding
 * it here and giving it an entity type below; nothing else has to change.
 */

/**
 * Every scoring change worth a line in the log.
 *
 * `score.recalculated` is the odd one: it is written when a replay of the
 * scoring engine (EXPD-012) lands on a different total than the one stored,
 * because a team's score changing without anybody touching it is exactly the
 * thing somebody will later want explained.
 */
export const SCORING_AUDIT_ACTIONS = [
  /** The engine gave a team points for something they did. */
  'score.awarded',
  /** A rule took points away: a penalty, a hint, a late finish. */
  'score.deducted',
  /** A teacher changed a team's score by hand (EXPD-058). */
  'score.adjusted',
  /** An award was withdrawn, because the submission behind it was rejected. */
  'score.revoked',
  /** A replay of the scoring engine disagreed with the stored total. */
  'score.recalculated',
] as const;

/** Everything else the log records: changes somebody made on purpose. */
export const ADMINISTRATIVE_AUDIT_ACTIONS = [
  // --- The organisation, and who is in it ---
  'organisation.updated',
  'member.invited',
  'member.role-changed',
  'member.revoked',
  'subscription.changed',

  // --- Authoring (EXPD-017, EXPD-031) ---
  'expedition.created',
  'expedition.updated',
  'expedition.published',
  'expedition.unpublished',
  'expedition.deleted',
  'mission-type.created',
  'mission-type.updated',
  'mission-type.deleted',

  // --- Running a class (EXPD-019, EXPD-055, EXPD-058) ---
  'session.scheduled',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.ended',
  'session.overridden',

  // --- The students in a run (EXPD-018) ---
  'participant.removed',
  'participant.team-changed',

  // --- Reviewing what they sent in (EXPD-056) ---
  'submission.accepted',
  'submission.rejected',

  // --- Files (EXPD-021, EXPD-030) ---
  'media.deleted',

  // --- Signing in, and being stopped from signing in ---
  'auth.password-changed',
  'auth.session-revoked',
  'auth.device-revoked',
  /**
   * The only grant in the schema that crosses the tenant boundary, so it is
   * the one that most needs a line in the log (EXPD-070).
   */
  'platform-admin.granted',
  'platform-admin.revoked',
] as const;

/** Every action the log can record. */
export const AUDIT_ACTIONS = [
  ...SCORING_AUDIT_ACTIONS,
  ...ADMINISTRATIVE_AUDIT_ACTIONS,
] as const;

/** One thing an audit entry can say happened. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** A scoring change. */
export type ScoringAuditAction = (typeof SCORING_AUDIT_ACTIONS)[number];

/** An administrative action. */
export type AdministrativeAuditAction = (typeof ADMINISTRATIVE_AUDIT_ACTIONS)[number];

/**
 * The kinds of row an entry can be about.
 *
 * These are table names, spelled as `apps/api/db/migrations/` spells them,
 * because `audit_log.entity_type` holds a table name and `entity_id` holds a
 * row's id. They are written out here rather than imported, because this
 * package may not import from an app. `audit-vocabulary.test.ts` checks the
 * list against the real table registry, so a name that stops being a table
 * fails a test rather than being noticed by somebody reading the log.
 */
export const AUDIT_ENTITY_TYPES = [
  'app_user',
  'expedition',
  'expedition_session',
  'expedition_version',
  'media_asset',
  'membership',
  'mission_type',
  'organisation',
  'participant',
  'score_event',
  'submission',
  'subscription',
  'team',
] as const;

/** The kind of row an entry is about. */
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * What each action is about.
 *
 * The entity type is not something a caller passes, it is something the
 * action already implies: `expedition.published` is always about an
 * `expedition_version`, and letting a caller say otherwise would only ever
 * produce an entry nobody can join back to a row. The writer reads it from
 * here.
 */
export const AUDIT_ENTITY_TYPE_BY_ACTION: Readonly<
  Record<AuditAction, AuditEntityType>
> = {
  'score.awarded': 'score_event',
  'score.deducted': 'score_event',
  'score.adjusted': 'score_event',
  'score.revoked': 'score_event',
  'score.recalculated': 'team',

  'organisation.updated': 'organisation',
  'member.invited': 'membership',
  'member.role-changed': 'membership',
  'member.revoked': 'membership',
  'subscription.changed': 'subscription',

  'expedition.created': 'expedition',
  'expedition.updated': 'expedition',
  'expedition.published': 'expedition_version',
  'expedition.unpublished': 'expedition_version',
  'expedition.deleted': 'expedition',
  'mission-type.created': 'mission_type',
  'mission-type.updated': 'mission_type',
  'mission-type.deleted': 'mission_type',

  'session.scheduled': 'expedition_session',
  'session.started': 'expedition_session',
  'session.paused': 'expedition_session',
  'session.resumed': 'expedition_session',
  'session.ended': 'expedition_session',
  'session.overridden': 'expedition_session',

  'participant.removed': 'participant',
  'participant.team-changed': 'participant',

  'submission.accepted': 'submission',
  'submission.rejected': 'submission',

  'media.deleted': 'media_asset',

  'auth.password-changed': 'app_user',
  'auth.session-revoked': 'app_user',
  'auth.device-revoked': 'participant',
  'platform-admin.granted': 'app_user',
  'platform-admin.revoked': 'app_user',
};

/** Returns true when the value is an action this file lists. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** Returns true when the action is a scoring change rather than an administrative one. */
export function isScoringAuditAction(action: AuditAction): action is ScoringAuditAction {
  return (SCORING_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/** What kind of row the action is about. */
export function entityTypeOf(action: AuditAction): AuditEntityType {
  return AUDIT_ENTITY_TYPE_BY_ACTION[action];
}
