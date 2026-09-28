/**
 * The scoring screen (EXPD-028): bonuses, penalties and hint costs for the
 * whole expedition, and for one mission at a time.
 *
 * `ScoringPanel` is the expedition's: every rule in the order it is applied,
 * and the lowest total a team can end on. `MissionRules` sits in the property
 * panel and shows only the rules that touch the selected mission, so an
 * author can give one mission its own bonus or penalty without leaving it.
 *
 * Both write through the pure functions in `scoring.ts`. A mission's own
 * points and the token cost of its hints stay in the property panel.
 */

import { useState } from 'react';
import type { ScoringRule, ScoringRuleType } from '@explorer/shared-types';

import { inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import type { GraphState } from './graph.ts';
import { Issues, NumberInput, Section } from './inputs.tsx';
import type { PropertyIssue } from './properties.ts';
import {
  RULE_FIELDS,
  RULE_LABELS,
  RULE_TYPES,
  addRule,
  aimAtAll,
  aimAtMission,
  hasTarget,
  isPenalty,
  issuesOfRule,
  issuesOfScoring,
  minimumTotalOf,
  moveRule,
  removeRule,
  rulesForMission,
  rulesOf,
  setMinimumTotal,
  setRuleNumber,
  targetOf,
} from './scoring.ts';

export function ScoringPanel({
  state,
  onChange,
  onClose,
}: {
  state: GraphState;
  onChange: (next: GraphState) => void;
  onClose: () => void;
}) {
  const rules = rulesOf(state);
  const issues = issuesOfScoring(state);
  const ruleIssuePaths = /^rules\[\d+\]/;

  return (
    <aside className="rounded-lg border border-slate-800 p-4 text-sm" aria-label="Scoring rules">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Scoring rules</h2>
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Bonuses and penalties for the whole expedition. Each mission's own points and hint token costs are set on the
        mission itself.
      </p>

      <div className="mt-3 space-y-3">
        <Section title="Floor">
          <NumberInput
            label="Lowest total a team can end on (penalties stop here)"
            initial={minimumTotalOf(state)}
            rules={{ whole: true }}
            onValue={(value) => onChange(setMinimumTotal(state, value ?? 0))}
          />
          <Issues issues={issues.filter((issue) => issue.path === 'minimumTotal')} />
        </Section>

        <Section title={`Rules (${rules.length})`}>
          {rules.length > 1 && (
            <p className="text-xs text-slate-500">
              Rules are applied top to bottom. The order matters when a mission has a points cap.
            </p>
          )}
          {rules.map((rule, index) => (
            <RuleCard
              key={rule.id}
              state={state}
              rule={rule}
              issues={issuesOfRule(state, issues, rule.id)}
              first={index === 0}
              last={index === rules.length - 1}
              onChange={onChange}
            />
          ))}
          <Issues issues={issues.filter((issue) => issue.path === 'rules')} />
          <AddRule onAdd={(type) => onChange(addRule(state, type).state)} />
        </Section>

        <Issues
          issues={issues.filter(
            (issue) => issue.path !== 'minimumTotal' && issue.path !== 'rules' && !ruleIssuePaths.test(issue.path),
          )}
        />
      </div>
    </aside>
  );
}

/**
 * The rules that touch one mission, for the property panel. A rule aimed at
 * every mission is shown too, and says that changing it changes it for all.
 */
export function MissionRules({
  state,
  missionId,
  onChange,
}: {
  state: GraphState;
  missionId: string;
  onChange: (next: GraphState) => void;
}) {
  const rules = rulesForMission(state, missionId);
  const all = rulesOf(state);
  const issues = issuesOfScoring(state);
  return (
    <div className="space-y-2">
      {rules.length === 0 && <p className="text-xs text-slate-400">No bonus or penalty touches this mission.</p>}
      {rules.map((rule) => {
        const index = all.findIndex((candidate) => candidate.id === rule.id);
        return (
          <RuleCard
            key={rule.id}
            state={state}
            rule={rule}
            issues={issuesOfRule(state, issues, rule.id)}
            first={index === 0}
            last={index === all.length - 1}
            onChange={onChange}
          />
        );
      })}
      <AddRule
        types={RULE_TYPES.filter(hasTarget)}
        label="Add for this mission"
        onAdd={(type) => onChange(addRule(state, type, missionId).state)}
      />
      <p className="text-xs text-slate-500">Streak and late rules are about the whole run; set them under Scoring rules.</p>
    </div>
  );
}

function RuleCard({
  state,
  rule,
  issues,
  first,
  last,
  onChange,
}: {
  state: GraphState;
  rule: ScoringRule;
  issues: readonly PropertyIssue[];
  first: boolean;
  last: boolean;
  onChange: (next: GraphState) => void;
}) {
  const label = RULE_LABELS[rule.type];
  const values = rule as unknown as Record<string, unknown>;
  return (
    <div className="space-y-2 rounded-md border border-slate-800 p-2">
      <div className="flex items-baseline justify-between gap-2">
        <p>
          <span className={isPenalty(rule.type) ? 'text-amber-300' : 'text-emerald-300'}>{label.name}</span>{' '}
          <span className="font-mono text-xs text-slate-500">{rule.id}</span>
        </p>
      </div>
      <p className="text-xs text-slate-400">{label.help}</p>
      <div className="grid grid-cols-2 gap-2">
        {RULE_FIELDS[rule.type].map((field) => {
          const value = values[field.name];
          return (
            <NumberInput
              key={field.name}
              label={field.label}
              initial={typeof value === 'number' ? value : undefined}
              rules={{ whole: true, min: field.min }}
              onValue={(read) => {
                if (read !== undefined) onChange(setRuleNumber(state, rule.id, field.name, read));
              }}
            />
          );
        })}
      </div>
      <TargetEditor state={state} rule={rule} onChange={onChange} />
      <Issues issues={issues} />
      <div className="flex gap-2">
        <button
          type="button"
          className={`${secondaryButtonClass} disabled:opacity-40`}
          disabled={first}
          aria-label="Apply this rule earlier"
          onClick={() => onChange(moveRule(state, rule.id, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          className={`${secondaryButtonClass} disabled:opacity-40`}
          disabled={last}
          aria-label="Apply this rule later"
          onClick={() => onChange(moveRule(state, rule.id, 1))}
        >
          ↓
        </button>
        <button type="button" className={secondaryButtonClass} onClick={() => onChange(removeRule(state, rule.id))}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** Which missions a rule applies to: every one, or those ticked. */
function TargetEditor({
  state,
  rule,
  onChange,
}: {
  state: GraphState;
  rule: ScoringRule;
  onChange: (next: GraphState) => void;
}) {
  const target = targetOf(rule);
  if (target === undefined) {
    return <p className="text-xs text-slate-500">Applies to the whole run.</p>;
  }
  const named = target.kind === 'missions' ? target.missionInstanceIds : [];
  return (
    <div className="space-y-1 text-xs text-slate-400">
      <label className="flex items-center gap-1">
        <input
          type="radio"
          checked={target.kind === 'all'}
          onChange={() => onChange(aimAtAll(state, rule.id))}
        />
        Every mission
      </label>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          checked={target.kind === 'missions'}
          onChange={() => {
            const firstMission = state.missions[0];
            if (target.kind === 'all' && firstMission !== undefined) {
              onChange(aimAtMission(state, rule.id, firstMission.id, true));
            }
          }}
        />
        Only these missions
      </label>
      {target.kind === 'missions' && (
        <div className="ml-5 space-y-0.5">
          {state.missions.map((mission) => (
            <label key={mission.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={named.includes(mission.id)}
                onChange={(event) => onChange(aimAtMission(state, rule.id, mission.id, event.target.checked))}
              />
              {mission.title.trim() === '' ? mission.id : mission.title}
            </label>
          ))}
          {named
            .filter((id) => !state.missions.some((mission) => mission.id === id))
            .map((id) => (
              <label key={id} className="flex items-center gap-1 text-red-300">
                <input type="checkbox" checked onChange={() => onChange(aimAtMission(state, rule.id, id, false))} />
                <span className="font-mono">{id}</span> (no longer in the expedition)
              </label>
            ))}
        </div>
      )}
      {target.kind === 'all' && (
        <p className="text-slate-500">Changing this rule changes it for every mission.</p>
      )}
    </div>
  );
}

function AddRule({
  types = RULE_TYPES,
  label = 'Add rule',
  onAdd,
}: {
  types?: readonly ScoringRuleType[];
  label?: string;
  onAdd: (type: ScoringRuleType) => void;
}) {
  const [type, setType] = useState<ScoringRuleType>(types[0] ?? 'speed-bonus');
  return (
    <div className="flex items-end gap-2">
      <label className="block flex-1 text-xs text-slate-400">
        New bonus or penalty
        <select
          className={inputClass}
          value={type}
          onChange={(event) => setType(event.target.value as ScoringRuleType)}
        >
          {types.map((candidate) => (
            <option key={candidate} value={candidate}>
              {RULE_LABELS[candidate].name} ({isPenalty(candidate) ? 'penalty' : 'bonus'})
            </option>
          ))}
        </select>
      </label>
      <button type="button" className={secondaryButtonClass} onClick={() => onAdd(type)}>
        {label}
      </button>
    </div>
  );
}
