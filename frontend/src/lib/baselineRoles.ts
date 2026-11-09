/**
 * Baseline (no-ROLES) parameter roles as resolved by ChemEx for the loaded
 * experiments and kinetic model, summarised per parameter name for the
 * Methods-tab "Default" treatment. Source: POST …/chemex/parameters/inspect.
 */

export type BaselineStatus = 'fit' | 'fix' | 'constrain';

export interface InspectedParameter {
  id: string;
  name: string;
  status: BaselineStatus | string;
  expr?: string;
}

export interface BaselineRoleCounts {
  fit: number;
  fix: number;
  /** Derived: model-owned or constrained by the baseline parameterization. */
  derived: number;
}

export type BaselineRoleSummary = Record<string, BaselineRoleCounts>;

export function summarizeBaselineRoles(rows: InspectedParameter[]): BaselineRoleSummary {
  const out: BaselineRoleSummary = {};
  for (const row of rows) {
    const name = String(row.name || '').toUpperCase();
    if (!name) continue;
    const c = (out[name] ??= { fit: 0, fix: 0, derived: 0 });
    if (row.status === 'fit') c.fit += 1;
    else if (row.status === 'fix') c.fix += 1;
    else c.derived += 1;
  }
  return out;
}

const LABEL: Record<keyof BaselineRoleCounts, string> = { fit: 'Fit', fix: 'Fixed', derived: 'Derived' };

/**
 * "Fit" / "Fixed" / "Derived" when every concrete copy agrees, otherwise
 * "Fit 12 · Fixed 4". Null when ChemEx did not report this parameter.
 */
export function baselineRoleLabel(counts: BaselineRoleCounts | undefined): string | null {
  if (!counts) return null;
  const parts = (Object.keys(LABEL) as Array<keyof BaselineRoleCounts>).filter(k => counts[k] > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1) return LABEL[parts[0]];
  return parts.map(k => `${LABEL[k]} ${counts[k]}`).join(' · ');
}
