/**
 * The problems with one part of the builder's form (EXPD-025).
 */

import type { DraftIssue } from './draft.ts';

export function IssueList({ issues }: { issues: readonly DraftIssue[] }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul className="mt-2 space-y-1 text-xs text-red-300">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`}>
          <span className="font-mono text-red-400">{issue.path || 'type'}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}
