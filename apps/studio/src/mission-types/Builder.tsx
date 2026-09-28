/**
 * The Mission Type Builder form (EXPD-025).
 *
 * Six sections, one per thing an author decides: what the type is called,
 * the settings an author placing it fills in, what a team hands in, how it
 * is judged, what it is worth, and what a student sees. Every problem is
 * shown next to its section as the author types, and Save is only offered
 * once there are none.
 *
 * A type that is not this organisation's draft opens read-only.
 *
 * Under the form is where the type goes next (EXPD-031): a saved draft is
 * published, and a published type starts its next version. Every version of
 * the key is listed there too, and each one opens.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  MISSION_CAPABILITIES,
  VERIFICATION_MODES,
  type MissionCapability,
  type VerificationMode,
} from '@explorer/shared-types';

import { ApiError } from '../auth/api-client.ts';
import { ErrorNote, inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import type { MissionTypeApi, MissionTypeView } from './api.ts';
import { blankDraft, draftOf, issuesAt, toAuthored, type BuilderDraft } from './draft.ts';
import { IssueList } from './IssueList.tsx';
import { LayoutEditor } from './LayoutEditor.tsx';
import { lifecycleOf, versionsOf, type Lifecycle } from './lifecycle.ts';
import { SchemaEditor } from './SchemaEditor.tsx';

/** What each validation method means for a type built here, which has no code. */
const METHOD_HELP: Record<VerificationMode, string> = {
  teacher: 'A teacher reviews every submission before it counts.',
  automatic:
    'No person is involved. A type built here has no code to judge work, so it finishes only when the team reaches the place the mission names; anything else goes to a teacher.',
  'automatic-with-review':
    'Decided as automatic, and the work is also put in front of a teacher, who may overrule it.',
};

export function Builder({
  existing,
  types,
  api,
  onSaved,
  onOpen,
  onClose,
}: {
  /** The type being edited, or null for a new one. */
  existing: MissionTypeView | null;
  /** Every type the list holds, for the other versions of this key. */
  types: readonly MissionTypeView[];
  api: MissionTypeApi;
  /** A save, a publish or a new version. The builder then shows what came back. */
  onSaved: (saved: MissionTypeView) => void;
  /** Opens another version of this key. */
  onOpen: (type: MissionTypeView) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<BuilderDraft>(() =>
    existing === null ? blankDraft() : draftOf(existing),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const readOnly = existing !== null && !existing.editable;
  const { type, issues } = useMemo(() => toAuthored(draft), [draft]);
  // What was last saved, as the form read it, so publishing waits for a save.
  const [savedText, setSavedText] = useState(() => JSON.stringify(type));
  const unsaved = JSON.stringify(type) !== savedText;
  const set = <K extends keyof BuilderDraft>(key: K, value: BuilderDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const configFields = Object.keys(type.configSchema.properties ?? {});

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = existing === null ? await api.create(type) : await api.update(existing.id, type);
      setSavedText(JSON.stringify(type));
      onSaved(saved);
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : 'The mission type could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const toggleCapability = (capability: MissionCapability, on: boolean) =>
    set(
      'capabilities',
      on
        ? MISSION_CAPABILITIES.filter((c) => c === capability || draft.capabilities.includes(c))
        : draft.capabilities.filter((c) => c !== capability),
    );

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {existing === null ? 'New mission type' : `${existing.name} · ${existing.key}@${existing.version}`}
        </h1>
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Back to list
        </button>
      </div>
      {readOnly && (
        <p className="mt-2 text-sm text-amber-300">
          {existing?.owner === 'platform'
            ? 'This type belongs to the platform. It can be read here, not changed.'
            : `This type is ${existing?.status}. Only a draft can be changed.`}
        </p>
      )}

      <fieldset disabled={readOnly} className="mt-6 max-w-5xl space-y-6">
        <Section title="About this type" issues={['key', 'version', 'name', 'description', 'capabilities'].flatMap((path) => issuesAt(issues, path))}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="text-xs text-slate-400">
              Key
              <input
                className={`${inputClass} font-mono`}
                value={draft.key}
                placeholder="bird-count"
                disabled={existing !== null}
                onChange={(e) => set('key', e.target.value)}
              />
            </label>
            <label className="text-xs text-slate-400">
              Version
              <input
                className={`${inputClass} font-mono`}
                value={draft.version}
                disabled={existing !== null}
                onChange={(e) => set('version', e.target.value)}
              />
            </label>
            <label className="text-xs text-slate-400">
              Name
              <input className={inputClass} value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </label>
          </div>
          <label className="mt-3 block text-xs text-slate-400">
            Description
            <textarea
              className={`${inputClass} h-16`}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <span className="text-xs text-slate-400">Needs from the phone:</span>
            {MISSION_CAPABILITIES.map((capability) => (
              <label key={capability} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={draft.capabilities.includes(capability)}
                  onChange={(e) => toggleCapability(capability, e.target.checked)}
                />
                {capability}
              </label>
            ))}
          </div>
        </Section>

        <Section title="Settings an author fills in" issues={issuesAt(issues, 'defaultConfig')}>
          <SchemaEditor
            value={draft.config}
            onChange={(config) => set('config', config)}
            path="configSchema"
            issues={issues}
            showDefaults
          />
          {draft.config.mode === 'json' && (
            <label className="mt-3 block text-xs text-slate-400">
              Starting settings (JSON)
              <textarea
                className={`${inputClass} h-32 font-mono text-xs`}
                value={draft.defaultConfigText}
                onChange={(e) => set('defaultConfigText', e.target.value)}
              />
            </label>
          )}
        </Section>

        <Section title="What a team hands in" issues={[]}>
          <SchemaEditor
            value={draft.submission}
            onChange={(submission) => set('submission', submission)}
            path="submissionSchema"
            issues={issues}
            showDefaults={false}
          />
        </Section>

        <Section title="Validation method" issues={issuesAt(issues, 'validationMethod')}>
          <div className="space-y-2">
            {VERIFICATION_MODES.map((mode) => (
              <label key={mode} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="validation-method"
                  checked={draft.validationMethod === mode}
                  onChange={() => set('validationMethod', mode)}
                />
                <span>
                  <span className="font-medium">{mode}</span>
                  <span className="block text-xs text-slate-400">{METHOD_HELP[mode]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            This is what a new mission of this type starts with. An author can change it per mission.
          </p>
        </Section>

        <Section title="Default scoring" issues={issuesAt(issues, 'defaultScoring')}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="text-xs text-slate-400">
              Base points
              <input
                className={inputClass}
                inputMode="numeric"
                value={draft.basePoints}
                onChange={(e) => set('basePoints', e.target.value)}
              />
            </label>
            <label className="text-xs text-slate-400">
              Most it can be worth (empty for no cap)
              <input
                className={inputClass}
                inputMode="numeric"
                value={draft.maxPoints}
                onChange={(e) => set('maxPoints', e.target.value)}
              />
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={draft.allowPartialCredit}
                onChange={(e) => set('allowPartialCredit', e.target.checked)}
              />
              Partly right can earn part of the points
            </label>
          </div>
        </Section>

        <Section title="Student-facing layout" issues={[]}>
          <LayoutEditor
            layout={draft.layout}
            onChange={(layout) => set('layout', layout)}
            configFields={configFields}
            defaults={type.defaultConfig}
            issues={issues}
          />
        </Section>
      </fieldset>

      {!readOnly && (
        <div className="mt-8 max-w-5xl border-t border-slate-800 pt-4">
          {issues.length > 0 && (
            <p className="text-sm text-amber-300">
              {issues.length === 1 ? 'One problem' : `${issues.length} problems`} to fix before this can be saved.
            </p>
          )}
          {saveError !== null && <ErrorNote>{saveError}</ErrorNote>}
          <button
            type="button"
            className="mt-3 rounded-md bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            disabled={issues.length > 0 || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      )}

      <NextStep
        key={existing === null ? 'new' : `${existing.id}:${existing.status}`}
        lifecycle={lifecycleOf(existing, { issues: issues.length, unsaved }, types)}
        existing={existing}
        api={api}
        onSaved={onSaved}
        onOpen={onOpen}
      />

      {existing !== null && (
        <Versions current={existing} versions={versionsOf(types, existing.key)} onOpen={onOpen} />
      )}
    </section>
  );
}

/** Publishing a draft, or starting the next version of a published type. */
function NextStep({
  lifecycle,
  existing,
  api,
  onSaved,
  onOpen,
}: {
  lifecycle: Lifecycle;
  existing: MissionTypeView | null;
  api: MissionTypeApi;
  onSaved: (saved: MissionTypeView) => void;
  onOpen: (type: MissionTypeView) => void;
}) {
  const suggested = lifecycle.kind === 'published' ? lifecycle.suggestedVersion : '';
  const [version, setVersion] = useState(suggested);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existing === null || lifecycle.kind === 'new' || lifecycle.kind === 'platform') {
    return null;
  }

  const run = async (action: () => Promise<MissionTypeView>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setConfirming(false);
      onSaved(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const ref = `${existing.key}@${existing.version}`;

  if (lifecycle.kind === 'draft') {
    return (
      <div className="mt-6 max-w-5xl rounded-lg border border-slate-800 p-4">
        <h2 className="font-semibold">Publish</h2>
        <p className="mt-1 text-sm text-slate-300">
          Publishing freezes {ref}. Missions pin to a type by key and version, so a published type is never changed
          again. A later change is a new version. Check the student preview above before you publish.
        </p>
        {lifecycle.reason !== null && <p className="mt-2 text-sm text-amber-300">{lifecycle.reason}</p>}
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        {!confirming ? (
          <button
            type="button"
            className={`${secondaryButtonClass} mt-3`}
            disabled={!lifecycle.publishable || busy}
            onClick={() => setConfirming(true)}
          >
            Publish {ref}
          </button>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm">Publish {ref}? This cannot be undone.</span>
            <button
              type="button"
              className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={!lifecycle.publishable || busy}
              onClick={() => void run(() => api.publish(existing.id), 'The mission type could not be published.')}
            >
              {busy ? 'Publishing…' : 'Yes, publish'}
            </button>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 max-w-5xl rounded-lg border border-slate-800 p-4">
      <h2 className="font-semibold">New version</h2>
      <p className="mt-1 text-sm text-slate-300">
        {ref} is {existing.status}, so it is not changed. A new version starts as a draft copied from it, under the
        same key. Missions already placed keep {existing.version}.
      </p>
      {lifecycle.openDraft !== null ? (
        <p className="mt-3 text-sm">
          <span className="text-amber-300">
            {existing.key}@{lifecycle.openDraft.version} is already a draft. A key has one draft at a time.
          </span>{' '}
          <button
            type="button"
            className="text-sky-300 hover:underline"
            onClick={() => lifecycle.openDraft !== null && onOpen(lifecycle.openDraft)}
          >
            Open it
          </button>
        </p>
      ) : (
        <div className="mt-3 flex items-end gap-3">
          <label className="text-xs text-slate-400">
            Version
            <input
              className={`${inputClass} w-32 font-mono`}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy || version.trim() === ''}
            onClick={() =>
              void run(() => api.newVersion(existing.id, version.trim()), 'The new version could not be started.')
            }
          >
            {busy ? 'Starting…' : 'Start new version'}
          </button>
        </div>
      )}
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Every version of the open type's key, each one opening. */
function Versions({
  current,
  versions,
  onOpen,
}: {
  current: MissionTypeView;
  versions: readonly MissionTypeView[];
  onOpen: (type: MissionTypeView) => void;
}) {
  if (versions.length < 2) {
    return null;
  }
  return (
    <div className="mt-6 max-w-5xl rounded-lg border border-slate-800 p-4">
      <h2 className="font-semibold">Versions of {current.key}</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {versions.map((type) => (
          <li key={type.id} className="flex gap-3">
            {type.id === current.id ? (
              <span className="font-mono">{type.version}</span>
            ) : (
              <button type="button" className="font-mono text-sky-300 hover:underline" onClick={() => onOpen(type)}>
                {type.version}
              </button>
            )}
            <span className="text-slate-400">
              {type.status}
              {type.owner === 'platform' ? ', platform' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({
  title,
  issues,
  children,
}: {
  title: string;
  issues: readonly { path: string; message: string }[];
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-800 p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
      <IssueList issues={issues} />
    </div>
  );
}
