/**
 * Small pieces the property panel (EXPD-027) and the scoring screen
 * (EXPD-028) both draw with.
 */

import { useState, type ReactNode } from 'react';

import { inputClass } from '../shell/ui.tsx';
import { readNumber, type PropertyIssue } from './properties.ts';

/**
 * A number input that keeps what was typed. Only a number that reads is
 * passed on; otherwise the reason is shown and the mission is left alone.
 */
export function NumberInput({
  label,
  help,
  initial,
  rules,
  onValue,
}: {
  label: string;
  help?: ReactNode;
  initial: number | undefined;
  rules: Parameters<typeof readNumber>[1];
  onValue: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(initial === undefined ? '' : String(initial));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <label className="block text-xs text-slate-400">
      {label}
      {help}
      <input
        className={inputClass}
        inputMode="decimal"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const read = readNumber(event.target.value, rules);
          setProblem(read.ok ? null : read.message);
          if (read.ok) onValue(read.value);
        }}
      />
      {problem !== null && <span className="mt-1 block text-amber-300">{problem} Not applied yet.</span>}
    </label>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2 border-t border-slate-800 pt-3">
      <legend className="pr-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

export function Issues({ issues }: { issues: readonly PropertyIssue[] }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-0.5 text-xs text-red-300">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`}>
          {issue.path !== '' && <span className="font-mono text-red-400">{issue.path}</span>} {issue.message}
        </li>
      ))}
    </ul>
  );
}
