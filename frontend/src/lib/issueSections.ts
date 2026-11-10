/** Which step section an issue belongs to (for the in-step mini-nav counts). */

import type { ValidationError } from './methodValidation';

export type StepSection = 'summary' | 'residues' | 'parameters' | 'resolved' | 'search' | 'statistics';

export const STEP_SECTIONS: Array<{ id: StepSection; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'residues', label: 'Residues' },
  { id: 'parameters', label: 'Parameters & rules' },
  { id: 'resolved', label: 'Resolved roles' },
  { id: 'search', label: 'Search' },
  { id: 'statistics', label: 'Statistics' },
];

export const sectionDomId = (s: StepSection) => `step-section-${s}`;

export function issueSection(issue: Pick<ValidationError, 'code' | 'message' | 'paramName' | 'source'>): StepSection {
  const code = issue.code ?? '';
  const field = (issue.source?.field ?? '').toUpperCase();
  const msg = issue.message;
  if (/^(grid-|de-edge)/.test(code) || field.startsWith('SEARCH') || /^(GRID|DE)\b/.test(msg)) return 'search';
  if (/^(stats-|mcmc)/.test(code) || field.startsWith('STATISTICS') || /(MCMC|Monte Carlo|Bootstrap)/.test(msg)) return 'statistics';
  if (code === 'data-ratio' || /INCLUDE|EXCLUDE|excludes all|No profiles selected/i.test(msg) || field === 'INCLUDE' || field === 'EXCLUDE') return 'residues';
  if (code || issue.paramName || field.startsWith('ROLES') || /Role rule|ROLES_FROM|FIT action/.test(msg)) return 'parameters';
  return 'summary';
}

export function sectionCounts(issues: Array<Pick<ValidationError, 'code' | 'message' | 'paramName' | 'source' | 'severity'>>): Record<StepSection, number> {
  const out: Record<StepSection, number> = { summary: 0, residues: 0, parameters: 0, resolved: 0, search: 0, statistics: 0 };
  for (const i of issues) out[issueSection(i)] += 1;
  return out;
}
