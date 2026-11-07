/** Status-bar badges shared by every ChemEx analysis page. */

import React from 'react';
import { AlertTriangle, GitFork } from 'lucide-react';
import type { LineageInfo } from '../../lib/chemexRun';

export const StaleStartingValuesBadge: React.FC<{ count: number; noun: string; onClick?: () => void }> = ({
  count,
  noun,
  onClick,
}) =>
  count > 0 ? (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? e => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      className={`px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 flex items-center gap-1 ${onClick ? 'cursor-pointer hover:bg-amber-100' : ''}`}
      title="Some starting values were seeded from data that has since changed. Review them in the Parameters tab."
    >
      <AlertTriangle className="w-3 h-3 text-amber-500 animate-pulse" />
      <span>
        {count} {noun}
        {count > 1 ? 's' : ''} changed
      </span>
    </span>
  ) : null;

export const ConfigChangedBadge: React.FC<{ show: boolean }> = ({ show }) =>
  show ? (
    <span
      className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 flex items-center gap-1"
      title="The configuration currently on screen differs from the one that produced the completed results below."
    >
      <AlertTriangle className="w-3 h-3 text-amber-500" />
      <span>Config changed since last run</span>
    </span>
  ) : null;

export const LineageBadge: React.FC<{
  lineage: LineageInfo | null;
  projectUuid: string;
  sourceExists: boolean;
}> = ({ lineage, projectUuid, sourceExists }) =>
  lineage ? (
    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800 flex items-center gap-1.5 shadow-2xs">
      <GitFork className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />
      <span>Seeded from </span>
      {sourceExists ? (
        <a
          href={`/projects/${projectUuid}/analysis/${lineage.sourceRunId}`}
          className="font-bold underline hover:text-indigo-600 dark:hover:text-indigo-200"
          title={`View source run (${lineage.sourceRunId})`}
        >
          {lineage.sourceRunLabel}
        </a>
      ) : (
        <span className="font-bold" title={`Source run ID: ${lineage.sourceRunId} (deleted)`}>
          {lineage.sourceRunLabel} <span className="text-[9px] opacity-70 font-normal">(deleted)</span>
        </span>
      )}
    </span>
  ) : null;
