/**
 * The expedition graph editor (EXPD-026).
 *
 * A palette across the top, the canvas, and two panels under it: the
 * problems with the graph, and a small bar for whatever is selected. The
 * bar holds only what the graph itself needs — a node's name, whether a
 * mission is secret or the boss, an edge's label. Everything else about a
 * mission is the property panel's (EXPD-027), and an edge's condition and
 * route are EXPD-029's.
 *
 * A draft may be saved unfinished (EXPD-017). The problems list is the same
 * check the API runs, as the author works.
 */

import { useMemo, useState } from 'react';
import type { ExpeditionNode } from '@explorer/shared-types';

import { ApiError } from '../auth/api-client.ts';
import type { MissionTypeView } from '../mission-types/api.ts';
import { ErrorNote, inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import type { ExpeditionApi, ExpeditionDocumentView, ExpeditionView } from './api.ts';
import { GraphCanvas, type Selection } from './GraphCanvas.tsx';
import {
  addBranch,
  addNode,
  addParallelStations,
  connect,
  issuesOf,
  moveNode,
  openDocument,
  removeEdge,
  removeNode,
  renameNode,
  roleOf,
  setEdgeLabel,
  setMissionFlag,
  toDocument,
  type Added,
  type GraphState,
} from './graph.ts';

export function GraphEditor({
  expedition,
  opened,
  missionTypes,
  api,
  onClose,
}: {
  expedition: ExpeditionView;
  opened: ExpeditionDocumentView;
  missionTypes: readonly MissionTypeView[];
  api: ExpeditionApi;
  onClose: () => void;
}) {
  const [state, setState] = useState<GraphState>(() => openDocument(opened.definition));
  const [revision, setRevision] = useState(opened.version);
  const [selection, setSelection] = useState<Selection>(null);
  const [typeId, setTypeId] = useState<string>(() => missionTypes[0]?.id ?? '');
  const [stations, setStations] = useState('3');
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const issues = useMemo(() => issuesOf(state), [state]);
  const flagged = useMemo(
    () => ({
      nodeIds: new Set(issues.graph.flatMap((issue) => issue.nodeIds)),
      edgeIds: new Set(issues.graph.flatMap((issue) => issue.edgeIds)),
    }),
    [issues],
  );

  const type = missionTypes.find((candidate) => candidate.id === typeId);
  const selectedNode =
    selection?.kind === 'node' ? state.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edge' ? state.edges.find((edge) => edge.id === selection.id) : undefined;
  /** New things are joined after the selected node, so a line can be laid by clicking. */
  const after = selectedNode?.id;

  const change = (next: GraphState) => {
    setState(next);
    setDirty(true);
    setNotice(null);
  };
  const place = (added: Added) => {
    change(added.state);
    setSelection({ kind: 'node', id: added.nodeId });
  };
  const needType = (run: (chosen: MissionTypeView) => void) => {
    if (type === undefined) {
      setNotice('Choose a mission type first. There are none yet? Build one under Mission types.');
      return;
    }
    run(type);
  };
  const remove = () => {
    if (selection === null) return;
    change(selection.kind === 'node' ? removeNode(state, selection.id) : removeEdge(state, selection.id));
    setSelection(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.saveDraft(expedition.id, toDocument(state));
      setRevision(saved.version);
      setDirty(false);
      setNotice(`Saved as draft revision ${saved.version.definitionVersion}.`);
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : 'The graph could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const hasStart = state.nodes.some((node) => node.kind === 'start');

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{expedition.title}</h1>
          <p className="mt-1 text-sm text-slate-400">
            Revision {revision.definitionVersion} · {revision.status}
            {revision.status === 'published' && ' — saving starts the next draft; this revision stays as it is.'}
            {dirty && <span className="text-amber-300"> · unsaved changes</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Back to list
          </button>
          <button
            type="button"
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 p-3 text-sm">
        <PaletteButton disabled={hasStart} title={hasStart ? 'An expedition has one start.' : undefined} onClick={() => place(addNode(state, { kind: 'start' }))}>
          Start
        </PaletteButton>
        <label className="text-xs text-slate-400">
          Mission type
          <select
            className={`${inputClass} mt-0 py-1.5`}
            value={typeId}
            onChange={(event) => setTypeId(event.target.value)}
          >
            {missionTypes.length === 0 && <option value="">No mission types yet</option>}
            {missionTypes.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} ({candidate.key}@{candidate.version}
                {candidate.status === 'draft' ? ', draft' : ''})
              </option>
            ))}
          </select>
        </label>
        <PaletteButton onClick={() => needType((chosen) => place(addNode(state, { kind: 'mission', type: chosen }, after)))}>
          Mission
        </PaletteButton>
        <PaletteButton
          onClick={() => needType((chosen) => place(addNode(state, { kind: 'mission', type: chosen, secret: true }, after)))}
        >
          Secret mission
        </PaletteButton>
        <PaletteButton
          onClick={() => needType((chosen) => place(addNode(state, { kind: 'mission', type: chosen, boss: true }, after)))}
        >
          Boss
        </PaletteButton>
        <span className="flex items-end gap-1">
          <label className="text-xs text-slate-400">
            Stations
            <input
              className={`${inputClass} mt-0 w-16 py-1.5`}
              inputMode="numeric"
              value={stations}
              onChange={(event) => setStations(event.target.value)}
            />
          </label>
          <PaletteButton
            onClick={() =>
              needType((chosen) => place(addParallelStations(state, chosen, Number(stations) || 2, after)))
            }
          >
            Parallel stations
          </PaletteButton>
        </span>
        <PaletteButton onClick={() => needType((chosen) => place(addBranch(state, chosen, after)))}>Branch</PaletteButton>
        <PaletteButton onClick={() => place(addNode(state, { kind: 'checkpoint' }, after))}>Checkpoint</PaletteButton>
        <PaletteButton onClick={() => place(addNode(state, { kind: 'finish' }, after))}>Finish</PaletteButton>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        With a node selected, what you add is joined after it. Drag a node to move it; drag from its dot to another
        node to join them; press Delete to remove what is selected.
      </p>

      {notice !== null && <p className="mt-2 text-sm text-sky-300">{notice}</p>}
      {saveError !== null && <ErrorNote>{saveError}</ErrorNote>}

      <div className="mt-3">
        <GraphCanvas
          state={state}
          selection={selection}
          flagged={flagged}
          onSelect={setSelection}
          onMove={(nodeId, to) => change(moveNode(state, nodeId, to))}
          onConnect={(from, to) => {
            const result = connect(state, from, to);
            if (result.ok) {
              change(result.state);
            } else {
              setNotice(result.reason);
            }
          }}
          onDelete={remove}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 p-4">
          <h2 className="font-semibold">Selected</h2>
          {selectedNode !== undefined && (
            <NodeBar
              node={selectedNode}
              onRename={(title) => change(renameNode(state, selectedNode.id, title))}
              onFlag={(flag, on) => change(setMissionFlag(state, selectedNode.id, flag, on))}
              onRemove={remove}
            />
          )}
          {selectedEdge !== undefined && (
            <div className="mt-2 space-y-2 text-sm">
              <label className="block text-xs text-slate-400">
                Label on the edge
                <input
                  className={inputClass}
                  value={selectedEdge.label ?? ''}
                  onChange={(event) => change(setEdgeLabel(state, selectedEdge.id, event.target.value))}
                />
              </label>
              {(selectedEdge.condition !== undefined || selectedEdge.audience !== undefined) && (
                <p className="text-xs text-amber-300">This edge has a condition or a route. They are kept as they are.</p>
              )}
              <button type="button" className={secondaryButtonClass} onClick={remove}>
                Remove edge
              </button>
            </div>
          )}
          {selection === null && <p className="mt-2 text-sm text-slate-400">Click a node or an edge.</p>}
        </div>

        <div className="rounded-lg border border-slate-800 p-4">
          <h2 className="font-semibold">
            {issues.graph.length === 0 ? 'The graph has no problems' : `Problems with the graph (${issues.graph.length})`}
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-red-300">
            {issues.graph.map((issue, index) => {
              const target = issue.nodeIds[0] ?? issue.edgeIds[0];
              return (
                <li key={`${issue.path}-${index}`}>
                  {target === undefined ? (
                    <span className="font-mono text-red-400">{issue.path}</span>
                  ) : (
                    <button
                      type="button"
                      className="font-mono text-red-400 hover:underline"
                      onClick={() =>
                        setSelection(
                          issue.nodeIds[0] !== undefined
                            ? { kind: 'node', id: issue.nodeIds[0] }
                            : { kind: 'edge', id: target },
                        )
                      }
                    >
                      {issue.path}
                    </button>
                  )}{' '}
                  {issue.message}
                </li>
              );
            })}
          </ul>
          {issues.elsewhere.length > 0 && (
            <details className="mt-3 text-xs text-slate-400">
              <summary>
                {issues.elsewhere.length} more outside the graph (rules, scoring, details), for other screens
              </summary>
              <ul className="mt-1 space-y-1">
                {issues.elsewhere.map((issue, index) => (
                  <li key={`${issue.path}-${index}`}>
                    <span className="font-mono">{issue.path || 'document'}</span> {issue.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-xs text-slate-500">A draft may be saved with problems. Publishing needs none.</p>
        </div>
      </div>
    </section>
  );
}

function NodeBar({
  node,
  onRename,
  onFlag,
  onRemove,
}: {
  node: ExpeditionNode;
  onRename: (title: string) => void;
  onFlag: (flag: 'secret' | 'boss', on: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-xs text-slate-400">
        {roleOf(node)} · <span className="font-mono">{node.id}</span>
      </p>
      <label className="block text-xs text-slate-400">
        Name (for authors; students do not see it)
        <input className={inputClass} value={node.title} onChange={(event) => onRename(event.target.value)} />
      </label>
      {node.kind === 'mission' && (
        <div className="flex gap-4">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={node.secret === true} onChange={(event) => onFlag('secret', event.target.checked)} />
            Secret — hidden until it opens
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={node.boss === true} onChange={(event) => onFlag('boss', event.target.checked)} />
            Boss
          </label>
        </div>
      )}
      <button type="button" className={secondaryButtonClass} onClick={onRemove}>
        Remove node
      </button>
    </div>
  );
}

function PaletteButton({
  children,
  onClick,
  disabled = false,
  title,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <button type="button" className={`${secondaryButtonClass} disabled:opacity-40`} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}
