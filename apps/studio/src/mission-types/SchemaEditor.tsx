/**
 * Editing a schema as a list of fields, or as JSON (EXPD-025).
 *
 * Used twice by the builder: for the settings an author fills in, and for
 * what a team hands in. A schema the fields cannot describe opens as JSON,
 * and switching back is offered only when nothing would be lost.
 */

import { useState } from 'react';

import { inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import { issuesAt, switchMode, type DraftIssue, type SchemaDraft } from './draft.ts';
import { FIELD_KINDS, blankField, type FieldDraft, type FieldKind } from './fields.ts';
import { IssueList } from './IssueList.tsx';

export function SchemaEditor({
  value,
  onChange,
  path,
  issues,
  showDefaults,
}: {
  value: SchemaDraft;
  onChange: (next: SchemaDraft) => void;
  /** `configSchema` or `submissionSchema`, to find this editor's issues. */
  path: string;
  issues: readonly DraftIssue[];
  /** Whether a field's default is asked for. A submission has none. */
  showDefaults: boolean;
}) {
  const [switchError, setSwitchError] = useState<string | null>(null);

  const toggle = () => {
    const next = switchMode(value);
    if (next === null) {
      setSwitchError('This schema uses more than fields can show, so it stays as JSON.');
      return;
    }
    setSwitchError(null);
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-3">
        {switchError !== null && <span className="text-xs text-amber-300">{switchError}</span>}
        <button type="button" className={secondaryButtonClass} onClick={toggle}>
          {value.mode === 'fields' ? 'Edit as JSON' : 'Edit as fields'}
        </button>
      </div>

      {value.mode === 'json' ? (
        <div className="mt-2">
          <textarea
            aria-label="Schema as JSON"
            className={`${inputClass} h-64 font-mono text-xs`}
            value={value.text}
            onChange={(event) => onChange({ mode: 'json', text: event.target.value })}
          />
          <IssueList issues={issuesAt(issues, path)} />
        </div>
      ) : (
        <FieldList
          fields={value.fields}
          onChange={(fields) => onChange({ mode: 'fields', fields })}
          path={path}
          issues={issues}
          showDefaults={showDefaults}
        />
      )}
    </div>
  );
}

function FieldList({
  fields,
  onChange,
  path,
  issues,
  showDefaults,
}: {
  fields: readonly FieldDraft[];
  onChange: (next: readonly FieldDraft[]) => void;
  path: string;
  issues: readonly DraftIssue[];
  showDefaults: boolean;
}) {
  const replace = (index: number, field: FieldDraft) =>
    onChange(fields.map((current, at) => (at === index ? field : current)));
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= fields.length) {
      return;
    }
    const next = [...fields];
    [next[index], next[target]] = [next[target] as FieldDraft, next[index] as FieldDraft];
    onChange(next);
  };

  return (
    <div className="mt-2 space-y-3">
      {fields.length === 0 && <p className="text-sm text-slate-400">No fields yet.</p>}
      {fields.map((field, index) => (
        <FieldRow
          key={index}
          field={field}
          onChange={(next) => replace(index, next)}
          onRemove={() => onChange(fields.filter((_, at) => at !== index))}
          onUp={() => move(index, -1)}
          onDown={() => move(index, 1)}
          issues={[
            ...issuesAt(issues, `${path}.fields[${index}]`),
            // What the shared check says about this field's schema.
            ...issuesAt(issues, `${path}.properties.${field.name}`),
          ]}
          showDefaults={showDefaults}
        />
      ))}
      <button type="button" className={secondaryButtonClass} onClick={() => onChange([...fields, blankField()])}>
        Add field
      </button>
      <IssueList
        issues={issues.filter(
          (issue) =>
            (issue.path === path || issue.path.startsWith(`${path}.`)) &&
            !issue.path.startsWith(`${path}.fields[`) &&
            !issue.path.startsWith(`${path}.properties.`),
        )}
      />
    </div>
  );
}

function FieldRow({
  field,
  onChange,
  onRemove,
  onUp,
  onDown,
  issues,
  showDefaults,
}: {
  field: FieldDraft;
  onChange: (next: FieldDraft) => void;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
  issues: readonly DraftIssue[];
  showDefaults: boolean;
}) {
  const set = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) =>
    onChange({ ...field, [key]: value });
  const bounds =
    field.kind === 'text'
      ? 'Length (characters)'
      : field.kind === 'text-list'
        ? 'Entries'
        : field.kind === 'number' || field.kind === 'whole-number'
          ? 'Value'
          : null;

  return (
    <fieldset className="rounded-md border border-slate-800 p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="text-xs text-slate-400">
          Name
          <input className={inputClass} value={field.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Label
          <input className={inputClass} value={field.label} onChange={(e) => set('label', e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Kind
          <select
            className={inputClass}
            value={field.kind}
            onChange={(e) => set('kind', e.target.value as FieldKind)}
          >
            {FIELD_KINDS.map((kind) => (
              <option key={kind.kind} value={kind.kind}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
          <input type="checkbox" checked={field.required} onChange={(e) => set('required', e.target.checked)} />
          Required
        </label>
      </div>

      <label className="mt-3 block text-xs text-slate-400">
        Help text
        <input className={inputClass} value={field.help} onChange={(e) => set('help', e.target.value)} />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {field.kind === 'choice' && (
          <label className="col-span-2 text-xs text-slate-400">
            Options, one per line
            <textarea
              className={`${inputClass} h-20`}
              value={field.options.join('\n')}
              onChange={(e) => set('options', e.target.value.split('\n'))}
            />
          </label>
        )}
        {bounds !== null && (
          <>
            <label className="text-xs text-slate-400">
              {bounds}: at least
              <input className={inputClass} inputMode="decimal" value={field.min} onChange={(e) => set('min', e.target.value)} />
            </label>
            <label className="text-xs text-slate-400">
              {bounds}: at most
              <input className={inputClass} inputMode="decimal" value={field.max} onChange={(e) => set('max', e.target.value)} />
            </label>
          </>
        )}
        {field.kind === 'text' && (
          <label className="text-xs text-slate-400">
            Pattern (regular expression)
            <input className={`${inputClass} font-mono`} value={field.pattern} onChange={(e) => set('pattern', e.target.value)} />
          </label>
        )}
        {showDefaults && <DefaultInput field={field} onChange={(value) => set('defaultValue', value)} />}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onUp}>
          Up
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onDown}>
          Down
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onRemove}>
          Remove
        </button>
      </div>
      <IssueList issues={issues} />
    </fieldset>
  );
}

function DefaultInput({ field, onChange }: { field: FieldDraft; onChange: (value: string) => void }) {
  if (field.kind === 'yes-no') {
    return (
      <label className="text-xs text-slate-400">
        Starts as
        <select className={inputClass} value={field.defaultValue} onChange={(e) => onChange(e.target.value)}>
          <option value="">No default</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
    );
  }
  if (field.kind === 'text-list') {
    return (
      <label className="col-span-2 text-xs text-slate-400">
        Starts with, one per line
        <textarea className={`${inputClass} h-20`} value={field.defaultValue} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className="text-xs text-slate-400">
      Starts as
      <input className={inputClass} value={field.defaultValue} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
