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
  /** Spin system ("" for global parameters). */
  spin?: string;
  /** ChemEx condition keys: temperature (°C), h_larmor_frq (MHz), p_total, l_total (M), d2o. */
  conditions?: Record<string, number>;
  /** Model-owned: no method action may change its role. */
  protected?: boolean;
  /** False when ChemEx cannot estimate it (FIT is rejected). */
  estimable?: boolean;
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

// ── Selector catalog ────────────────────────────────────────────────────

/** Known qualifier values for one parameter name, already formatted as ChemEx accepts them. */
export interface ParameterCatalogEntry {
  name: string;
  scope: 'global' | 'residue';
  /** NUC values (spin systems carrying this parameter). */
  spins: string[];
  T: string[];
  B0: string[];
  '[P]': string[];
  '[L]': string[];
  D2O: string[];
  /** Every concrete copy is model-owned. */
  protected: boolean;
  /** At least one copy can be fitted. */
  estimable: boolean;
  count: number;
}

export type ParameterCatalog = Record<string, ParameterCatalogEntry>;

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Group ChemEx-instantiated parameters by name with their selectable qualifier values. */
export function buildParameterCatalog(rows: InspectedParameter[]): ParameterCatalog {
  const acc: Record<string, { spins: Set<string>; T: Set<number>; B0: Set<number>; P: Set<number>; L: Set<number>; D2O: Set<number>; prot: number; est: number; n: number }> = {};
  for (const row of rows) {
    const name = String(row.name || '').toUpperCase();
    if (!name) continue;
    const a = (acc[name] ??= { spins: new Set(), T: new Set(), B0: new Set(), P: new Set(), L: new Set(), D2O: new Set(), prot: 0, est: 0, n: 0 });
    a.n += 1;
    if (row.spin) a.spins.add(row.spin);
    const c = row.conditions || {};
    if (typeof c.temperature === 'number') a.T.add(c.temperature);
    if (typeof c.h_larmor_frq === 'number') a.B0.add(c.h_larmor_frq);
    if (typeof c.p_total === 'number') a.P.add(c.p_total);
    if (typeof c.l_total === 'number') a.L.add(c.l_total);
    if (typeof c.d2o === 'number') a.D2O.add(c.d2o);
    if (row.protected) a.prot += 1;
    if (row.estimable !== false) a.est += 1;
  }
  const nums = (s: Set<number>, unit: string) => [...s].sort((x, y) => x - y).map(v => `${v}${unit}`);
  const out: ParameterCatalog = {};
  for (const [name, a] of Object.entries(acc)) {
    out[name] = {
      name,
      scope: a.spins.size ? 'residue' : 'global',
      spins: [...a.spins].sort(naturalCompare),
      T: nums(a.T, 'C'),
      B0: nums(a.B0, 'MHz'),
      '[P]': nums(a.P, 'M'),
      '[L]': nums(a.L, 'M'),
      D2O: nums(a.D2O, ''),
      protected: a.prot === a.n,
      estimable: a.est > 0,
      count: a.n,
    };
  }
  return out;
}

/** Known values for one qualifier ("NUC", "B0", …) of one parameter name, formatted for ChemEx. */
export function catalogSuggestions(catalog: ParameterCatalog | null | undefined, name: string, key: 'NUC' | 'T' | 'B0' | '[P]' | '[L]' | 'D2O'): string[] {
  const entry = catalog?.[name.toUpperCase()];
  if (!entry) return [];
  return key === 'NUC' ? entry.spins : entry[key];
}
