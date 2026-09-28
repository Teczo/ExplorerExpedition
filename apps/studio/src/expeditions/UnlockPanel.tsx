/**
 * Unlock conditions, routes and dependencies in the property panel (EXPD-029).
 *
 * `EdgeUnlock` is shown for a selected edge: what has to be true before a
 * team may take it, built up from tests and groups with no JSON, and which
 * teams may take it at all, by route. `NodeDependencies` is shown for a
 * selected node: every way into it and what each one waits on, and, for a
 * mission, the stops that wait on it.
 *
 * Both write through the pure functions in `unlock.ts`.
 */

import { useState } from 'react';
import type { ExpeditionEdge, ExpeditionNode, UnlockCondition, UnlockConditionType } from '@explorer/shared-types';

import { inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import type { GraphState } from './graph.ts';
import { Issues, NumberInput, Section } from './inputs.tsx';
import { issuesAt, type PropertyIssue } from './properties.ts';
import {
  CONDITION_LABELS,
  CONDITION_TYPES,
  addRoute,
  addToGroup,
  canNestAt,
  changeConditionType,
  describeCondition,
  edgesWaitingOn,
  isGroup,
  issuesOfEdge,
  issuesOfRoutes,
  newCondition,
  progressionOf,
  removeFromGroup,
  removeRoute,
  renameRoute,
  replaceInside,
  routesOf,
  setConditionMission,
  setConditionNumber,
  setEdgeCondition,
  setEdgeRoutes,
  toggleConditionMission,
  toggleEdgeRoute,
  waysInto,
} from './unlock.ts';

/** What the condition editor needs to name and pick missions. */
interface MissionChoice {
  readonly id: string;
  readonly name: string;
}

function missionChoices(state: GraphState): MissionChoice[] {
  return state.missions.map((mission) => ({ id: mission.id, name: mission.title.trim() === '' ? mission.id : mission.title }));
}

function nameOf(state: GraphState): (missionId: string) => string {
  const names = new Map(missionChoices(state).map((choice) => [choice.id, choice.name]));
  return (missionId) => names.get(missionId) ?? `missing "${missionId}"`;
}

// --- An edge ----------------------------------------------------------------

export function EdgeUnlock({
  state,
  edge,
  onChange,
}: {
  state: GraphState;
  edge: ExpeditionEdge;
  onChange: (next: GraphState) => void;
}) {
  const issues = issuesOfEdge(state, edge.id);
  const from = state.nodes.find((node) => node.id === edge.from);
  // A new test names the mission on the stop the edge leaves from, when there is one.
  const fallback = from?.kind === 'mission' ? from.missionInstanceId : (state.missions[0]?.id ?? '');
  const missions = missionChoices(state);

  return (
    <>
      <Section title="Opens when">
        {progressionOf(state) === 'free-roam' && (
          <p className="text-xs text-amber-300">
            This expedition is free roam, so every mission is open from the start and conditions are ignored in play.
          </p>
        )}
        <p className="text-xs text-slate-400">
          A team may take this edge once the stop before it is cleared
          {edge.condition === undefined ? '.' : ', and once this is true:'}
        </p>
        <ConditionEditor
          condition={edge.condition}
          depth={1}
          path="condition"
          issues={issues}
          missions={missions}
          fallbackMissionId={fallback}
          onChange={(condition) => onChange(setEdgeCondition(state, edge.id, condition))}
        />
        {edge.condition !== undefined && (
          <p className="text-xs text-slate-500">In short: {describeCondition(edge.condition, nameOf(state))}</p>
        )}
      </Section>
      <Section title="Which teams">
        <AudienceEditor state={state} edge={edge} issues={issuesAt(issues, 'audience')} onChange={onChange} />
      </Section>
    </>
  );
}

/**
 * One condition, and every condition inside it.
 *
 * At the top, "none" takes the condition off the edge. Inside a group,
 * "Always" is offered instead, because a group's members cannot be missing.
 */
function ConditionEditor({
  condition,
  depth,
  path,
  issues,
  missions,
  fallbackMissionId,
  onChange,
  onRemove,
}: {
  condition: UnlockCondition | undefined;
  depth: number;
  path: string;
  issues: readonly PropertyIssue[];
  missions: readonly MissionChoice[];
  fallbackMissionId: string;
  onChange: (condition: UnlockCondition | undefined) => void;
  onRemove?: () => void;
}) {
  const top = depth === 1;
  const here = issuesAt(issues, path);
  const choose = (value: string) => {
    if (value === '') {
      onChange(undefined);
      return;
    }
    const type = value as UnlockConditionType;
    onChange(condition === undefined ? newCondition(type, fallbackMissionId) : changeConditionType(condition, type, fallbackMissionId));
  };

  return (
    <div className={top ? 'space-y-2' : 'space-y-2 rounded-md border border-slate-800 p-2'}>
      <div className="flex items-end gap-2">
        <label className="block flex-1 text-xs text-slate-400">
          {top ? 'Condition' : 'Test'}
          <select className={inputClass} value={condition?.type ?? ''} onChange={(event) => choose(event.target.value)}>
            {top && <option value="">None — open once the stop before is cleared</option>}
            {CONDITION_TYPES.filter((type) => !(top && type === 'always')).map((type) => (
              <option key={type} value={type} disabled={isGroup(type) && !canNestAt(depth)}>
                {CONDITION_LABELS[type].name}
              </option>
            ))}
          </select>
        </label>
        {onRemove !== undefined && (
          <button type="button" className={secondaryButtonClass} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {condition !== undefined && <p className="text-xs text-slate-500">{CONDITION_LABELS[condition.type].help}</p>}
      {condition !== undefined && (
        <ConditionFields
          condition={condition}
          depth={depth}
          path={path}
          issues={issues}
          missions={missions}
          fallbackMissionId={fallbackMissionId}
          onChange={onChange}
        />
      )}
      {/* Problems with this condition's own fields; a group's members show their own. */}
      <Issues
        issues={here.filter(
          (issue) => !issue.path.startsWith(`${path}.conditions[`) && !issue.path.startsWith(`${path}.condition`),
        )}
      />
    </div>
  );
}

function ConditionFields({
  condition,
  depth,
  path,
  issues,
  missions,
  fallbackMissionId,
  onChange,
}: {
  condition: UnlockCondition;
  depth: number;
  path: string;
  issues: readonly PropertyIssue[];
  missions: readonly MissionChoice[];
  fallbackMissionId: string;
  onChange: (condition: UnlockCondition | undefined) => void;
}) {
  // Each number input keeps what was typed, so it starts afresh only when the
  // condition becomes a different type.
  const numberKey = `${path}:${condition.type}`;

  switch (condition.type) {
    case 'always':
      return null;

    case 'mission-completed':
    case 'mission-score-at-least':
      return (
        <div className="space-y-2">
          <MissionSelect
            missions={missions}
            value={condition.missionInstanceId}
            onChange={(missionId) => onChange(setConditionMission(condition, missionId))}
          />
          {condition.type === 'mission-score-at-least' && (
            <NumberInput
              key={numberKey}
              label="Points"
              initial={condition.points}
              rules={{ whole: true, min: 0 }}
              onValue={(value) => onChange(setConditionNumber(condition, 'points', value ?? 0))}
            />
          )}
        </div>
      );

    case 'total-score-at-least':
      return (
        <NumberInput
          key={numberKey}
          label="Points"
          initial={condition.points}
          rules={{ whole: true, min: 0 }}
          onValue={(value) => onChange(setConditionNumber(condition, 'points', value ?? 0))}
        />
      );

    case 'elapsed-time-at-least':
      return (
        <NumberInput
          key={numberKey}
          label="Seconds since the team started"
          initial={condition.seconds}
          rules={{ whole: true, min: 1 }}
          onValue={(value) => onChange(setConditionNumber(condition, 'seconds', value ?? 1))}
        />
      );

    case 'missions-completed-at-least':
      return (
        <div className="space-y-2">
          <NumberInput
            key={numberKey}
            label="How many must be finished"
            initial={condition.count}
            rules={{ whole: true, min: 1 }}
            onValue={(value) => onChange(setConditionNumber(condition, 'count', value ?? 1))}
          />
          <fieldset className="space-y-1 text-xs">
            <legend className="text-slate-400">Missions that count</legend>
            {missions.length === 0 && <p className="text-slate-500">This expedition has no missions yet.</p>}
            {missions.map((mission) => (
              <label key={mission.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={condition.missionInstanceIds.includes(mission.id as never)}
                  onChange={(event) => onChange(toggleConditionMission(condition, mission.id, event.target.checked))}
                />
                {mission.name}
              </label>
            ))}
          </fieldset>
        </div>
      );

    case 'all-of':
    case 'any-of':
      return (
        <div className="space-y-2 border-l border-slate-700 pl-2">
          {condition.conditions.length === 0 && (
            <p className="text-xs text-slate-500">
              Empty. {condition.type === 'all-of' ? 'An empty "all of" is always true.' : 'An empty "any of" is never true.'}
            </p>
          )}
          {condition.conditions.map((inner, index) => (
            <ConditionEditor
              // The length is in the key, so removing a test starts every
              // number input below it afresh instead of showing the removed one.
              key={`${index}-${condition.conditions.length}`}
              condition={inner}
              depth={depth + 1}
              path={`${path}.conditions[${index}]`}
              issues={issues}
              missions={missions}
              fallbackMissionId={fallbackMissionId}
              onChange={(next) => onChange(replaceInside(condition, index, next ?? { type: 'always' }))}
              onRemove={() => onChange(removeFromGroup(condition, index))}
            />
          ))}
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => onChange(addToGroup(condition, newCondition('mission-completed', fallbackMissionId)))}
          >
            Add test
          </button>
        </div>
      );

    case 'not':
      return (
        <div className="border-l border-slate-700 pl-2">
          <ConditionEditor
            condition={condition.condition}
            depth={depth + 1}
            path={`${path}.condition`}
            issues={issues}
            missions={missions}
            fallbackMissionId={fallbackMissionId}
            onChange={(next) => onChange(replaceInside(condition, 0, next ?? { type: 'always' }))}
          />
        </div>
      );
  }
}

function MissionSelect({
  missions,
  value,
  onChange,
}: {
  missions: readonly MissionChoice[];
  value: string;
  onChange: (missionId: string) => void;
}) {
  const known = missions.some((mission) => mission.id === value);
  return (
    <label className="block text-xs text-slate-400">
      Mission
      <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {!known && <option value={value}>{value === '' ? '(choose a mission)' : `missing "${value}"`}</option>}
        {missions.map((mission) => (
          <option key={mission.id} value={mission.id}>
            {mission.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Who may take the edge, and the expedition's routes. */
function AudienceEditor({
  state,
  edge,
  issues,
  onChange,
}: {
  state: GraphState;
  edge: ExpeditionEdge;
  issues: readonly PropertyIssue[];
  onChange: (next: GraphState) => void;
}) {
  const routes = routesOf(state);
  const named = edge.audience?.kind === 'routes' ? edge.audience.routeIds : null;
  const [newName, setNewName] = useState('');

  const add = () => {
    if (newName.trim() === '') return;
    const added = addRoute(state, newName);
    // A route added while this edge is for chosen routes is ticked for it.
    onChange(named === null ? added.state : toggleEdgeRoute(added.state, edge.id, added.routeId, true));
    setNewName('');
  };

  return (
    <div className="space-y-2 text-xs">
      <label className="flex items-center gap-1">
        <input type="radio" checked={named === null} onChange={() => onChange(setEdgeRoutes(state, edge.id, null))} />
        Every team
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" checked={named !== null} onChange={() => onChange(setEdgeRoutes(state, edge.id, []))} />
        Only teams on these routes
      </label>
      {named !== null && (
        <div className="space-y-1 pl-4">
          {routes.length === 0 && <p className="text-slate-500">No routes yet. Add one below.</p>}
          {routes.map((route) => (
            <label key={route.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={named.includes(route.id)}
                onChange={(event) => onChange(toggleEdgeRoute(state, edge.id, route.id, event.target.checked))}
              />
              {route.name.trim() === '' ? route.id : route.name}
            </label>
          ))}
        </div>
      )}
      <Issues issues={issues} />

      <details className="rounded-md border border-slate-800 p-2">
        <summary className="cursor-pointer text-slate-300">Routes in this expedition ({routes.length})</summary>
        <p className="mt-1 text-slate-500">
          A route is a way through the expedition that some teams are put on. An edge for chosen routes is taken only
          by teams on one of them.
        </p>
        <div className="mt-2 space-y-1">
          {routes.map((route) => (
            <div key={route.id} className="flex items-end gap-2">
              <label className="block flex-1 text-slate-400">
                <span className="font-mono">{route.id}</span>
                <input
                  className={inputClass}
                  value={route.name}
                  onChange={(event) => onChange(renameRoute(state, route.id, event.target.value))}
                />
              </label>
              <button type="button" className={secondaryButtonClass} onClick={() => onChange(removeRoute(state, route.id))}>
                Remove
              </button>
            </div>
          ))}
          <Issues issues={issuesOfRoutes(state)} />
          <div className="flex items-end gap-2">
            <label className="block flex-1 text-slate-400">
              New route name
              <input
                className={inputClass}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add();
                }}
              />
            </label>
            <button type="button" className={secondaryButtonClass} disabled={newName.trim() === ''} onClick={add}>
              Add route
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

// --- A node -----------------------------------------------------------------

/** What opens a stop, and, for a mission, what waits on it. */
export function NodeDependencies({
  state,
  node,
  onSelectEdge,
}: {
  state: GraphState;
  node: ExpeditionNode;
  onSelectEdge: (edgeId: string) => void;
}) {
  const names = nameOf(state);
  const nodeTitle = (nodeId: string) => state.nodes.find((candidate) => candidate.id === nodeId)?.title ?? nodeId;
  const ways = waysInto(state, node.id);
  const waiting = node.kind === 'mission' ? edgesWaitingOn(state, node.missionInstanceId) : [];

  if (node.kind === 'start') {
    return <p className="text-xs text-slate-400">Every team begins here, so nothing has to open it.</p>;
  }

  return (
    <div className="space-y-2 text-xs">
      {ways.length === 0 && <p className="text-amber-300">Nothing leads here, so no team can reach it.</p>}
      {ways.length > 1 && <p className="text-slate-400">It opens when any one of these ways in is open.</p>}
      <ul className="space-y-1">
        {ways.map((way) => (
          <li key={way.edge.id} className="rounded-md border border-slate-800 p-2">
            <button type="button" className="text-sky-300 hover:underline" onClick={() => onSelectEdge(way.edge.id)}>
              From {nodeTitle(way.edge.from)}
            </button>
            <ul className="mt-1 list-disc pl-4 text-slate-400">
              {way.clearFirst !== undefined && <li>{names(way.clearFirst)} is cleared (finished, failed or skipped)</li>}
              {way.edge.condition !== undefined && <li>when {describeCondition(way.edge.condition, names)}</li>}
              {way.edge.audience?.kind === 'routes' && (
                <li>only for routes: {way.edge.audience.routeIds.join(', ') || '(none)'}</li>
              )}
              {way.clearFirst === undefined && way.edge.condition === undefined && way.edge.audience === undefined && (
                <li>as soon as the team arrives</li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      {node.kind === 'mission' && (
        <div>
          <p className="text-slate-400">
            {waiting.length === 0 ? 'No condition waits on this mission.' : 'Conditions that name this mission:'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {waiting.map((edge) => (
              <li key={edge.id}>
                <button type="button" className="text-sky-300 hover:underline" onClick={() => onSelectEdge(edge.id)}>
                  {nodeTitle(edge.from)} → {nodeTitle(edge.to)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
