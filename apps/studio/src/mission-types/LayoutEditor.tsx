/**
 * The student-facing layout, and a picture of it (EXPD-025).
 *
 * The author puts blocks in order and names the submit button. Beside the
 * list is the screen a student would see for a mission of this type, drawn
 * from the layout and the default settings, so the author can see what they
 * are building. The real screen is the student app's (EXPD-042).
 */

import {
  MAX_SUBMIT_LABEL_LENGTH,
  type JsonObject,
  type JsonValue,
  type StudentLayout,
  type StudentLayoutBlock,
} from '@explorer/shared-types';

import { inputClass, secondaryButtonClass } from '../shell/ui.tsx';
import { issuesAt, type DraftIssue } from './draft.ts';
import { IssueList } from './IssueList.tsx';

/** What each block kind is called in the builder. */
const BLOCK_LABELS: Record<Exclude<StudentLayoutBlock['kind'], 'config-field'>, string> = {
  brief: 'Brief',
  instructions: 'Instructions',
  media: 'Media',
  timer: 'Timer',
  hints: 'Hints',
  submission: 'Hand-in area',
};

function labelOf(block: StudentLayoutBlock): string {
  return block.kind === 'config-field' ? `Setting: ${block.field}` : BLOCK_LABELS[block.kind];
}

export function LayoutEditor({
  layout,
  onChange,
  configFields,
  defaults,
  issues,
}: {
  layout: StudentLayout;
  onChange: (next: StudentLayout) => void;
  /** The top-level fields of the config schema, which a block may show. */
  configFields: readonly string[];
  /** The starting settings, for the preview. */
  defaults: JsonObject;
  issues: readonly DraftIssue[];
}) {
  const blocks = layout.blocks;
  const setBlocks = (next: StudentLayoutBlock[]) => onChange({ ...layout, blocks: next });
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= blocks.length) {
      return;
    }
    const next = [...blocks];
    [next[index], next[target]] = [next[target] as StudentLayoutBlock, next[index] as StudentLayoutBlock];
    setBlocks(next);
  };

  const placedKinds = new Set(blocks.map((block) => block.kind));
  const placedFields = new Set(
    blocks.flatMap((block) => (block.kind === 'config-field' ? [block.field] : [])),
  );
  const addable = [
    ...(Object.keys(BLOCK_LABELS) as (keyof typeof BLOCK_LABELS)[])
      .filter((kind) => !placedKinds.has(kind))
      .map((kind) => ({ value: kind, label: BLOCK_LABELS[kind] })),
    ...configFields
      .filter((field) => !placedFields.has(field))
      .map((field) => ({ value: `field:${field}`, label: `Setting: ${field}` })),
  ];

  const add = (value: string) => {
    if (value === '') {
      return;
    }
    const block: StudentLayoutBlock = value.startsWith('field:')
      ? { kind: 'config-field', field: value.slice('field:'.length) }
      : ({ kind: value } as StudentLayoutBlock);
    setBlocks([...blocks, block]);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <ol className="space-y-2">
          {blocks.map((block, index) => (
            <li key={index} className="rounded-md border border-slate-800 p-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm">{labelOf(block)}</span>
                <button type="button" className={secondaryButtonClass} onClick={() => move(index, -1)}>
                  Up
                </button>
                <button type="button" className={secondaryButtonClass} onClick={() => move(index, 1)}>
                  Down
                </button>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => setBlocks(blocks.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </div>
              {block.kind === 'config-field' && (
                <label className="mt-2 block text-xs text-slate-400">
                  Heading the student sees
                  <input
                    className={inputClass}
                    value={block.heading ?? ''}
                    placeholder={block.field}
                    onChange={(event) => {
                      const heading = event.target.value;
                      const { heading: _old, ...rest } = block;
                      setBlocks(
                        blocks.map((current, at) =>
                          at === index ? (heading === '' ? rest : { ...rest, heading }) : current,
                        ),
                      );
                    }}
                  />
                </label>
              )}
              <IssueList issues={issuesAt(issues, `studentLayout.blocks[${index}]`)} />
            </li>
          ))}
        </ol>

        <label className="mt-3 block text-xs text-slate-400">
          Add a block
          <select className={inputClass} value="" onChange={(event) => add(event.target.value)}>
            <option value="">Choose…</option>
            {addable.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Only the settings you place here are shown to students. Keep answers out of the layout.
        </p>

        <label className="mt-4 block text-xs text-slate-400">
          Submit button
          <input
            className={inputClass}
            value={layout.submitLabel}
            maxLength={MAX_SUBMIT_LABEL_LENGTH}
            onChange={(event) => onChange({ ...layout, submitLabel: event.target.value })}
          />
        </label>
        <IssueList
          issues={issues.filter(
            (issue) =>
              issue.path.startsWith('studentLayout') && !issue.path.startsWith('studentLayout.blocks['),
          )}
        />
      </div>

      <StudentPreview layout={layout} defaults={defaults} />
    </div>
  );
}

function show(value: JsonValue | undefined): string {
  if (value === undefined) {
    return '(set by the author)';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Roughly what a phone shows. Placeholder text stands in for the mission's own words. */
function StudentPreview({ layout, defaults }: { layout: StudentLayout; defaults: JsonObject }) {
  return (
    <aside aria-label="Student preview" className="rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm">
      <p className="text-xs tracking-widest text-slate-500 uppercase">Student preview</p>
      <h3 className="mt-2 text-lg font-semibold">Mission title</h3>
      <div className="mt-3 space-y-3">
        {layout.blocks.map((block, index) => (
          <PreviewBlock key={index} block={block} layout={layout} defaults={defaults} />
        ))}
      </div>
    </aside>
  );
}

function PreviewBlock({
  block,
  layout,
  defaults,
}: {
  block: StudentLayoutBlock;
  layout: StudentLayout;
  defaults: JsonObject;
}) {
  switch (block.kind) {
    case 'brief':
      return <p className="text-slate-300">The short task description.</p>;
    case 'instructions':
      return <p className="text-slate-400">The full instructions the author wrote.</p>;
    case 'media':
      return <div className="h-20 rounded-md bg-slate-800 text-center leading-[5rem] text-slate-500">Media</div>;
    case 'timer':
      return <p className="font-mono text-amber-300">Time left 04:59</p>;
    case 'hints':
      return <p className="text-sky-300">Open a hint</p>;
    case 'config-field':
      return (
        <div>
          <p className="text-xs text-slate-500">{block.heading ?? block.field}</p>
          <p>{show(defaults[block.field])}</p>
        </div>
      );
    case 'submission':
      return (
        <div className="rounded-md border border-dashed border-slate-600 p-3">
          <p className="text-xs text-slate-500">The team hands work in here.</p>
          <button type="button" disabled className="mt-2 w-full rounded-md bg-sky-600 px-3 py-2 text-white">
            {layout.submitLabel || 'Submit'}
          </button>
        </div>
      );
  }
}
