/**
 * The runner (EXPD-015).
 *
 * One function plays a whole expedition with a class of fake teams and hands
 * back what happened. It is the only part of the engine that has a clock, a
 * random number and a loop in it, and it has them so that nothing else has to.
 *
 * ```ts
 * const report = simulateExpedition({ definition, teamCount: 5, seed: 'the-lake' });
 *
 * report.duration.medianSeconds;   // how long an afternoon of this takes
 * report.findings;                 // what would go wrong on the day
 * report.teams[0]?.stream;         // the sealed record, to verify and replay
 * ```
 *
 * **It plays the game through the engine's own doors and no others.** Every
 * mission state comes out of `applyMissionTransition` (EXPD-010), every
 * verdict out of `completeMission` (EXPD-011), every point out of
 * `applyScoreChange` (EXPD-012), every locked door out of
 * `evaluateProgression` (EXPD-013), and every line out of the stream's own
 * sealer (EXPD-014). Nothing here decides a game rule, so a run cannot pass
 * while the platform would fail, which is the only reason a test would trust
 * one.
 *
 * **Teams are played in step, by the simulated clock.** At each turn the team
 * furthest behind on its own clock moves. That costs nothing and buys the one
 * thing running them one after another could not: `first-to-complete-bonus`
 * (EXPD-012) means what it says, because whoever reaches a mission first in
 * simulated time reaches it first in the run.
 *
 * **The same seed gives the same run.** Each team's generator is seeded from
 * the run's seed and the team's own id, so adding a fourth team does not
 * change what the first three did, and a failing test replays exactly.
 */

import {
  isTerminalMissionState,
  type HintDefinition,
  type HintId,
  type MissionInstanceId,
  type MissionProgress,
  type ProgressionMission,
  type ProgressionSnapshot,
  type ReportedPosition,
  type Seconds,
  type StreamEntry,
  type TeamScore,
} from '@explorer/shared-types';

import { completeMission, type CompletionResult } from '../completion/complete.ts';
import {
  applyMissionTransition,
  createMissionProgress,
} from '../mission-state/machine.ts';
import { evaluateProgression } from '../progression/evaluate.ts';
import { teamSituation } from '../progression/situation.ts';
import { applyScoreChange, createTeamScore, type ScoreResult } from '../scoring/score.ts';
import { progressionEventsBetween } from '../stream/events.ts';
import {
  appendProgressionEvents,
  appendScoreEvents,
  openStream,
} from '../stream/seal.ts';
import { advanceClock, startClock, type SimulationClock } from './clock.ts';
import { findingsFor } from './findings.ts';
import { planSimulation, type PlannedMission, type SimulationPlan, type SimulationRequest } from './plan.ts';
import type { SimulatedIntent } from './players.ts';
import { createRandom, jitter, type Random } from './random.ts';
import {
  durationOf,
  type SimulatedMissionResult,
  type SimulatedTeamResult,
  type SimulationRefusal,
  type SimulationReport,
  type SimulationStop,
} from './report.ts';
import type { SimulatedTeam } from './teams.ts';

/** How much either side of a team's pace one mission may take. */
const PACE_SPREAD = 0.4;

/** How one team's run is going, while it is still going. */
interface TeamRun {
  readonly team: SimulatedTeam;
  readonly random: Random;
  clock: SimulationClock;
  /** Where the team stands on every mission they have a record of. */
  readonly progress: Map<MissionInstanceId, MissionProgress>;
  score: TeamScore;
  stream: readonly StreamEntry[];
  snapshot: ProgressionSnapshot | undefined;
  steps: number;
  stop: SimulationStop | undefined;
  readonly refusals: SimulationRefusal[];
  /** What each pending submission was meant to come to, for the teacher. */
  readonly intents: Map<MissionInstanceId, SimulatedIntent>;
  /** When a teacher will have looked at a mission, in elapsed seconds. */
  readonly reviewDueAt: Map<MissionInstanceId, Seconds>;
  /** The hints the team has opened, so none is opened twice. */
  readonly spentHints: Set<HintId>;
  readonly hintsOpened: Map<MissionInstanceId, number>;
  readonly firstTouchedAt: Map<MissionInstanceId, Seconds>;
  readonly endedAt: Map<MissionInstanceId, Seconds>;
  readonly secondsOn: Map<MissionInstanceId, Seconds>;
  /** Missions the engine would not let them play, so they stop trying. */
  readonly abandoned: Set<MissionInstanceId>;
}

/** What every team in one run shares. */
interface RunState {
  /** The missions somebody has already finished, for `first-to-complete`. */
  readonly completedByAnyone: Set<MissionInstanceId>;
}

/**
 * Plays an expedition with fake teams.
 *
 * The one entry point. A run always ends: every team stops on a finish, on
 * having nothing open to them, or on one of the two budgets in
 * `SimulationLimits`.
 */
export function simulateExpedition(request: SimulationRequest): SimulationReport {
  const plan = planSimulation(request);
  const shared: RunState = { completedByAnyone: new Set() };
  const runs = plan.teams.map((team) => openRun(plan, team));

  // The team furthest behind on its own clock moves next, so the run is
  // ordered by simulated time across every team at once.
  for (;;) {
    let next: TeamRun | undefined;
    for (const run of runs) {
      if (run.stop !== undefined) {
        continue;
      }
      if (next === undefined || run.clock.elapsedSeconds < next.clock.elapsedSeconds) {
        next = run;
      }
    }
    if (next === undefined) {
      break;
    }
    stepTeam(plan, next, shared);
  }

  const teams = runs.map((run) => resultOf(plan, run));
  const findings = findingsFor(plan, teams);

  return {
    seed: plan.seed,
    startedAt: plan.startedAt,
    judging: plan.judging,
    teams,
    duration: durationOf(teams),
    findings,
    playable: !findings.some((finding) => finding.severity === 'error'),
  };
}

/** A team at the beginning of the run. */
function openRun(plan: SimulationPlan, team: SimulatedTeam): TeamRun {
  return {
    team,
    // Seeded from the run and the team, so one team's luck never depends on
    // how many decisions another team happened to make first.
    random: createRandom(`${plan.seed}:${team.id}`),
    clock: startClock(plan.startedAt),
    progress: new Map(),
    score: createTeamScore(),
    stream: openStream(),
    snapshot: undefined,
    steps: 0,
    stop: undefined,
    refusals: [],
    intents: new Map(),
    reviewDueAt: new Map(),
    spentHints: new Set(),
    hintsOpened: new Map(),
    firstTouchedAt: new Map(),
    endedAt: new Map(),
    secondsOn: new Map(),
    abandoned: new Set(),
  };
}

/** Moves the team's clock on, and charges the time to a mission. */
function spend(run: TeamRun, missionInstanceId: MissionInstanceId, seconds: Seconds): void {
  if (seconds <= 0) {
    return;
  }
  run.clock = advanceClock(run.clock, seconds);
  run.secondsOn.set(
    missionInstanceId,
    (run.secondsOn.get(missionInstanceId) ?? 0) + Math.round(seconds),
  );
}

/** Where the team stands on one mission, or a fresh record when they have none. */
function progressFor(run: TeamRun, missionInstanceId: MissionInstanceId): MissionProgress {
  return run.progress.get(missionInstanceId) ?? createMissionProgress(missionInstanceId);
}

/** Works out where the team stands now, and writes down what that opened. */
function refreshProgression(plan: SimulationPlan, run: TeamRun): void {
  const after = evaluateProgression({
    policy: plan.progression,
    situation: teamSituation({
      missions: [...run.progress.values()],
      score: run.score,
      elapsedSeconds: run.clock.elapsedSeconds,
      routeIds: run.team.routeIds,
    }),
  });

  const events = progressionEventsBetween(run.snapshot, after, run.clock.now);
  if (events.length > 0) {
    run.stream = appendProgressionEvents(run.stream, events);
  }
  run.snapshot = after;
}

/** Keeps a refusal, so the report can say what the engine would not do. */
function noteRefusal(
  run: TeamRun,
  from: SimulationRefusal['from'],
  code: string,
  message: string,
  missionInstanceId?: MissionInstanceId,
): void {
  run.refusals.push({
    teamId: run.team.id,
    from,
    code,
    message,
    atSeconds: run.clock.elapsedSeconds,
    ...(missionInstanceId === undefined ? {} : { missionInstanceId }),
  });
}

/** One thing one team does. */
function stepTeam(plan: SimulationPlan, run: TeamRun, shared: RunState): void {
  run.steps += 1;

  // Always first, so that whatever the last action opened is in the record
  // before anything decides the team has nowhere to go.
  refreshProgression(plan, run);

  // In `free-roam` every stop is reached from the start, the finish
  // included, so reaching one says nothing about the team (EXPD-013). There,
  // a team is done when there is nothing left they can play, which is what
  // the bottom of this function works out. Everywhere else, reaching a finish
  // is what finishing means.
  if (run.snapshot?.finished === true && plan.progression.mode !== 'free-roam') {
    run.stop = 'finished';
    return;
  }
  if (run.steps > plan.limits.maxStepsPerTeam) {
    run.stop = 'step-budget';
    return;
  }
  if (run.clock.elapsedSeconds > plan.limits.maxSeconds) {
    run.stop = 'time-budget';
    return;
  }

  // A teacher who has had long enough looks now, before the team picks
  // anything else up.
  const due = dueReview(run);
  if (due !== undefined) {
    resolveReview(plan, run, due, shared);
    return;
  }

  const choice = chooseMission(plan, run);
  if (choice !== undefined) {
    playMission(plan, run, choice, shared);
    return;
  }

  // Nothing open. If a teacher still owes them a decision, the team waits for
  // it. Otherwise they have played everything they were allowed to play: that
  // is the end of the expedition when they have reached a finish, and being
  // left with nowhere to go when they have not.
  const waiting = nextReview(run);
  if (waiting === undefined) {
    run.stop = run.snapshot?.finished === true ? 'finished' : 'stuck';
    return;
  }
  spend(run, waiting.missionInstanceId, waiting.dueAt - run.clock.elapsedSeconds);
  resolveReview(plan, run, waiting.missionInstanceId, shared);
}

/** A mission whose teacher has had long enough, or `undefined`. */
function dueReview(run: TeamRun): MissionInstanceId | undefined {
  const next = nextReview(run);
  return next !== undefined && next.dueAt <= run.clock.elapsedSeconds
    ? next.missionInstanceId
    : undefined;
}

/** The review the team is waiting on that will come back first. */
function nextReview(
  run: TeamRun,
): { missionInstanceId: MissionInstanceId; dueAt: Seconds } | undefined {
  let soonest: { missionInstanceId: MissionInstanceId; dueAt: Seconds } | undefined;
  for (const [missionInstanceId, dueAt] of run.reviewDueAt) {
    if (progressFor(run, missionInstanceId).state !== 'awaiting-verification') {
      continue;
    }
    if (soonest === undefined || dueAt < soonest.dueAt) {
      soonest = { missionInstanceId, dueAt };
    }
  }
  return soonest;
}

/** The mission the team picks up next, or `undefined` when there is none. */
function chooseMission(plan: SimulationPlan, run: TeamRun): PlannedMission | undefined {
  const open: PlannedMission[] = [];
  for (const mission of run.snapshot?.missions ?? []) {
    const planned = playableMission(plan, run, mission);
    if (planned !== undefined) {
      open.push(planned);
    }
  }
  // Which of the open missions a team does first is up to them, so it is one
  // of the run's own decisions rather than document order. In `strict` there
  // is only ever one to pick from (EXPD-013).
  return run.random.pick(open);
}

/** The mission behind a snapshot entry, when the team could pick it up. */
function playableMission(
  plan: SimulationPlan,
  run: TeamRun,
  mission: ProgressionMission,
): PlannedMission | undefined {
  if (!mission.unlocked || run.abandoned.has(mission.missionInstanceId)) {
    return undefined;
  }
  const state = progressFor(run, mission.missionInstanceId).state;
  if (isTerminalMissionState(state) || state === 'awaiting-verification' || state === 'submitted') {
    return undefined;
  }
  return plan.missionsById.get(mission.missionInstanceId);
}

/** Where a team stands for a mission that names an area (EXPD-011). */
function positionFor(planned: PlannedMission): ReportedPosition | undefined {
  const constraint = planned.completionPolicy.location;
  if (constraint === null) {
    return undefined;
  }
  // A simulated team goes where the mission tells them. Teams that wander off
  // are a mission type's problem (EXPD-039) rather than the harness's.
  return {
    latitude: constraint.area.centre.latitude,
    longitude: constraint.area.centre.longitude,
  };
}

/** The next hint on a mission the team has not opened yet. */
function nextHint(planned: PlannedMission, run: TeamRun): HintDefinition | undefined {
  const hints = [...(planned.mission.hints ?? [])].sort((left, right) => left.order - right.order);
  return hints.find((hint) => !run.spentHints.has(hint.id));
}

/** Adds what a score change produced to the team's record and stream. */
function applyScore(
  run: TeamRun,
  result: ScoreResult,
  missionInstanceId?: MissionInstanceId,
): void {
  if (!result.applied) {
    noteRefusal(run, 'score', result.refusal.code, result.refusal.message, missionInstanceId);
    return;
  }
  run.score = result.score;
  if (result.events.length > 0) {
    run.stream = appendScoreEvents(run.stream, result.events);
  }
}

/** One team, one mission, from opening it to whatever the verdict was. */
function playMission(
  plan: SimulationPlan,
  run: TeamRun,
  planned: PlannedMission,
  shared: RunState,
): void {
  const missionInstanceId = planned.mission.id;
  let progress = progressFor(run, missionInstanceId);

  if (!run.firstTouchedAt.has(missionInstanceId)) {
    run.firstTouchedAt.set(missionInstanceId, run.clock.elapsedSeconds);
    spend(run, missionInstanceId, jitter(run.random, run.team.travelSeconds, PACE_SPREAD));
  }

  // Progression says the lock is off; the mission's own record has to be told
  // so, because a state only ever changes by a named trigger (EXPD-010).
  if (progress.state === 'locked') {
    const opened = applyMissionTransition(
      progress,
      { trigger: 'unlock', actor: 'engine', at: run.clock.now },
      planned.statePolicy,
    );
    if (!opened.applied) {
      noteRefusal(run, 'transition', opened.refusal.code, opened.refusal.message, missionInstanceId);
      run.abandoned.add(missionInstanceId);
      return;
    }
    progress = opened.progress;
    run.progress.set(missionInstanceId, progress);
  }

  if (plan.hintsEnabled && run.random.chance(run.team.usesHints)) {
    const hint = nextHint(planned, run);
    if (hint !== undefined) {
      run.spentHints.add(hint.id);
      run.hintsOpened.set(missionInstanceId, (run.hintsOpened.get(missionInstanceId) ?? 0) + 1);
      applyScore(
        run,
        applyScoreChange({
          kind: 'hint',
          score: run.score,
          at: run.clock.now,
          scoring: plan.scoring,
          missionInstanceId,
          hintId: hint.id,
        }),
        missionInstanceId,
      );
    }
  }

  const started = applyMissionTransition(
    progress,
    { trigger: 'start', actor: 'team', at: run.clock.now },
    planned.statePolicy,
  );
  if (!started.applied) {
    // No tries left, or a mission the rules will not open. Either way the
    // team cannot play it and stops trying.
    noteRefusal(run, 'transition', started.refusal.code, started.refusal.message, missionInstanceId);
    giveUpOn(run, planned);
    return;
  }
  progress = started.progress;
  run.progress.set(missionInstanceId, progress);

  const limit = planned.completionPolicy.timeLimitSeconds;
  const wanted = jitter(run.random, run.team.paceSeconds, PACE_SPREAD);

  if (limit !== null && wanted > limit) {
    // The team was still working when the mission's own clock ran out. The
    // interface checks that arithmetic itself, so the clock is moved to the
    // deadline exactly rather than to wherever the team had got to.
    spend(run, missionInstanceId, limit);
    finish(
      plan,
      run,
      planned,
      completeMission({
        kind: 'expiry',
        progress,
        at: run.clock.now,
        completionPolicy: planned.completionPolicy,
        statePolicy: planned.statePolicy,
      }),
      shared,
      'incorrect',
    );
    return;
  }

  spend(run, missionInstanceId, wanted);

  const position = positionFor(planned);
  const intent: SimulatedIntent = run.random.chance(run.team.skill) ? 'correct' : 'incorrect';
  const registered = plan.registry.get(
    planned.mission.missionTypeId,
    planned.mission.missionTypeVersion,
  );
  const payload =
    registered === undefined
      ? {}
      : planned.player({
          mission: planned.mission,
          definition: registered.definition,
          intent,
          attemptNumber: progress.attemptsUsed,
          random: run.random,
        });

  finish(
    plan,
    run,
    planned,
    completeMission({
      kind: 'submission',
      registry: plan.registry,
      mission: planned.mission,
      progress,
      payload,
      prepared: planned.prepared,
      at: run.clock.now,
      completionPolicy: planned.completionPolicy,
      statePolicy: planned.statePolicy,
      ...(position === undefined ? {} : { position }),
    }),
    shared,
    intent,
  );
}

/**
 * Takes a verdict, scores it, and decides what the team does next.
 *
 * The one place a completion result is read, so a submission, an expiry and a
 * teacher's decision all leave the run in the same shape.
 */
function finish(
  plan: SimulationPlan,
  run: TeamRun,
  planned: PlannedMission,
  result: CompletionResult,
  shared: RunState,
  intent: SimulatedIntent,
): void {
  const missionInstanceId = planned.mission.id;

  if (!result.applied) {
    noteRefusal(run, 'completion', result.refusal.code, result.refusal.message, missionInstanceId);
    giveUpOn(run, planned);
    return;
  }

  run.progress.set(missionInstanceId, result.progress);

  if (result.verdict.review === 'required') {
    // A person has to look, and that takes them as long as it takes them.
    run.intents.set(missionInstanceId, intent);
    run.reviewDueAt.set(missionInstanceId, run.clock.elapsedSeconds + plan.reviewSeconds);
    return;
  }

  scoreVerdict(plan, run, planned, result, shared);

  const state = result.progress.state;
  if (isTerminalMissionState(state)) {
    run.endedAt.set(missionInstanceId, run.clock.elapsedSeconds);
    return;
  }

  // A wrong answer they may try again. Whether they do is the team's own
  // patience, and walking away is only theirs to choose when the expedition
  // lets a mission be skipped at all (EXPD-010).
  if (planned.statePolicy.allowSkip && run.random.chance(run.team.givesUp)) {
    giveUpOn(run, planned);
  }
}

/** Puts a verdict through the scoring engine and keeps what it produced. */
function scoreVerdict(
  plan: SimulationPlan,
  run: TeamRun,
  planned: PlannedMission,
  result: Extract<CompletionResult, { applied: true }>,
  shared: RunState,
): void {
  const missionInstanceId = planned.mission.id;

  // Nobody has decided yet, so there is nothing to score. The scoring engine
  // says the same thing, and asking it would only add a refusal to the report
  // for something that is not a problem.
  if (result.verdict.outcome === 'needs-review') {
    return;
  }

  const firstToComplete =
    result.verdict.outcome === 'correct' && !shared.completedByAnyone.has(missionInstanceId);

  const lateBy =
    plan.penaliseLateWork && plan.totalTimeLimitSeconds !== null
      ? run.clock.elapsedSeconds - plan.totalTimeLimitSeconds
      : 0;

  applyScore(
    run,
    applyScoreChange({
      kind: 'mission',
      score: run.score,
      at: run.clock.now,
      scoring: plan.scoring,
      verdict: result.verdict,
      progress: result.progress,
      mission: planned.scoringPolicy,
      firstToComplete,
      ...(lateBy > 0 ? { lateBySeconds: lateBy } : {}),
    }),
    missionInstanceId,
  );

  if (result.verdict.outcome === 'correct') {
    shared.completedByAnyone.add(missionInstanceId);
  }
}

/** The teacher looks at a submission that was waiting on one (EXPD-056). */
function resolveReview(
  plan: SimulationPlan,
  run: TeamRun,
  missionInstanceId: MissionInstanceId,
  shared: RunState,
): void {
  const planned = plan.missionsById.get(missionInstanceId);
  if (planned === undefined) {
    run.reviewDueAt.delete(missionInstanceId);
    return;
  }

  // The teacher sees what the team actually did, which in a simulated run is
  // what the team meant to do. A harness that decided this on its own roll
  // would be modelling a teacher who gets it wrong, and nobody has asked for
  // one.
  const intent = run.intents.get(missionInstanceId) ?? 'incorrect';
  run.reviewDueAt.delete(missionInstanceId);
  run.intents.delete(missionInstanceId);

  finish(
    plan,
    run,
    planned,
    completeMission({
      kind: 'review',
      progress: progressFor(run, missionInstanceId),
      decision: intent === 'correct' ? 'approve' : 'reject',
      reason: 'Reviewed in a simulated run.',
      at: run.clock.now,
      statePolicy: planned.statePolicy,
    }),
    shared,
    intent,
  );
}

/**
 * The team stops trying at this mission.
 *
 * They skip it when the expedition lets them, which is a state the graph
 * treats as cleared (EXPD-013) so the rest of the expedition opens up.
 * When it does not, the mission is simply put down: the team will not pick it
 * up again, and if that leaves them nowhere to go the run reports it.
 */
function giveUpOn(run: TeamRun, planned: PlannedMission): void {
  const missionInstanceId = planned.mission.id;
  const skipped = applyMissionTransition(
    progressFor(run, missionInstanceId),
    { trigger: 'skip', actor: 'team', at: run.clock.now, reason: 'The simulated team moved on.' },
    planned.statePolicy,
  );

  if (skipped.applied) {
    run.progress.set(missionInstanceId, skipped.progress);
    run.endedAt.set(missionInstanceId, run.clock.elapsedSeconds);
    return;
  }

  run.abandoned.add(missionInstanceId);
}

/** What one team's run came to. */
function resultOf(plan: SimulationPlan, run: TeamRun): SimulatedTeamResult {
  const snapshot =
    run.snapshot ?? evaluateProgression({ policy: plan.progression, situation: undefined });

  const missions: SimulatedMissionResult[] = [];
  const completed: MissionInstanceId[] = [];
  const failed: MissionInstanceId[] = [];
  const skipped: MissionInstanceId[] = [];
  const unreached: MissionInstanceId[] = [];

  const reached = new Set(
    snapshot.missions.filter((mission) => mission.reached).map((mission) => mission.missionInstanceId),
  );
  const pointsByMission = new Map<MissionInstanceId, number>();
  for (const event of run.score.events) {
    if (event.missionInstanceId !== undefined) {
      pointsByMission.set(
        event.missionInstanceId,
        (pointsByMission.get(event.missionInstanceId) ?? 0) + event.points,
      );
    }
  }

  for (const planned of plan.missions) {
    const missionInstanceId = planned.mission.id;
    const progress = progressFor(run, missionInstanceId);

    if (!reached.has(missionInstanceId)) {
      unreached.push(missionInstanceId);
    }
    switch (progress.state) {
      case 'complete':
        completed.push(missionInstanceId);
        break;
      case 'failed':
        failed.push(missionInstanceId);
        break;
      case 'skipped':
        skipped.push(missionInstanceId);
        break;
      default:
        break;
    }

    missions.push({
      missionInstanceId,
      ...(planned.nodeId === undefined ? {} : { nodeId: planned.nodeId }),
      state: progress.state,
      attemptsUsed: progress.attemptsUsed,
      secondsSpent: run.secondsOn.get(missionInstanceId) ?? 0,
      ...(run.firstTouchedAt.get(missionInstanceId) === undefined
        ? {}
        : { startedAtSeconds: run.firstTouchedAt.get(missionInstanceId) }),
      ...(run.endedAt.get(missionInstanceId) === undefined
        ? {}
        : { endedAtSeconds: run.endedAt.get(missionInstanceId) }),
      points: pointsByMission.get(missionInstanceId) ?? 0,
      hintsOpened: run.hintsOpened.get(missionInstanceId) ?? 0,
    });
  }

  return {
    teamId: run.team.id,
    routeIds: run.team.routeIds,
    finished: snapshot.finished,
    stop: run.stop ?? 'stuck',
    elapsedSeconds: run.clock.elapsedSeconds,
    steps: run.steps,
    totalPoints: run.score.total,
    completedMissionIds: completed,
    failedMissionIds: failed,
    skippedMissionIds: skipped,
    unreachedMissionIds: unreached,
    missions,
    snapshot,
    score: run.score,
    missionProgress: [...run.progress.values()],
    stream: run.stream,
    refusals: run.refusals,
  };
}
