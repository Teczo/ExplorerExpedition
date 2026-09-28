/**
 * The expedition's scoring rules, and every change the scoring screen can
 * make to them (EXPD-028).
 *
 * A mission's own points, cap and partial credit, and the token cost of each
 * of its hints, are the property panel's (EXPD-027). This file is the rest of
 * how points are earned and lost: the bonuses and penalties in
 * `scoring.rules`, and the floor a team's total cannot fall under. A rule
 * aimed at every mission is expedition-wide; one aimed at named missions is
 * that mission's own.
 *
 * Every change is a pure function from one `GraphState` to the next, the same
 * as `graph.ts`. They write into `document.scoring` and keep every other field
 * of it (the leaderboard) exactly as it was read.
 */

import {
  SCORING_RULE_TYPES,
  validateExpeditionDefinition,
  type JsonObject,
  type MissionInstanceId,
  type ScoringRule,
  type ScoringRuleId,
  type ScoringRuleTarget,
  type ScoringRuleType,
} from '@explorer/shared-types';

import { freshId, toDocument, type GraphState } from './graph.ts';
import type { PropertyIssue } from './properties.ts';

/** How the screen names each rule, and says what it does. */
export const RULE_LABELS: Record<ScoringRuleType, { readonly name: string; readonly help: string }> = {
  'speed-bonus': { name: 'Speed bonus', help: 'Extra points for finishing a mission quickly.' },
  'first-to-complete-bonus': { name: 'First to finish', help: 'Extra points for the first team to finish a mission.' },
  'streak-bonus': { name: 'Streak bonus', help: 'Extra points for missions finished in a row with no failure.' },
  'completion-bonus': { name: 'Completion bonus', help: 'Extra points for finishing every mission the rule is for.' },
  'hint-penalty': { name: 'Hint cost', help: 'Points taken away for each hint a team opens.' },
  'attempt-penalty': { name: 'Wrong-answer penalty', help: 'Points taken away for each wrong try.' },
  'late-penalty': { name: 'Late penalty', help: 'Points taken away for finishing after the time limit.' },
};

/** A bonus adds points; a penalty takes them away. */
export function isPenalty(type: ScoringRuleType): boolean {
  return type === 'hint-penalty' || type === 'attempt-penalty' || type === 'late-penalty';
}

/** Whether a rule of this type picks the missions it applies to. The other two apply to the whole run. */
export function hasTarget(type: ScoringRuleType): boolean {
  return type !== 'streak-bonus' && type !== 'late-penalty';
}

/** One number a rule holds, as the screen asks for it. `min` is the schema's own. */
export interface RuleNumberField {
  readonly name: string;
  readonly label: string;
  readonly min: number;
}

/** The numbers each rule type holds, in the order the screen shows them. */
export const RULE_FIELDS: Record<ScoringRuleType, readonly RuleNumberField[]> = {
  'speed-bonus': [
    { name: 'withinSeconds', label: 'Finish within (s)', min: 1 },
    { name: 'points', label: 'Points added', min: 1 },
  ],
  'first-to-complete-bonus': [{ name: 'points', label: 'Points added', min: 1 }],
  'streak-bonus': [
    { name: 'length', label: 'Missions in a row', min: 2 },
    { name: 'points', label: 'Points added', min: 1 },
  ],
  'completion-bonus': [{ name: 'points', label: 'Points added', min: 1 }],
  'hint-penalty': [{ name: 'pointsPerHint', label: 'Points taken per hint', min: 1 }],
  'attempt-penalty': [{ name: 'pointsPerFailedAttempt', label: 'Points taken per wrong try', min: 1 }],
  'late-penalty': [
    { name: 'graceSeconds', label: 'Grace after the limit (s)', min: 0 },
    { name: 'pointsPerMinute', label: 'Points taken per minute late', min: 1 },
  ],
};

/** What a new rule of each type starts at. Every number is one the schema accepts. */
const STARTING_NUMBERS: Record<ScoringRuleType, Readonly<Record<string, number>>> = {
  'speed-bonus': { withinSeconds: 300, points: 10 },
  'first-to-complete-bonus': { points: 10 },
  'streak-bonus': { length: 3, points: 10 },
  'completion-bonus': { points: 20 },
  'hint-penalty': { pointsPerHint: 5 },
  'attempt-penalty': { pointsPerFailedAttempt: 2 },
  'late-penalty': { graceSeconds: 0, pointsPerMinute: 1 },
};

// --- Reading ----------------------------------------------------------------

/** The scoring rules, in the order they are applied. A document with none reads as empty. */
export function rulesOf(state: GraphState): ScoringRule[] {
  const rules = scoringObject(state)['rules'];
  return Array.isArray(rules)
    ? (rules.filter((rule) => typeof rule === 'object' && rule !== null && !Array.isArray(rule)) as unknown as ScoringRule[])
    : [];
}

/** The lowest total a team can end on, or `undefined` when the document has none yet. */
export function minimumTotalOf(state: GraphState): number | undefined {
  const value = scoringObject(state)['minimumTotal'];
  return typeof value === 'number' ? value : undefined;
}

/** The target of a rule, or `undefined` for a rule that applies to the whole run. */
export function targetOf(rule: ScoringRule): ScoringRuleTarget | undefined {
  return 'target' in rule ? rule.target : undefined;
}

/**
 * The rules that touch one mission: those aimed at every mission, and those
 * that name it. Rules with no target (streak, late) are left out, as they are
 * about the whole run rather than any one mission.
 */
export function rulesForMission(state: GraphState, missionId: string): ScoringRule[] {
  return rulesOf(state).filter((rule) => {
    const target = targetOf(rule);
    return target !== undefined && (target.kind === 'all' || target.missionInstanceIds.includes(missionId as MissionInstanceId));
  });
}

// --- Changing ---------------------------------------------------------------

/** Replaces the rules and leaves everything else in `scoring` as it was. */
function writeRules(state: GraphState, rules: readonly ScoringRule[]): GraphState {
  return writeScoring(state, { rules: rules as unknown as JsonObject[] });
}

function writeScoring(state: GraphState, patch: JsonObject): GraphState {
  const scoring = scoringObject(state);
  return {
    ...state,
    document: {
      ...state.document,
      // A document with no scoring yet is given the two fields every one
      // needs. The leaderboard is left to its own screen (EXPD-045).
      scoring: { rules: [], minimumTotal: 0, ...scoring, ...patch },
    },
  };
}

/**
 * Adds a rule at the end, with starting numbers the schema accepts.
 *
 * `missionId` aims it at that one mission; without it, a rule that picks
 * missions is aimed at every one. A rule that picks none ignores it.
 */
export function addRule(state: GraphState, type: ScoringRuleType, missionId?: string): { state: GraphState; ruleId: string } {
  const rules = rulesOf(state);
  const ruleId = freshId(type, rules.map((rule) => rule.id));
  const target: ScoringRuleTarget =
    missionId === undefined ? { kind: 'all' } : { kind: 'missions', missionInstanceIds: [missionId as MissionInstanceId] };
  const rule = {
    id: ruleId as ScoringRuleId,
    type,
    ...(hasTarget(type) ? { target } : {}),
    ...STARTING_NUMBERS[type],
  } as unknown as ScoringRule;
  return { state: writeRules(state, [...rules, rule]), ruleId };
}

export function removeRule(state: GraphState, ruleId: string): GraphState {
  return writeRules(state, rulesOf(state).filter((rule) => rule.id !== ruleId));
}

/** Swaps a rule with the one before (`-1`) or after (`1`) it. Order matters when a mission has a cap. */
export function moveRule(state: GraphState, ruleId: string, step: -1 | 1): GraphState {
  const rules = rulesOf(state);
  const at = rules.findIndex((rule) => rule.id === ruleId);
  const self = rules[at];
  const other = rules[at + step];
  if (self === undefined || other === undefined) {
    return state;
  }
  const next = [...rules];
  next[at] = other;
  next[at + step] = self;
  return writeRules(state, next);
}

/** Sets one of a rule's numbers. A name the rule's type does not hold is ignored. */
export function setRuleNumber(state: GraphState, ruleId: string, name: string, value: number): GraphState {
  return writeRules(
    state,
    rulesOf(state).map((rule) =>
      rule.id === ruleId && RULE_FIELDS[rule.type].some((field) => field.name === name)
        ? ({ ...rule, [name]: value } as unknown as ScoringRule)
        : rule,
    ),
  );
}

/** Aims a rule at every mission. A rule that picks no missions is left alone. */
export function aimAtAll(state: GraphState, ruleId: string): GraphState {
  return retarget(state, ruleId, () => ({ kind: 'all' }));
}

/**
 * Adds a mission to, or takes it out of, the missions a rule names.
 *
 * A rule aimed at every mission starts naming missions from this one. A rule
 * left naming none is kept that way, and the check says so.
 */
export function aimAtMission(state: GraphState, ruleId: string, missionId: string, on: boolean): GraphState {
  return retarget(state, ruleId, (target) => {
    const named = target.kind === 'missions' ? target.missionInstanceIds : [];
    const without = named.filter((id) => id !== missionId);
    return { kind: 'missions', missionInstanceIds: on ? [...without, missionId as MissionInstanceId] : without };
  });
}

function retarget(
  state: GraphState,
  ruleId: string,
  change: (target: ScoringRuleTarget) => ScoringRuleTarget,
): GraphState {
  return writeRules(
    state,
    rulesOf(state).map((rule) => {
      const target = targetOf(rule);
      return rule.id === ruleId && target !== undefined ? ({ ...rule, target: change(target) } as unknown as ScoringRule) : rule;
    }),
  );
}

export function setMinimumTotal(state: GraphState, value: number): GraphState {
  return writeScoring(state, { minimumTotal: value });
}

// --- What is wrong with it --------------------------------------------------

/**
 * Every problem `validateExpeditionDefinition` finds in `scoring`, with paths
 * made relative to it: `rules[0].points`, `minimumTotal`, `leaderboard`.
 */
export function issuesOfScoring(state: GraphState): PropertyIssue[] {
  const result = validateExpeditionDefinition(toDocument(state));
  if (result.valid) {
    return [];
  }
  return result.issues
    .filter((issue) => issue.path === 'scoring' || issue.path.startsWith('scoring.'))
    .map((issue) => ({ path: issue.path.slice('scoring'.length).replace(/^\./, ''), message: issue.message }));
}

/** The problems with one rule, with paths made relative to the rule. */
export function issuesOfRule(state: GraphState, issues: readonly PropertyIssue[], ruleId: string): PropertyIssue[] {
  const index = rulesOf(state).findIndex((rule) => rule.id === ruleId);
  const prefix = `rules[${index}]`;
  return issues
    .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
    .map((issue) => ({ ...issue, path: issue.path.slice(prefix.length).replace(/^\./, '') }));
}

/** Every rule type, in the order the schema lists them. */
export const RULE_TYPES: readonly ScoringRuleType[] = SCORING_RULE_TYPES;

function scoringObject(state: GraphState): JsonObject {
  const scoring = state.document['scoring'];
  return typeof scoring === 'object' && scoring !== null && !Array.isArray(scoring) ? (scoring as JsonObject) : {};
}
