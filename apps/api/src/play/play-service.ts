/**
 * What a team playing a mission actually does (EXPD-020).
 *
 * Four things: start a try, hand work in, open a hint, and — for a teacher —
 * decide on work that was waiting for one. **The engine decides every one of
 * them.** Whether a try may start is the state machine's (EXPD-010), what the
 * work was is the completion interface's (EXPD-011), what it was worth is the
 * scoring engine's (EXPD-012), and what it opened is progression's
 * (EXPD-013). This file reads the rows those need, asks, and writes down the
 * answer. It has no opinion of its own about any of them, and a refusal from
 * any of them is a `409` carrying the engine's own code.
 *
 * Three things are the API's, because the engine holds no clock and knows
 * nothing about any other team:
 *
 *   **The run has to be being played.** A device may only play while its run
 *   is `running`. A paused run has stopped its clock, and play that happened
 *   off the clock would be play nobody is timing. A teacher may decide on
 *   waiting work while the run is running, paused, or over: a queue of photos
 *   is often marked after the bell.
 *
 *   **The clocks.** A mission's `cooldownSeconds` is a clock in front of
 *   `start`, which EXPD-010 says whoever holds the clock applies. The run's
 *   time limit decides whether work is late, and the expedition's
 *   `latePolicy` decides what that means — refused, accepted, or accepted
 *   with the `late-penalty` rule told how late (EXPD-012).
 *
 *   **Every other team.** Whether this team was the first to finish a
 *   mission is a fact about the others, so it is read here and handed to the
 *   scoring engine, which is what EXPD-012 asks for.
 *
 * **Nothing is stored that the engine did not produce.** A mission state is
 * never a column: every line of every mission's history is kept in
 * `mission_transition`, and the state is replayed from it on every request
 * (`mission-log.ts`). Every point is a sealed line in the team's stream
 * (EXPD-014), and so is every door that opened. `mission_attempt` and
 * `submission` are the rows the rest of the platform points at — the review
 * queue (EXPD-056), a photo (EXPD-044) — and they say what the engine said.
 *
 * **One transaction, and the team is locked first.** Every write here reads
 * the team row `FOR UPDATE` before it reads anything else about the team, so
 * two phones pressing submit at the same moment are played one after the
 * other rather than both building on the same history. A refusal writes
 * nothing at all.
 */

import {
  allowedMissionTriggers,
  applyMissionTransition,
  applyScoreChange,
  completeMission,
  createMissionProgress,
  DEFAULT_MISSION_STATE_POLICY,
  evaluateProgression,
  expeditionScoringPolicyFor,
  missionCompletionPolicyFor,
  missionScoringPolicyFor,
  missionStatePolicyFor,
  progressionEventsBetween,
  progressionPolicyFor,
  replayTeamScore,
  teamSituation,
  type CompletionResult,
  type ExpeditionScoringPolicy,
  type MissionCompletionPolicy,
  type MissionStatePolicy,
  type MissionTypeEntry,
  type ProgressionPolicy,
  type ScoreResult,
} from '@explorer/engine';
import {
  isTerminalMissionState,
  toId,
  type CompletionVerdict,
  type DevicePrincipal,
  type ExpeditionDefinition,
  type ExpeditionRules,
  type HintDefinition,
  type JsonObject,
  type MissionInstance,
  type MissionInstanceId,
  type MissionProgress,
  type MissionState,
  type MissionTransition,
  type MissionTransitionRefusal,
  type ProgressionSnapshot,
  type ReportedPosition,
  type ScoreEvent,
  type ScoringRuleId,
  type TeamScore,
  type UserPrincipal,
} from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound, type EngineRefusal } from '../http/errors.ts';
import type {
  AttemptStatus,
  ExpeditionSessionRow,
  MissionAttemptRow,
  MissionInstanceRow,
  SubmissionRow,
  SubmissionStatus,
  TeamPlayRow,
} from '../repositories/rows.ts';
import { clockOf } from '../sessions/session-service.ts';
import type { SessionClock } from '../sessions/session-clock.ts';
import { timingRulesOf } from '../sessions/timing-rules.ts';
import { TeamStream } from '../stream/team-stream.ts';
import { rebuildMissions } from './mission-log.ts';
import { registryForMission } from './mission-types.ts';
import { PlayRepository, type TeamScope } from './play-repository.ts';
import {
  toAttemptView,
  toMissionView,
  toProgressionView,
  toSubmissionView,
  type HintView,
  type PlayView,
} from './views.ts';

/** What a team hands in. */
export interface SubmitInput {
  /** The answer, in whatever shape the mission type asks for. */
  readonly payload: JsonObject;
  /** Where the phone said it was, when it said. */
  readonly position?: ReportedPosition;
  /**
   * When the phone recorded it, which is not when the server got it if the
   * phone had no signal (EXPD-048). Kept on the row; the engine is judged at
   * the time the server received it, because that is the only clock the API
   * can vouch for.
   */
  readonly submittedAt?: Date;
}

/** Which hint a team asks for. */
export interface HintInput {
  /** A hint by its document id. The next unopened one, in order, when absent. */
  readonly hintId?: string;
}

/** What a teacher decided about work that was waiting on one. */
export interface DecisionInput {
  readonly decision: 'approve' | 'reject';
  /** Why, in the teacher's own words. Kept in the history and on the row. */
  readonly note?: string;
}

/** Who is playing: a student's phone, with the team it is on. */
type Player =
  | { readonly kind: 'device'; readonly principal: DevicePrincipal }
  | { readonly kind: 'teacher'; readonly principal: UserPrincipal };

/** Everything one request reads before it asks the engine anything. */
interface PlayContext {
  readonly repo: PlayRepository;
  readonly stream: TeamStream;
  readonly scope: TeamScope;
  readonly session: ExpeditionSessionRow;
  readonly definition: ExpeditionDefinition;
  readonly rules: ExpeditionRules;
  readonly team: TeamPlayRow;
  readonly participantId: string | null;
  readonly mission: MissionInstance;
  readonly missionRow: MissionInstanceRow;
  readonly missions: Map<MissionInstanceId, MissionProgress>;
  readonly progress: MissionProgress;
  readonly statePolicy: MissionStatePolicy;
  readonly completionPolicy: MissionCompletionPolicy;
  readonly scoring: ExpeditionScoringPolicy;
  readonly progression: ProgressionPolicy;
  readonly clock: SessionClock;
  readonly score: TeamScore;
  readonly spentHints: ReadonlySet<string>;
  /** Where the team stands on the graph before this request changes anything. */
  readonly current: ProgressionSnapshot;
  /**
   * What the stream says the team had already been shown.
   *
   * `undefined` until the first progression line is written, so the first
   * change a team makes writes down the doors the expedition opened with.
   */
  readonly before: ProgressionSnapshot | undefined;
  /** The number the next history line takes. */
  readonly nextSequence: number;
  readonly now: Date;
}

/** The states of a run a phone may play in. */
const PLAYABLE_BY_TEAM: readonly string[] = ['running'];

/** The states of a run a teacher may decide on waiting work in. */
const DECIDABLE_BY_TEACHER: readonly string[] = ['running', 'paused', 'ended'];

/** What one request playing a mission may do. */
export class PlayService {
  readonly #db: Queryable;
  readonly #repo: PlayRepository;
  readonly #tenant: TenantRepository;
  readonly #missionTypes: TenantRepository;
  readonly #coded: readonly MissionTypeEntry[];
  readonly #audit: AuditLog;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Queryable;
    readonly tenant: TenantRepository;
    /**
     * The same organisation, with the platform-wide rows visible. Only read
     * from, and only for `mission_type`: `qr-hunt` belongs to the platform.
     */
    readonly missionTypes: TenantRepository;
    /** Mission types that come as code, with a behaviour to judge with. */
    readonly coded?: readonly MissionTypeEntry[];
    readonly audit: AuditLog;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#tenant = options.tenant;
    this.#repo = new PlayRepository(options.tenant);
    this.#missionTypes = options.missionTypes;
    this.#coded = options.coded ?? [];
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  // --- A team starts a try --------------------------------------------------

  /**
   * Opens a new try at a mission.
   *
   * Progression says whether the lock is off; the state machine says whether
   * a try may start. A mission whose lock has come off since the team last
   * looked is told so first, with an `unlock` in its history, because a state
   * only ever changes by a named trigger (EXPD-010).
   */
  async start(principal: DevicePrincipal, sessionId: string, missionId: string): Promise<PlayView> {
    return inTransaction(this.#db, async (tx) => {
      const context = await this.#load(tx, { kind: 'device', principal }, sessionId, missionId);
      const at = context.now.toISOString();

      const entry = context.current.missions.find(
        (mission) => mission.missionInstanceId === context.mission.id,
      );
      if (entry === undefined || !entry.unlocked) {
        throw new ApiError('conflict', {
          message: 'This mission is still locked for your team.',
          detail: `team ${context.team.id}: ${context.mission.id} is not unlocked`,
          refusal: {
            code: 'locked',
            blockedBy: entry?.blockedBy ?? [],
          },
        });
      }

      let progress = context.progress;
      const written: MissionTransition[] = [];

      if (progress.state === 'locked') {
        const opened = applyMissionTransition(
          progress,
          { trigger: 'unlock', actor: 'engine', at },
          context.statePolicy,
        );
        if (!opened.applied) {
          throw refusedByMachine(opened.refusal);
        }
        progress = opened.progress;
        written.push(opened.transition);
      }

      assertCooledDown(context.mission, progress, context.now);

      const started = applyMissionTransition(
        progress,
        { trigger: 'start', actor: 'team', at },
        context.statePolicy,
      );
      if (!started.applied) {
        throw refusedByMachine(started.refusal);
      }
      progress = started.progress;

      const limit = context.completionPolicy.timeLimitSeconds;
      const attempt = await context.repo.insertAttempt(context.scope, {
        missionInstanceId: context.missionRow.id,
        openedBy: context.participantId,
        attemptNumber: progress.attemptsUsed,
        startedAt: context.now,
        deadlineAt: limit === null ? null : new Date(context.now.getTime() + limit * 1000),
      });

      let sequence = context.nextSequence;
      if (written.length > 0) {
        await context.repo.appendTransitions(
          context.scope,
          context.mission.id,
          written,
          sequence,
          null,
        );
        sequence += written.length;
      }
      await context.repo.appendTransitions(
        context.scope,
        context.mission.id,
        [started.transition],
        sequence,
        attempt.id,
      );

      const progression = await this.#advance(context, progress, context.score);

      return {
        teamId: context.team.id,
        mission: missionViewOf(progress, context.statePolicy),
        attempt: toAttemptView(attempt),
        score: { total: context.score.total, events: [] },
        progression,
      };
    });
  }

  // --- A team hands work in -------------------------------------------------

  /**
   * Hands work in for the try that is running.
   *
   * The completion interface judges it and the state machine moves the
   * mission; the scoring engine then says what it was worth, unless a person
   * still has to look, in which case nothing is scored until they have. A
   * refusal — the wrong place, the wrong shape, a mission not running — is
   * `409` with the engine's code, and writes nothing: work that was refused
   * was not judged, and is not a try spent.
   */
  async submit(
    principal: DevicePrincipal,
    sessionId: string,
    missionId: string,
    input: SubmitInput,
  ): Promise<PlayView> {
    return inTransaction(this.#db, async (tx) => {
      const context = await this.#load(tx, { kind: 'device', principal }, sessionId, missionId);
      const at = context.now.toISOString();

      const late = lateness(context);
      if (late.refused) {
        throw new ApiError('conflict', {
          message: 'The time for this expedition is up, and it does not take late work.',
          detail: `run ${context.session.id} is past its limit; latePolicy is reject`,
          refusal: { code: 'late' },
        });
      }

      const registry = await registryForMission(
        this.#missionTypes.withConnection(tx),
        this.#coded,
        context.mission.missionTypeId,
        context.mission.missionTypeVersion,
      );

      const result = completeMission({
        kind: 'submission',
        registry,
        mission: context.mission,
        progress: context.progress,
        payload: input.payload,
        ...(input.position === undefined ? {} : { position: input.position }),
        at,
        completionPolicy: context.completionPolicy,
        statePolicy: context.statePolicy,
      });
      if (!result.applied) {
        throw refusedByEngine(result.refusal);
      }

      const attempt = await this.#runningAttempt(context);
      const submission = await context.repo.insertSubmission({
        missionAttemptId: attempt.id,
        participantId: context.participantId,
        payload: input.payload,
        status: SUBMISSION_STATUS_BY_OUTCOME[result.verdict.outcome],
        isLate: late.late,
        submittedAt: input.submittedAt ?? context.now,
        receivedAt: context.now,
      });

      await context.repo.appendTransitions(
        context.scope,
        context.mission.id,
        result.transitions,
        context.nextSequence,
        attempt.id,
      );

      return this.#settle(context, result, attempt, submission, {
        ...(late.lateBySeconds === undefined ? {} : { lateBySeconds: late.lateBySeconds }),
        submissionId: submission.id,
      });
    });
  }

  // --- A team opens a hint --------------------------------------------------

  /**
   * Opens a hint on a mission the team may play.
   *
   * What it costs in points is the scoring engine's (`hint-penalty`, EXPD-012)
   * and is charged the moment the hint is opened. Asking again for a hint the
   * team already opened shows it again and charges nothing — the engine will
   * not charge for one twice, and hiding text a team has already paid for
   * would only make them pay for it in a different way.
   *
   * What it costs in tokens is EXPD-046's, and nothing here counts them.
   */
  async openHint(
    principal: DevicePrincipal,
    sessionId: string,
    missionId: string,
    input: HintInput,
  ): Promise<PlayView> {
    return inTransaction(this.#db, async (tx) => {
      const context = await this.#load(tx, { kind: 'device', principal }, sessionId, missionId);

      if (context.rules.hints?.enabled !== true) {
        throw new ApiError('conflict', {
          message: 'This expedition does not hand out hints.',
          detail: `run ${context.session.id}: rules.hints.enabled is not true`,
          refusal: { code: 'hints-disabled' },
        });
      }

      const entry = context.current.missions.find(
        (mission) => mission.missionInstanceId === context.mission.id,
      );
      if (entry === undefined || !entry.unlocked || isTerminalMissionState(context.progress.state)) {
        throw new ApiError('conflict', {
          message: 'Hints are only for a mission your team can still play.',
          detail: `team ${context.team.id}: ${context.mission.id} is ${context.progress.state}`,
          refusal: { code: 'mission-not-open', state: context.progress.state },
        });
      }

      const hint = pickHint(context.mission, context.spentHints, input.hintId);
      const attempt = await context.repo.findLatestAttempt(context.team.id, context.missionRow.id);

      if (context.spentHints.has(hint.id)) {
        return {
          teamId: context.team.id,
          mission: missionViewOf(context.progress, context.statePolicy),
          attempt: attempt === null ? null : toAttemptView(attempt),
          hint: hintView(hint, true),
          score: { total: context.score.total, events: [] },
          progression: toProgressionView([], context.current),
        };
      }

      const scored = applyScoreChange({
        kind: 'hint',
        score: context.score,
        at: context.now.toISOString(),
        scoring: context.scoring,
        missionInstanceId: context.mission.id,
        hintId: hint.id,
      });
      if (!scored.applied) {
        throw refusedByEngine(scored.refusal);
      }

      await context.repo.insertHintRequest(context.scope, {
        participantId: context.participantId,
        missionInstanceKey: context.mission.id,
        hintKey: hint.id,
        openedAt: context.now,
      });

      const hintRowId = await context.repo.findHintId(context.missionRow.id, hint.id);
      await context.stream.appendScore(scored.events, {
        participantId: context.participantId,
        missionInstanceId: context.missionRow.id,
        missionAttemptId: attempt?.id ?? null,
        hintId: hintRowId,
      });
      await this.#saveScore(context, scored.score);

      const progression = await this.#advance(context, context.progress, scored.score);

      return {
        teamId: context.team.id,
        mission: missionViewOf(context.progress, context.statePolicy),
        attempt: attempt === null ? null : toAttemptView(attempt),
        hint: hintView(hint, false),
        score: { total: scored.score.total, events: scored.events },
        progression,
      };
    });
  }

  // --- A teacher decides ----------------------------------------------------

  /**
   * Marks waiting work as complete, or sends it back.
   *
   * The work is waiting because the engine referred it to a person — a photo,
   * a physical challenge, a mission type with no code. The teacher's decision
   * goes through the same door everything else does (`kind: 'review'`), so
   * the state machine decides whether there is anything to decide: work that
   * is not waiting for anybody is refused with `not-now`.
   */
  async decide(
    principal: UserPrincipal,
    sessionId: string,
    teamId: string,
    missionId: string,
    input: DecisionInput,
  ): Promise<PlayView> {
    return inTransaction(this.#db, async (tx) => {
      const context = await this.#load(
        tx,
        { kind: 'teacher', principal },
        sessionId,
        missionId,
        teamId,
      );

      const result = completeMission({
        kind: 'review',
        progress: context.progress,
        decision: input.decision,
        ...(input.note === undefined ? {} : { reason: input.note }),
        at: context.now.toISOString(),
        statePolicy: context.statePolicy,
      });
      if (!result.applied) {
        throw refusedByEngine(result.refusal);
      }

      const attempt = await this.#runningAttempt(context);
      const waiting = await context.repo.findSubmissionAwaitingReview(attempt.id);
      const status = input.decision === 'approve' ? 'accepted' : 'rejected';
      const reviewed =
        waiting === null
          ? null
          : await context.repo.recordReview(waiting.id, {
              status,
              reviewedAt: context.now,
              reviewedBy: principal.userId,
              note: input.note ?? null,
            });

      await context.repo.appendTransitions(
        context.scope,
        context.mission.id,
        result.transitions,
        context.nextSequence,
        attempt.id,
      );

      if (waiting !== null) {
        await this.#audit
          .withConnection(tx)
          .record(input.decision === 'approve' ? 'submission.accepted' : 'submission.rejected', {
            entityId: waiting.id,
            before: { status: waiting.status },
            after: { status, reviewed_by: principal.userId },
            ...(input.note === undefined ? {} : { note: input.note }),
          });
      }

      return this.#settle(context, result, attempt, reviewed ?? undefined, {
        ...(reviewed === null ? {} : { submissionId: reviewed.id }),
      });
    });
  }

  // --- The pieces the four share --------------------------------------------

  /**
   * Reads everything a request needs, in the order that makes it safe.
   *
   * The run first, then the team — locked — and only then anything about the
   * team, so that nothing read below can be changed by another request before
   * this one has written.
   */
  async #load(
    tx: Queryable,
    player: Player,
    sessionId: string,
    missionId: string,
    teamId?: string,
  ): Promise<PlayContext> {
    const repo = this.#repo.withConnection(tx);
    const now = this.#now();

    const session = await repo.findSession(sessionId);
    if (session === null) {
      throw notFound('run');
    }

    let participantId: string | null = null;
    let resolvedTeamId: string;

    if (player.kind === 'device') {
      // A phone belongs to one run. Another run's id is not found, for the
      // reason EXPD-017 gives for answering 404 rather than 403.
      if (player.principal.expeditionSessionId !== session.id) {
        throw notFound('run');
      }
      if (!PLAYABLE_BY_TEAM.includes(session.status)) {
        throw runNotPlayable(session);
      }
      const participant = await repo.findParticipant(session.id, player.principal.participantId);
      if (participant === null || participant.status === 'removed' || participant.status === 'left') {
        throw new ApiError('conflict', {
          message: 'This phone is no longer in the run.',
          detail: `participant ${player.principal.participantId} is not in run ${session.id}`,
          refusal: { code: 'not-in-run' },
        });
      }
      const membership = await repo.findLiveMembership(participant.id);
      if (membership === null) {
        throw new ApiError('conflict', {
          message: 'You are not on a team yet. Your teacher puts you on one.',
          detail: `participant ${participant.id} has no live team membership`,
          refusal: { code: 'no-team' },
        });
      }
      participantId = participant.id;
      resolvedTeamId = membership.team_id;
    } else {
      if (!DECIDABLE_BY_TEACHER.includes(session.status)) {
        throw runNotPlayable(session);
      }
      resolvedTeamId = teamId ?? '';
    }

    const scope: TeamScope = { teamId: resolvedTeamId, expeditionSessionId: session.id };
    const team = await repo.findTeam(scope, { forUpdate: true });
    if (team === null) {
      throw notFound('team');
    }

    const version = await repo.findPinnedVersion(session.expedition_version_id);
    if (version === null) {
      throw new Error(`run ${session.id} is pinned to a revision that cannot be read`);
    }
    const definition = version.definition as unknown as ExpeditionDefinition;
    const rules = definition.rules ?? ({} as ExpeditionRules);
    const byId = new Map<MissionInstanceId, MissionInstance>(
      (definition.missions ?? []).map((mission) => [mission.id, mission]),
    );

    const mission = byId.get(toId<'missionInstance'>(missionId));
    if (mission === undefined) {
      throw notFound('mission');
    }
    const missionRow = await repo.findMissionInstance(version.id, mission.id);
    if (missionRow === null) {
      throw new Error(
        `revision ${version.id} has no mission_instance row for ${mission.id}; ` +
          'a published revision always has its flat copy (EXPD-017)',
      );
    }

    const policyFor = (id: MissionInstanceId): MissionStatePolicy => {
      const found = byId.get(id);
      return found === undefined ? DEFAULT_MISSION_STATE_POLICY : missionStatePolicyFor(found, rules);
    };

    const transitionRows = await repo.listTransitions(team.id);
    const missions = rebuildMissions(team.id, transitionRows, policyFor);
    const nextSequence =
      transitionRows.reduce((highest, row) => Math.max(highest, Number(row.sequence)), 0) + 1;

    const stream = new TeamStream(this.#tenant, {
      teamId: team.id,
      expeditionSessionId: session.id,
    }).withConnection(tx);
    const lines = await stream.read();
    const hintRows = await repo.listHintRequests(team.id);
    const spentHints = new Set(hintRows.map((row) => row.hint_key));

    const score = teamScoreOf(lines.length === 0 ? [] : replayTeamScore(lines).events, team, missions, [
      ...spentHints,
    ].map((id) => toId<'hint'>(id)));

    const clock = clockOf(session, timingRulesOf(version.definition), now);
    const progression = progressionPolicyFor(definition);
    const current = evaluateProgression({
      policy: progression,
      situation: teamSituation({
        missions: [...missions.values()],
        score,
        elapsedSeconds: clock.elapsedSeconds ?? 0,
      }),
    });

    return {
      repo,
      stream,
      scope,
      session,
      definition,
      rules,
      team,
      participantId,
      mission,
      missionRow,
      missions,
      progress: missions.get(mission.id) ?? createMissionProgress(mission.id),
      statePolicy: missionStatePolicyFor(mission, rules),
      completionPolicy: missionCompletionPolicyFor(mission, rules),
      scoring: expeditionScoringPolicyFor(definition),
      progression,
      clock,
      score,
      spentHints,
      current,
      before: lines.some((line) => line.kind === 'progression') ? current : undefined,
      nextSequence,
      now,
    };
  }

  /**
   * The try a verdict is about: the newest one, which the state machine has
   * just said was running or waiting.
   */
  async #runningAttempt(context: PlayContext): Promise<MissionAttemptRow> {
    const attempt = await context.repo.findLatestAttempt(context.team.id, context.missionRow.id);
    if (attempt === null) {
      throw new Error(
        `team ${context.team.id} has a history for ${context.mission.id} and no attempt row`,
      );
    }
    return attempt;
  }

  /**
   * Scores a verdict, and writes down where it left the try and the team.
   *
   * Shared by a submission and a teacher's decision, so the two leave the
   * rows in the same shape. Nothing is scored while a person still has to
   * look: the scoring engine says the same, and asking it would only be told.
   */
  async #settle(
    context: PlayContext,
    result: Extract<CompletionResult, { applied: true }>,
    attempt: MissionAttemptRow,
    submission: SubmissionRow | undefined,
    extra: { readonly lateBySeconds?: number; readonly submissionId?: string },
  ): Promise<PlayView> {
    const { verdict, progress } = result;
    let score = context.score;
    let events: readonly ScoreEvent[] = [];

    if (verdict.outcome !== 'needs-review') {
      const firstToComplete =
        verdict.outcome === 'correct' &&
        !(await context.repo.completedByAnotherTeam(
          context.session.id,
          context.missionRow.id,
          context.team.id,
        ));

      const scored: ScoreResult = applyScoreChange({
        kind: 'mission',
        score,
        at: context.now.toISOString(),
        scoring: context.scoring,
        verdict,
        progress,
        mission: missionScoringPolicyFor(context.mission),
        firstToComplete,
        ...(extra.lateBySeconds === undefined ? {} : { lateBySeconds: extra.lateBySeconds }),
      });
      if (!scored.applied) {
        throw refusedByEngine(scored.refusal);
      }
      score = scored.score;
      events = scored.events;

      await context.stream.appendScore(events, {
        participantId: context.participantId,
        missionInstanceId: context.missionRow.id,
        missionAttemptId: attempt.id,
        submissionId: extra.submissionId ?? null,
      });
      await this.#saveScore(context, score);
    }

    const settled = await context.repo.updateAttempt(attempt.id, {
      status: attemptStatusOf(progress.state),
      completedAt: SETTLED_ATTEMPT.includes(attemptStatusOf(progress.state)) ? context.now : null,
      ...(verdict.outcome === 'needs-review'
        ? {}
        : { awardedPoints: events.reduce((sum, event) => sum + event.points, 0) }),
    });

    const progression = await this.#advance(context, progress, score);

    return {
      teamId: context.team.id,
      mission: missionViewOf(progress, context.statePolicy),
      attempt: toAttemptView(settled ?? attempt),
      ...(submission === undefined ? {} : { submission: toSubmissionView(submission) }),
      verdict,
      score: { total: score.total, events },
      progression,
    };
  }

  /** Writes the total and the three running counts back onto the team. */
  async #saveScore(context: PlayContext, score: TeamScore): Promise<void> {
    await context.repo.updateTeamScore(context.team.id, {
      totalScore: score.total,
      streak: score.streak,
      longestStreak: score.longestStreak,
      failedAttempts: score.failedAttempts,
    });
  }

  /**
   * Works out where the team stands after the change, and writes down every
   * door it opened (EXPD-013, EXPD-014).
   */
  async #advance(
    context: PlayContext,
    progress: MissionProgress,
    score: TeamScore,
  ): Promise<ReturnType<typeof toProgressionView>> {
    const missions = new Map(context.missions);
    missions.set(progress.missionInstanceId, progress);

    const after = evaluateProgression({
      policy: context.progression,
      situation: teamSituation({
        missions: [...missions.values()],
        score,
        elapsedSeconds: context.clock.elapsedSeconds ?? 0,
      }),
    });

    const opened = progressionEventsBetween(context.before, after, context.now.toISOString());
    await context.stream.appendProgression(opened);
    return toProgressionView(opened, after);
  }
}

/** What a submission row says, for each thing the engine concluded. */
const SUBMISSION_STATUS_BY_OUTCOME: Readonly<
  Record<CompletionVerdict['outcome'], SubmissionStatus>
> = {
  correct: 'accepted',
  incorrect: 'rejected',
  'needs-review': 'needs-review',
  expired: 'rejected',
};

/** The attempt statuses that mean a try is over. 0001 wants a time on those. */
const SETTLED_ATTEMPT: readonly AttemptStatus[] = ['succeeded', 'failed', 'expired', 'skipped'];

/**
 * Where a try stands, read off where the mission was left.
 *
 * A wrong answer with tries left hands the mission back as `available`, and
 * the try that was wrong is over: that is `failed` for the try, and the
 * mission has another go in it.
 */
function attemptStatusOf(state: MissionState): AttemptStatus {
  switch (state) {
    case 'complete':
      return 'succeeded';
    case 'awaiting-verification':
      return 'awaiting-review';
    case 'submitted':
      return 'submitted';
    case 'in-progress':
      return 'open';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

/**
 * The team's score, as the engine takes it.
 *
 * The total and every event come from the stream, because the stream is the
 * record (EXPD-014). The rest is what `replayTeamScore` cannot rebuild, and
 * says so: the missions paid for are the ones that are `complete`, the hints
 * are the ones in `hint_request`, the completion bonuses already paid are in
 * the stream, and the three running counts are on the team row (0006).
 */
function teamScoreOf(
  events: readonly ScoreEvent[],
  team: TeamPlayRow,
  missions: ReadonlyMap<MissionInstanceId, MissionProgress>,
  spentHintIds: TeamScore['spentHintIds'],
): TeamScore {
  const completedMissionIds = [...missions.values()]
    .filter((progress) => progress.state === 'complete')
    .map((progress) => progress.missionInstanceId);
  const awardedRuleIds: ScoringRuleId[] = [];
  for (const event of events) {
    if (event.reason === 'completion-bonus' && event.scoringRuleId !== undefined) {
      awardedRuleIds.push(event.scoringRuleId);
    }
  }

  return {
    total: events.reduce((sum, event) => sum + event.points, 0),
    completedMissionIds,
    spentHintIds,
    awardedRuleIds,
    streak: Number(team.streak ?? 0),
    longestStreak: Number(team.longest_streak ?? 0),
    failedAttempts: Number(team.failed_attempts ?? 0),
    events,
  };
}

/**
 * Whether work handed in now is late, and what the expedition says about it.
 *
 * Late means the run's clock says its time is up (EXPD-019). A run with no
 * limit is never late.
 */
function lateness(context: PlayContext): {
  readonly late: boolean;
  readonly refused: boolean;
  readonly lateBySeconds?: number;
} {
  const { clock } = context;
  if (!clock.expired || clock.limitSeconds === null || clock.elapsedSeconds === null) {
    return { late: false, refused: false };
  }
  const policy = context.rules.submissions?.latePolicy ?? 'accept';
  if (policy === 'reject') {
    return { late: true, refused: true };
  }
  return policy === 'accept-with-penalty'
    ? { late: true, refused: false, lateBySeconds: clock.elapsedSeconds - clock.limitSeconds }
    : { late: true, refused: false };
}

/**
 * Refuses a start that comes too soon after a wrong answer.
 *
 * `cooldownSeconds` is a clock in front of `start`, and EXPD-010 leaves it to
 * whoever holds the clock. The wait is measured from the line that handed the
 * mission back.
 */
function assertCooledDown(mission: MissionInstance, progress: MissionProgress, now: Date): void {
  const cooldown = mission.attempts?.cooldownSeconds ?? 0;
  if (cooldown <= 0) {
    return;
  }
  const handedBack = [...progress.log]
    .reverse()
    .find((line) => line.trigger === 'reject' || line.trigger === 'overrule');
  if (handedBack === undefined) {
    return;
  }
  const readyAt = new Date(Date.parse(handedBack.at) + cooldown * 1000);
  if (readyAt.getTime() > now.getTime()) {
    throw new ApiError('conflict', {
      message: 'Wait a moment before trying this mission again.',
      detail: `mission ${mission.id} cools down until ${readyAt.toISOString()}`,
      refusal: { code: 'cooling-down', readyAt: readyAt.toISOString() },
    });
  }
}

/** The hint asked for, or the next one the team has not opened. */
function pickHint(
  mission: MissionInstance,
  spent: ReadonlySet<string>,
  hintId: string | undefined,
): HintDefinition {
  const hints = [...(mission.hints ?? [])].sort((one, other) => one.order - other.order);
  if (hintId !== undefined) {
    const found = hints.find((hint) => hint.id === hintId);
    if (found === undefined) {
      throw notFound('hint');
    }
    return found;
  }
  const next = hints.find((hint) => !spent.has(hint.id));
  if (next === undefined) {
    throw new ApiError('conflict', {
      message:
        hints.length === 0
          ? 'This mission has no hints.'
          : 'Your team has opened every hint on this mission.',
      detail: `mission ${mission.id}: no unopened hint`,
      refusal: { code: 'no-hints-left' },
    });
  }
  return next;
}

function hintView(hint: HintDefinition, alreadyOpened: boolean): HintView {
  return {
    id: hint.id,
    text: hint.text,
    order: hint.order,
    tokenCost: hint.tokenCost ?? 0,
    alreadyOpened,
  };
}

function missionViewOf(progress: MissionProgress, policy: MissionStatePolicy) {
  return toMissionView(progress, allowedMissionTriggers(progress, policy));
}

/** A run a request cannot play in, and the state it is really in. */
function runNotPlayable(session: ExpeditionSessionRow): ApiError {
  return new ApiError('conflict', {
    message:
      session.status === 'paused'
        ? 'The run is paused. Play carries on when your teacher resumes it.'
        : session.status === 'ended' || session.status === 'cancelled'
          ? 'This run is over.'
          : 'This run has not started yet.',
    detail: `run ${session.id} is ${session.status}`,
    refusal: { code: 'run-not-playing', status: session.status },
  });
}

/** A refusal the state machine made, as a `409`. */
function refusedByMachine(refusal: MissionTransitionRefusal): ApiError {
  return new ApiError('conflict', {
    message: refusal.message,
    detail: `mission state machine refused ${refusal.trigger} in ${refusal.state}: ${refusal.code}`,
    refusal: { ...refusal } as EngineRefusal,
  });
}

/** A refusal the completion interface or the scoring engine made, as a `409`. */
function refusedByEngine(refusal: { readonly code: string; readonly message: string }): ApiError {
  return new ApiError('conflict', {
    message: refusal.message,
    detail: `engine refused: ${refusal.code}`,
    refusal: { ...refusal } as EngineRefusal,
  });
}
