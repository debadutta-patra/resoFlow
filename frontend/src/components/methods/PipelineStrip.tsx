/**
 * Method pipeline overview above the step tabs: one node per step (search mode, statistics,
 * residue count, estimated runtime), a solid "values" arrow between consecutive steps (each
 * step starts from the latest committed fit), a dashed "roles" arc wherever ROLES_FROM points,
 * and the whole method's estimated runtime. Clicking a node selects that step.
 */

import React from 'react';
import { Activity, Grid3x3, Shuffle } from 'lucide-react';
import type { Step } from '../../lib/methodConfig';
import { stepDisplayName } from '../../lib/methodSteps';

export interface PipelineNodeInfo {
  residues: number | null;
  runtime: string | null;
}

const NODE_W = 168;
const GAP = 64;
const ARC_H = 34;

export const PipelineStrip: React.FC<{
  steps: Step[];
  activeIdx: number;
  onSelect: (idx: number) => void;
  info: PipelineNodeInfo[];
  totalRuntime: string | null;
}> = ({ steps, activeIdx, onSelect, info, totalRuntime }) => {
  const centre = (i: number) => i * (NODE_W + GAP) + NODE_W / 2;
  const width = steps.length * NODE_W + Math.max(0, steps.length - 1) * GAP;
  const arcs = steps
    .map((s, i) => {
      const j = s.rolesFromStepId ? steps.findIndex(t => t.id === s.rolesFromStepId) : -1;
      return j >= 0 && j !== i ? { from: j, to: i } : null;
    })
    .filter((a): a is { from: number; to: number } => !!a);

  return (
    <section aria-label="Method pipeline" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-900 dark:text-slate-200">
        <span className="font-bold uppercase tracking-wider">Pipeline</span>
        <span title="From the last run's per-step timings, including MC/BS/BSN and MCMC; '+' means some part had no timing to scale from.">
          Total {totalRuntime ?? '— (estimates appear after a run)'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="relative" style={{ width, paddingTop: arcs.length ? ARC_H + 6 : 0 }}>
          {arcs.length > 0 && (
            <svg className="absolute left-0 top-0 overflow-visible" width={width} height={ARC_H + 8} aria-hidden="true">
              {arcs.map(({ from, to }) => {
                const x1 = centre(from);
                const x2 = centre(to);
                const mid = (x1 + x2) / 2;
                return (
                  <g key={`${from}-${to}`} data-testid={`roles-arc-${from}-${to}`}>
                    <path d={`M ${x1} ${ARC_H + 6} Q ${mid} ${-ARC_H / 2} ${x2 - 4} ${ARC_H + 4}`} fill="none" stroke="currentColor" strokeDasharray="5 4" strokeWidth={1.5} className="text-indigo-800 dark:text-indigo-700" />
                    <polygon points={`${x2 - 4},${ARC_H + 6} ${x2 - 9},${ARC_H - 2} ${x2 + 1},${ARC_H}`} className="fill-indigo-600 dark:fill-indigo-700" />
                    <text x={mid} y={8} textAnchor="middle" className="fill-indigo-700 dark:fill-indigo-700" fontSize={12}>
                      roles
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          <ol className="flex items-stretch" style={{ gap: 0 }}>
            {steps.map((step, i) => {
              const name = stepDisplayName(step, i);
              const search = step.search && step.search.mode !== 'none' && step.search.axes.length ? step.search.mode : null;
              const st = step.statistics;
              const stats = [st?.mc?.enabled && 'MC', st?.bs?.enabled && 'BS', st?.bsn?.enabled && 'BSN', st?.mcmc?.enabled && 'MCMC'].filter(Boolean) as string[];
              const active = i === activeIdx;
              return (
                <li key={step.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => onSelect(i)}
                    aria-current={active ? 'step' : undefined}
                    style={{ width: NODE_W }}
                    className={`text-left rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? 'border-blue-500 bg-blue-50 text-blue-900 dark:text-blue-700'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-200 hover:border-blue-300'
                    }`}
                  >
                    <span className="block font-mono font-bold truncate">{name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 mt-0.5">
                      {search === 'grid' && (
                        <span className="flex items-center gap-0.5">
                          <Grid3x3 className="w-3 h-3" /> GRID
                        </span>
                      )}
                      {search === 'de' && (
                        <span className="flex items-center gap-0.5">
                          <Shuffle className="w-3 h-3" /> DE
                        </span>
                      )}
                      {!search && <span>TRF</span>}
                      {stats.length > 0 && (
                        <span className="flex items-center gap-0.5">
                          <Activity className="w-3 h-3" /> {stats.join('+')}
                        </span>
                      )}
                    </span>
                    <span className="block mt-0.5 text-slate-900 dark:text-slate-200">
                      {info[i]?.residues !== null && info[i]?.residues !== undefined ? `${info[i].residues} res` : step.residueMode === 'all' ? 'all profiles' : `${step.residues.length} res`}
                      {info[i]?.runtime ? ` · ${info[i].runtime}` : ''}
                    </span>
                  </button>
                  {i < steps.length - 1 && (
                    <span className="flex flex-col items-center text-slate-900 dark:text-slate-200" style={{ width: GAP }} title="Values always carry over: each step starts from the latest successfully committed fit." data-testid="values-arrow">
                      <span className="text-xs leading-none">values</span>
                      <svg width={GAP - 12} height={10} aria-hidden="true">
                        <line x1={0} y1={5} x2={GAP - 20} y2={5} stroke="currentColor" strokeWidth={1.5} />
                        <polygon points={`${GAP - 20},1 ${GAP - 12},5 ${GAP - 20},9`} fill="currentColor" />
                      </svg>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
};

export default PipelineStrip;
