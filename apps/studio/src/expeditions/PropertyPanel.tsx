/**
 * The property panel (EXPD-027): the right-hand side of the graph editor.
 *
 * It edits whatever is selected on the canvas. For every node, its name. For
 * a mission node, also the mission it holds: the words students see, how it
 * is judged, scoring, attempts, time limit, hints, and the settings its type
 * asks for, drawn as a form from the type's config schema. Its bonuses and
 * penalties are the scoring screen's (EXPD-028), shown here for this mission.
 * For an edge, its label.
 *
 * Every input writes straight into the editor's state through the pure
 * functions in `properties.ts` and `graph.ts`, so the problems list and the
 * canvas follow as the author types. A number that does not read yet is kept
 * in its input and not written, with the reason under it.
 */

import { useState } from 'react';
import {
  VERIFICATION_MODES,
  type ExpeditionEdge,
  type ExpeditionNode,
  type JsonValue,
  type MissionInstance,
  type VerificationMode,
} from '@explorer/shared-types';

import type { MissionTypeView } from '../mission-types/api.ts';
import { fieldsFromSchema, type FieldDraft } from '../mission-types/fields.ts';
import { inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import { missionOf, renameNode, roleOf, setEdgeLabel, setMissionFlag, type GraphState } from './graph.ts';
import { Issues, NumberInput, Section } from './inputs.tsx';
import { MissionRules } from './ScoringPanel.tsx';
import {
  addHint,
  hintsInOrder,
  issuesAt,
  issuesOfMission,
  moveHint,
  readConfigJson,
  removeHint,
  setAttempts,
  setConfig,
  setConfigValue,
  setMissionText,
  setScoring,
  setTimeLimit,
  setVerification,
  typeOf,
  updateHint,
  type PropertyIssue,
} from './properties.ts';

const VERIFICATION_LABELS: Record<VerificationMode, string> = {
  automatic: 'Automatic — the engine decides',
  teacher: 'Teacher — a teacher reviews it first',
  'automatic-with-review': 'Automatic, and a teacher may overrule it',
};

export function PropertyPanel({
  state,
  node,
  edge,
  missionTypes,
  onChange,
  onRemove,
}: {
  state: GraphState;
  node: ExpeditionNode | undefined;
  edge: ExpeditionEdge | undefined;
  missionTypes: readonly MissionTypeView[];
  onChange: (next: GraphState) => void;
  onRemove: () => void;
}) {
  return (
    <aside className="rounded-lg border border-slate-800 p-4 text-sm" aria-label="Properties">
      <h2 className="font-semibold">Properties</h2>
      {node !== undefined && (
        <NodeProperties
          // A new node starts the inputs afresh, so a half-typed number never
          // carries over to another mission.
          key={node.id}
          state={state}
          node={node}
          missionTypes={missionTypes}
          onChange={onChange}
          onRemove={onRemove}
        />
      )}
      {edge !== undefined && (
        <div className="mt-2 space-y-2">
          <label className="block text-xs text-slate-400">
            Label on the edge
            <input
              className={inputClass}
              value={edge.label ?? ''}
              onChange={(event) => onChange(setEdgeLabel(state, edge.id, event.target.value))}
            />
          </label>
          {(edge.condition !== undefined || edge.audience !== undefined) && (
            <p className="text-xs text-amber-300">This edge has a condition or a route. They are kept as they are.</p>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onRemove}>
            Remove edge
          </button>
        </div>
      )}
      {node === undefined && edge === undefined && (
        <p className="mt-2 text-slate-400">Click a node or an edge on the canvas to edit it here.</p>
      )}
    </aside>
  );
}

function NodeProperties({
  state,
  node,
  missionTypes,
  onChange,
  onRemove,
}: {
  state: GraphState;
  node: ExpeditionNode;
  missionTypes: readonly MissionTypeView[];
  onChange: (next: GraphState) => void;
  onRemove: () => void;
}) {
  const mission = missionOf(state, node);
  return (
    <div className="mt-2 space-y-3">
      <p className="text-xs text-slate-400">
        {roleOf(node)} · <span className="font-mono">{node.id}</span>
      </p>
      <label className="block text-xs text-slate-400">
        Name on the canvas (for authors; students do not see it)
        <input
          className={inputClass}
          value={node.title}
          onChange={(event) => onChange(renameNode(state, node.id, event.target.value))}
        />
      </label>
      {node.kind === 'mission' && (
        <div className="flex gap-4">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={node.secret === true}
              onChange={(event) => onChange(setMissionFlag(state, node.id, 'secret', event.target.checked))}
            />
            Secret — hidden until it opens
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={node.boss === true}
              onChange={(event) => onChange(setMissionFlag(state, node.id, 'boss', event.target.checked))}
            />
            Boss
          </label>
        </div>
      )}
      {node.kind === 'mission' && mission === undefined && (
        <p className="text-xs text-red-300">
          This node points at mission <span className="font-mono">{node.missionInstanceId}</span>, which is not in
          the expedition.
        </p>
      )}
      {mission !== undefined && (
        <MissionProperties state={state} mission={mission} missionTypes={missionTypes} onChange={onChange} />
      )}
      <button type="button" className={secondaryButtonClass} onClick={onRemove}>
        Remove node
      </button>
    </div>
  );
}

function MissionProperties({
  state,
  mission,
  missionTypes,
  onChange,
}: {
  state: GraphState;
  mission: MissionInstance;
  missionTypes: readonly MissionTypeView[];
  onChange: (next: GraphState) => void;
}) {
  const type = typeOf(missionTypes, mission);
  const issues = issuesOfMission(state, mission.id, type);
  const id = mission.id;

  return (
    <>
      <Section title="Mission">
        <p className="text-xs text-slate-400">
          Type: {type?.name ?? 'unknown'}{' '}
          <span className="font-mono">
            {mission.missionTypeId}@{mission.missionTypeVersion}
          </span>
        </p>
        <Issues issues={issues.filter((issue) => issue.path === '')} />
        <label className="block text-xs text-slate-400">
          Title (students see this)
          <input
            className={inputClass}
            value={mission.title}
            onChange={(event) => onChange(setMissionText(state, id, 'title', event.target.value))}
          />
        </label>
        <Issues issues={issuesAt(issues, 'title')} />
        <label className="block text-xs text-slate-400">
          Brief (on the mission board)
          <textarea
            className={inputClass}
            rows={2}
            value={mission.brief}
            onChange={(event) => onChange(setMissionText(state, id, 'brief', event.target.value))}
          />
        </label>
        <Issues issues={issuesAt(issues, 'brief')} />
        <label className="block text-xs text-slate-400">
          Instructions (once a team opens it; optional)
          <textarea
            className={inputClass}
            rows={4}
            value={mission.instructions ?? ''}
            onChange={(event) => onChange(setMissionText(state, id, 'instructions', event.target.value))}
          />
        </label>
        <Issues issues={issuesAt(issues, 'instructions')} />
      </Section>

      <Section title="Settings for this type">
        <ConfigEditor
          type={type}
          mission={mission}
          issues={issuesAt(issues, 'config')}
          onValue={(name, value) => onChange(setConfigValue(state, id, name, value))}
          onWhole={(config) => onChange(setConfig(state, id, config))}
        />
      </Section>

      <Section title="Judging">
        <label className="block text-xs text-slate-400">
          How a team's work is judged
          <select
            className={inputClass}
            value={mission.verification}
            onChange={(event) => onChange(setVerification(state, id, event.target.value as VerificationMode))}
          >
            {VERIFICATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {VERIFICATION_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <Issues issues={issuesAt(issues, 'verification')} />
      </Section>

      <Section title="Scoring">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="Points"
            initial={mission.scoring.basePoints}
            rules={{ whole: true, min: 0 }}
            onValue={(value) => onChange(setScoring(state, id, { ...mission.scoring, basePoints: value ?? 0 }))}
          />
          <NumberInput
            label="Cap (optional)"
            initial={mission.scoring.maxPoints}
            rules={{ whole: true, min: 0, optional: true }}
            onValue={(value) => onChange(setScoring(state, id, { ...mission.scoring, maxPoints: value }))}
          />
        </div>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={mission.scoring.allowPartialCredit}
            onChange={(event) =>
              onChange(setScoring(state, id, { ...mission.scoring, allowPartialCredit: event.target.checked }))
            }
          />
          Partial credit — a partly right answer earns part of the points
        </label>
        <Issues issues={issuesAt(issues, 'scoring')} />
      </Section>

      <Section title="Bonuses and penalties">
        <MissionRules state={state} missionId={id} onChange={onChange} />
      </Section>

      <Section title="Attempts and time">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="Tries (empty: no limit)"
            initial={mission.attempts.maxAttempts ?? undefined}
            rules={{ whole: true, min: 1, optional: true }}
            onValue={(value) => onChange(setAttempts(state, id, { ...mission.attempts, maxAttempts: value ?? null }))}
          />
          <NumberInput
            label="Wait after a wrong try (s)"
            initial={mission.attempts.cooldownSeconds}
            rules={{ whole: true, min: 0, optional: true }}
            onValue={(value) => onChange(setAttempts(state, id, { ...mission.attempts, cooldownSeconds: value }))}
          />
          <NumberInput
            label="Time limit (s; empty: none)"
            initial={mission.timeLimitSeconds}
            rules={{ whole: true, min: 1, optional: true }}
            onValue={(value) => onChange(setTimeLimit(state, id, value))}
          />
        </div>
        <Issues issues={[...issuesAt(issues, 'attempts'), ...issuesAt(issues, 'timeLimitSeconds')]} />
      </Section>

      <Section title={`Hints (${mission.hints.length})`}>
        <HintList state={state} mission={mission} issues={issuesAt(issues, 'hints')} onChange={onChange} />
      </Section>

      {(mission.media.length > 0 || mission.location !== undefined) && (
        <p className="text-xs text-slate-500">
          {mission.media.length > 0 && `${mission.media.length} media item(s)`}
          {mission.media.length > 0 && mission.location !== undefined && ' and '}
          {mission.location !== undefined && 'a location'} are kept as they are. Other screens edit them.
        </p>
      )}
    </>
  );
}

function HintList({
  state,
  mission,
  issues,
  onChange,
}: {
  state: GraphState;
  mission: MissionInstance;
  issues: readonly PropertyIssue[];
  onChange: (next: GraphState) => void;
}) {
  const ordered = hintsInOrder(mission);
  return (
    <div className="space-y-2">
      {ordered.map((hint, index) => (
        <div key={hint.id} className="rounded-md border border-slate-800 p-2">
          <label className="block text-xs text-slate-400">
            Hint {index + 1}
            <textarea
              className={inputClass}
              rows={2}
              value={hint.text}
              onChange={(event) => onChange(updateHint(state, mission.id, hint.id, { text: event.target.value }))}
            />
          </label>
          <div className="mt-1 flex items-end gap-2">
            <div className="w-28">
              <NumberInput
                label="Token cost"
                initial={hint.tokenCost}
                rules={{ whole: true, min: 0 }}
                onValue={(value) => onChange(updateHint(state, mission.id, hint.id, { tokenCost: value ?? 0 }))}
              />
            </div>
            <button
              type="button"
              className={`${secondaryButtonClass} disabled:opacity-40`}
              disabled={index === 0}
              aria-label="Move hint up"
              onClick={() => onChange(moveHint(state, mission.id, hint.id, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className={`${secondaryButtonClass} disabled:opacity-40`}
              disabled={index === ordered.length - 1}
              aria-label="Move hint down"
              onClick={() => onChange(moveHint(state, mission.id, hint.id, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => onChange(removeHint(state, mission.id, hint.id))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <Issues issues={issues} />
      <button type="button" className={secondaryButtonClass} onClick={() => onChange(addHint(state, mission.id))}>
        Add hint
      </button>
    </div>
  );
}

/**
 * The type's settings. Drawn as fields when the Mission Type Builder could
 * draw the schema as fields (EXPD-025), and as JSON otherwise, so no setting
 * is ever out of reach.
 */
function ConfigEditor({
  type,
  mission,
  issues,
  onValue,
  onWhole,
}: {
  type: MissionTypeView | undefined;
  mission: MissionInstance;
  issues: readonly PropertyIssue[];
  onValue: (name: string, value: JsonValue | undefined) => void;
  onWhole: (config: MissionInstance['config']) => void;
}) {
  const fields = type === undefined ? null : fieldsFromSchema(type.configSchema);
  if (fields === null) {
    return <ConfigJson mission={mission} issues={issues} onWhole={onWhole} />;
  }
  if (fields.length === 0) {
    return <p className="text-xs text-slate-400">This type has no settings.</p>;
  }
  return (
    <div className="space-y-2">
      {fields.map((field) => (
        <div key={field.name}>
          <ConfigField field={field} value={mission.config[field.name]} onValue={(value) => onValue(field.name, value)} />
          <Issues issues={issuesAt(issues, `config.${field.name}`)} />
        </div>
      ))}
      <Issues issues={issues.filter((issue) => !fields.some((field) => issuesAt([issue], `config.${field.name}`).length > 0))} />
    </div>
  );
}

function ConfigField({
  field,
  value,
  onValue,
}: {
  field: FieldDraft;
  value: JsonValue | undefined;
  onValue: (value: JsonValue | undefined) => void;
}) {
  const label = `${field.label.trim() === '' ? field.name : field.label}${field.required ? '' : ' (optional)'}`;
  const help = field.help.trim() === '' ? null : <span className="block text-slate-500">{field.help}</span>;

  switch (field.kind) {
    case 'text':
      return (
        <label className="block text-xs text-slate-400">
          {label}
          {help}
          <input
            className={inputClass}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onValue(event.target.value === '' ? undefined : event.target.value)}
          />
        </label>
      );
    case 'choice':
      return (
        <label className="block text-xs text-slate-400">
          {label}
          {help}
          <select
            className={inputClass}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onValue(event.target.value === '' ? undefined : event.target.value)}
          >
            <option value="">(not set)</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    case 'yes-no':
      return (
        <label className="block text-xs text-slate-400">
          {label}
          {help}
          <select
            className={inputClass}
            value={value === true ? 'true' : value === false ? 'false' : ''}
            onChange={(event) => onValue(event.target.value === '' ? undefined : event.target.value === 'true')}
          >
            <option value="">(not set)</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    case 'number':
    case 'whole-number':
      return (
        <NumberInput
          label={label}
          help={help}
          initial={typeof value === 'number' ? value : undefined}
          rules={{ whole: field.kind === 'whole-number', optional: true }}
          onValue={onValue}
        />
      );
    case 'text-list':
      return (
        <label className="block text-xs text-slate-400">
          {label} — one per line
          {help}
          <textarea
            className={inputClass}
            rows={3}
            value={Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join('\n') : ''}
            onChange={(event) => {
              const lines = event.target.value.split('\n');
              onValue(lines.length === 1 && lines[0] === '' ? undefined : lines);
            }}
          />
        </label>
      );
  }
}

function ConfigJson({
  mission,
  issues,
  onWhole,
}: {
  mission: MissionInstance;
  issues: readonly PropertyIssue[];
  onWhole: (config: MissionInstance['config']) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(mission.config, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div>
      <label className="block text-xs text-slate-400">
        This type's settings cannot be drawn as a form, so they are shown as JSON.
        <textarea
          className={`${inputClass} font-mono text-xs`}
          rows={6}
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const read = readConfigJson(event.target.value);
            setProblem(read.ok ? null : read.message);
            if (read.ok) onWhole(read.value);
          }}
        />
      </label>
      {problem !== null && <p className="mt-1 text-xs text-amber-300">{problem} Not applied yet.</p>}
      <Issues issues={issues} />
    </div>
  );
}

