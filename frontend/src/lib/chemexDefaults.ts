/**
 * ChemEx's own default starting values and safety bounds, per parameter name.
 *
 * The authoritative source is the backend catalogue (the `method-parameters` endpoints), which
 * derives these from the installed ChemEx (resoflow/chemex_api/defaults.py). The
 * fallback table below mirrors ChemEx 2026.9.2 for the common 2-state parameters so
 * placeholders, bound filling and validation still work before the catalogue loads.
 */

export interface ParamDefault {
  /** Upper-case ChemEx parameter name, e.g. "PB", "DW_AB". */
  name: string;
  /** ChemEx's default starting value (null when the parameter is derived). */
  value: number | null;
  /** Default lower/upper safety bound (null = unbounded on that side). */
  lower: number | null;
  upper: number | null;
  /** Optimised by default (ChemEx `vary`). */
  vary?: boolean;
  /** Defined by an expression by default (e.g. PA, KAB, R2_B = [R2_A]). */
  derived?: boolean;
  /** Model-owned constant (e.g. TREF): no bounds, no method role. */
  protected?: boolean;
}

export type ParamDefaultsLookup = (name: string) => ParamDefault | undefined;

const d = (name: string, value: number | null, lower: number | null, upper: number | null, extra: Partial<ParamDefault> = {}): ParamDefault => ({
  name,
  value,
  lower,
  upper,
  ...extra,
});

/** Exact-name fallbacks (ChemEx 2026.9.2, `2st` + spin defaults). */
const EXACT: Record<string, ParamDefault> = {
  PB: d('PB', 0.05, 0, 1, { vary: true }),
  TAUC_A: d('TAUC_A', 4.0, 0, 1000),
  S2_A: d('S2_A', 0.9, 0, 1),
  KHH_A: d('KHH_A', 0, 0, 1e6),
  TREF: d('TREF', 25.0, null, null, { protected: true }),
  PA: d('PA', null, null, null, { derived: true }),
};

/** Pattern fallbacks, first match wins. */
const PATTERNS: Array<[RegExp, (name: string) => ParamDefault]> = [
  [/^P[B-F]$/, n => d(n, 0.02, 0, 1, { vary: true })],
  [/^KEX_[A-F]{2}$/, n => d(n, 200.0, 0, 1e6, { vary: true })],
  [/^K[A-F]{2}$/, n => d(n, null, null, null, { derived: true })],
  [/^CS0_A$/, n => d(n, 0, -100, 300)],
  [/^CS1_A$/, n => d(n, 0, -1, 1)],
  [/^DW0_A[B-F]$/, n => d(n, 0, -100, 100, { vary: true })],
  [/^DW1_A[B-F]$/, n => d(n, 0, -1, 1, { vary: true })],
  [/^CS_A$/, n => d(n, 0.0, -100, 300)],
  [/^CS_[B-F]$/, n => d(n, null, null, null, { derived: true })],
  [/^DW_A[B-F]$/, n => d(n, 0.0, -100, 100, { vary: true })],
  [/^R1_A$/, n => d(n, 1.5, 0, 1000)],
  [/^R2_A$/, n => d(n, 10.0, 0, 1000)],
  [/^R[12]_[B-F]$/, n => d(n, null, 0, 1000, { derived: true })],
];

export const fallbackDefaults: ParamDefaultsLookup = name => {
  const n = name.toUpperCase();
  if (EXACT[n]) return EXACT[n];
  for (const [re, make] of PATTERNS) if (re.test(n)) return make(n);
  return undefined;
};

/** Catalogue row fields used here (a subset of `AvailableParamMeta`). */
export interface CatalogDefaultsRow {
  name: string;
  default_value?: number | null;
  lower?: number | null;
  upper?: number | null;
  derived?: boolean;
  protected?: boolean;
  default_mode?: string;
}

/**
 * Lookup over the backend catalogue, falling back to the static table for names the
 * catalogue does not list (or before it has loaded).
 */
export function defaultsLookupFromCatalog(rows?: CatalogDefaultsRow[] | null): ParamDefaultsLookup {
  const byName = new Map<string, ParamDefault>();
  for (const r of rows ?? []) {
    const hasData = r.default_value !== undefined || r.lower !== undefined || r.upper !== undefined;
    if (!hasData) continue;
    const name = r.name.toUpperCase();
    byName.set(name, {
      name,
      value: r.default_value ?? null,
      lower: r.lower ?? null,
      upper: r.upper ?? null,
      vary: r.default_mode === 'fit' ? true : fallbackDefaults(name)?.vary,
      derived: !!r.derived,
      protected: !!r.protected,
    });
  }
  return name => byName.get(name.toUpperCase()) ?? fallbackDefaults(name);
}

/** Effective bounds: explicit bounds win; each missing side falls back to ChemEx's default. */
export function effectiveBounds(
  name: string,
  explicit: { lower?: number; upper?: number } | undefined,
  lookup: ParamDefaultsLookup = fallbackDefaults
): { lower: number | null; upper: number | null; custom: boolean } {
  const def = lookup(name);
  const lower = explicit?.lower ?? def?.lower ?? null;
  const upper = explicit?.upper ?? def?.upper ?? null;
  return { lower, upper, custom: explicit?.lower !== undefined || explicit?.upper !== undefined };
}

/** Compact number for placeholders/tooltips ("1e+6" → "1e6"). */
export function fmtDefault(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential().replace('e+', 'e');
  return String(Number(v.toPrecision(6)));
}
