/**
 * The canvas the graph is drawn and edited on (EXPD-026).
 *
 * Plain SVG with pointer events: no diagram library, because that would be a
 * dependency. Drag a node to move it. Drag from the dot on a node's right
 * edge to another node to join them. Click a node or an edge to select it,
 * and press Delete to remove it.
 *
 * The canvas owns only what the pointer is doing. What the graph is, and
 * every change to it, is `graph.ts`.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ExpeditionEdge, ExpeditionNode } from '@explorer/shared-types';

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  missionOf,
  positionOf,
  roleOf,
  type GraphState,
  type NodeRole,
  type Point,
} from './graph.ts';

/** What is selected on the canvas. */
export type Selection =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }
  | null;

/** How each role is drawn. Tailwind classes on SVG shapes. */
const ROLE_STYLE: Record<NodeRole, { fill: string; stroke: string; label: string; dashed?: boolean }> = {
  start: { fill: 'fill-emerald-950', stroke: 'stroke-emerald-500', label: 'Start' },
  mission: { fill: 'fill-sky-950', stroke: 'stroke-sky-500', label: 'Mission' },
  secret: { fill: 'fill-violet-950', stroke: 'stroke-violet-400', label: 'Secret mission', dashed: true },
  boss: { fill: 'fill-rose-950', stroke: 'stroke-rose-500', label: 'Boss' },
  checkpoint: { fill: 'fill-slate-900', stroke: 'stroke-slate-500', label: 'Checkpoint' },
  finish: { fill: 'fill-amber-950', stroke: 'stroke-amber-500', label: 'Finish' },
};

type Pointer =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dragging'; readonly nodeId: string; readonly grab: Point }
  | { readonly kind: 'linking'; readonly from: string; readonly at: Point };

export function GraphCanvas({
  state,
  selection,
  flagged,
  onSelect,
  onMove,
  onConnect,
  onDelete,
}: {
  state: GraphState;
  selection: Selection;
  /** Nodes and edges a problem in the list is about, drawn with a red ring. */
  flagged: { readonly nodeIds: ReadonlySet<string>; readonly edgeIds: ReadonlySet<string> };
  onSelect: (selection: Selection) => void;
  onMove: (nodeId: string, to: Point) => void;
  onConnect: (from: string, to: string) => void;
  onDelete: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [pointer, setPointer] = useState<Pointer>({ kind: 'idle' });

  const byId = new Map(state.nodes.map((node) => [node.id as string, node]));
  const width = Math.max(1100, ...state.nodes.map((node) => positionOf(node).x + NODE_WIDTH + 200));
  const height = Math.max(560, ...state.nodes.map((node) => positionOf(node).y + NODE_HEIGHT + 160));

  const pointOf = (event: ReactPointerEvent): Point => {
    const box = svg.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const nodeAt = (point: Point): ExpeditionNode | undefined =>
    [...state.nodes].reverse().find((node) => {
      const at = positionOf(node);
      return point.x >= at.x && point.x <= at.x + NODE_WIDTH && point.y >= at.y && point.y <= at.y + NODE_HEIGHT;
    });

  const startDrag = (event: ReactPointerEvent, node: ExpeditionNode) => {
    event.stopPropagation();
    svg.current?.setPointerCapture(event.pointerId);
    svg.current?.focus();
    const at = pointOf(event);
    const from = positionOf(node);
    onSelect({ kind: 'node', id: node.id });
    setPointer({ kind: 'dragging', nodeId: node.id, grab: { x: at.x - from.x, y: at.y - from.y } });
  };

  const startLink = (event: ReactPointerEvent, node: ExpeditionNode) => {
    event.stopPropagation();
    svg.current?.setPointerCapture(event.pointerId);
    setPointer({ kind: 'linking', from: node.id, at: pointOf(event) });
  };

  const move = (event: ReactPointerEvent) => {
    if (pointer.kind === 'dragging') {
      const at = pointOf(event);
      onMove(pointer.nodeId, { x: at.x - pointer.grab.x, y: at.y - pointer.grab.y });
    } else if (pointer.kind === 'linking') {
      setPointer({ ...pointer, at: pointOf(event) });
    }
  };

  const release = (event: ReactPointerEvent) => {
    if (pointer.kind === 'linking') {
      const target = nodeAt(pointOf(event));
      if (target !== undefined && target.id !== pointer.from) {
        onConnect(pointer.from, target.id);
      }
    }
    setPointer({ kind: 'idle' });
  };

  const linkingFrom = pointer.kind === 'linking' ? byId.get(pointer.from) : undefined;

  return (
    <div className="overflow-auto rounded-lg border border-slate-800 bg-slate-950">
      <svg
        ref={svg}
        role="application"
        aria-label="Expedition graph. Drag nodes to move them, drag from a node's dot to join it to another, press Delete to remove the selection."
        tabIndex={0}
        width={width}
        height={height}
        className="touch-none select-none focus:outline-none"
        onPointerDown={() => onSelect(null)}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={() => setPointer({ kind: 'idle' })}
        onKeyDown={(event) => {
          if ((event.key === 'Delete' || event.key === 'Backspace') && selection !== null) {
            event.preventDefault();
            onDelete();
          }
        }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-slate-400" />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-sky-300" />
          </marker>
          <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="fill-slate-800" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#grid)" />

        {state.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (from === undefined || to === undefined) {
            return null;
          }
          return (
            <EdgeShape
              key={edge.id}
              edge={edge}
              from={positionOf(from)}
              to={positionOf(to)}
              selected={selection?.kind === 'edge' && selection.id === edge.id}
              flagged={flagged.edgeIds.has(edge.id)}
              onSelect={() => onSelect({ kind: 'edge', id: edge.id })}
            />
          );
        })}

        {linkingFrom !== undefined && pointer.kind === 'linking' && (
          <path
            d={curve(outPort(positionOf(linkingFrom)), pointer.at)}
            className="fill-none stroke-sky-300"
            strokeWidth={2}
            strokeDasharray="6 4"
            markerEnd="url(#arrow-selected)"
          />
        )}

        {state.nodes.map((node) => (
          <NodeShape
            key={node.id}
            node={node}
            detail={detailOf(state, node)}
            selected={selection?.kind === 'node' && selection.id === node.id}
            flagged={flagged.nodeIds.has(node.id)}
            onGrab={(event) => startDrag(event, node)}
            onLink={(event) => startLink(event, node)}
          />
        ))}
      </svg>
    </div>
  );
}

function NodeShape({
  node,
  detail,
  selected,
  flagged,
  onGrab,
  onLink,
}: {
  node: ExpeditionNode;
  detail: string;
  selected: boolean;
  flagged: boolean;
  onGrab: (event: ReactPointerEvent) => void;
  onLink: (event: ReactPointerEvent) => void;
}) {
  const role = roleOf(node);
  const style = ROLE_STYLE[role];
  const at = positionOf(node);
  const badges = node.kind === 'mission' ? [node.boss === true && role !== 'boss' ? 'boss' : null, node.secret === true && role !== 'secret' ? 'secret' : null].filter(Boolean) : [];
  return (
    <g transform={`translate(${at.x} ${at.y})`} className="cursor-grab" onPointerDown={onGrab} aria-label={`${style.label}: ${node.title}`}>
      {flagged && (
        <rect x={-4} y={-4} width={NODE_WIDTH + 8} height={NODE_HEIGHT + 8} rx={12} className="fill-none stroke-red-500" strokeWidth={2} />
      )}
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={role === 'checkpoint' ? 28 : 8}
        className={`${style.fill} ${selected ? 'stroke-sky-300' : style.stroke}`}
        strokeWidth={selected || role === 'boss' ? 3 : 1.5}
        strokeDasharray={style.dashed === true ? '5 3' : undefined}
      />
      <text x={12} y={22} className="fill-slate-100 text-[13px] font-medium">
        {clip(node.title === '' ? '(untitled)' : node.title, 20)}
      </text>
      <text x={12} y={40} className="fill-slate-400 text-[11px]">
        {clip([style.label, ...badges].join(' · ') + (detail === '' ? '' : ` · ${detail}`), 26)}
      </text>
      {node.kind !== 'finish' && (
        <circle
          cx={NODE_WIDTH}
          cy={NODE_HEIGHT / 2}
          r={7}
          className="cursor-crosshair fill-slate-200 stroke-slate-950 hover:fill-sky-300"
          strokeWidth={2}
          onPointerDown={onLink}
        >
          <title>Drag to another node to join them</title>
        </circle>
      )}
    </g>
  );
}

function EdgeShape({
  edge,
  from,
  to,
  selected,
  flagged,
  onSelect,
}: {
  edge: ExpeditionEdge;
  from: Point;
  to: Point;
  selected: boolean;
  flagged: boolean;
  onSelect: () => void;
}) {
  const start = outPort(from);
  const end = { x: to.x, y: to.y + NODE_HEIGHT / 2 };
  const d = curve(start, end);
  // An edge that only opens for some teams, or only once something holds, is
  // drawn dashed: it is one arm of a branch rather than a way everyone goes.
  const gated = edge.condition !== undefined || edge.audience !== undefined;
  const words = [edge.label, gated ? gateOf(edge) : undefined].filter((word) => word !== undefined && word !== '');
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return (
    <g
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className="cursor-pointer"
    >
      <path d={d} className="fill-none stroke-transparent" strokeWidth={14} />
      <path
        d={d}
        className={`fill-none ${flagged ? 'stroke-red-500' : selected ? 'stroke-sky-300' : gated ? 'stroke-amber-400' : 'stroke-slate-400'}`}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={gated ? '6 4' : undefined}
        markerEnd={selected ? 'url(#arrow-selected)' : 'url(#arrow)'}
      />
      {words.length > 0 && (
        <text x={middle.x} y={middle.y - 6} textAnchor="middle" className="fill-slate-300 text-[11px]">
          {clip(words.join(' · '), 28)}
        </text>
      )}
    </g>
  );
}

/** What a node's second line says after its kind. */
function detailOf(state: GraphState, node: ExpeditionNode): string {
  if (node.kind !== 'mission') {
    return '';
  }
  const mission = missionOf(state, node);
  return mission === undefined ? 'no mission' : mission.missionTypeId;
}

function gateOf(edge: ExpeditionEdge): string {
  if (edge.audience?.kind === 'routes') {
    return `routes: ${edge.audience.routeIds.join(', ')}`;
  }
  return edge.condition === undefined || edge.condition.type === 'always' ? '' : `when ${edge.condition.type}`;
}

function outPort(at: Point): Point {
  return { x: at.x + NODE_WIDTH, y: at.y + NODE_HEIGHT / 2 };
}

function curve(from: Point, to: Point): string {
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
