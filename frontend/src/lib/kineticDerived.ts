/**
 * Read-only kinetic quantities derived from the [GLOBAL] starting values, using ChemEx's
 * own n-state parameterisation (chemex/models/kinetic/settings_nst.py, 2026.9.2):
 *
 *   PA   = 1 − Σ P_X                                (population_complement)
 *   k_ij = KEX_ij · p_j / (p_i + p_j)                (pair_rates, detailed balance)
 *   τ_X  = 1 / Σ_j k_Xj                              (lifetime of state X)
 *
 * For 2st this is KAB = KEX_AB·PB, KBA = KEX_AB·PA, τ_A = 1/KAB, τ_B = 1/KBA.
 * Edges: bare Nst and 3st_triangle are complete graphs, `_linear` is A–B–C–…, `_fork` is
 * A-centred. Other models (binding, Eyring, H/D, oligomers, residue-specific) are
 * parameterised differently, so no strip is shown for them.
 */

export interface DerivedQuantity {
  key: string;
  label: string;
  value: number | null;
  unit: string;
}

export interface Topology {
  states: string;
  edges: Array<[string, string]>;
}

/** ChemEx n-state topology for a model name (suffixes like `.tc`/`.mf` ignored), or null. */
export function topologyFor(model: string): Topology | null {
  const base = (model || '').toLowerCase().split('.')[0];
  const m = /^([2-6])st(_linear|_fork|_triangle)?$/.exec(base);
  if (!m) return null;
  const states = 'abcdef'.slice(0, Number(m[1]));
  const edges: Array<[string, string]> = [];
  if (m[2] === '_linear') {
    for (let i = 0; i + 1 < states.length; i++) edges.push([states[i], states[i + 1]]);
  } else if (m[2] === '_fork') {
    for (const s of states.slice(1)) edges.push(['a', s]);
  } else {
    for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) edges.push([states[i], states[j]]);
  }
  return { states, edges };
}

const fin = (v: number) => (Number.isFinite(v) ? v : null);

/**
 * Derived populations, directional rates and lifetimes. `value(name)` returns the starting
 * value of an upper-case ChemEx parameter (entered value, else ChemEx default).
 */
export function derivedKinetics(model: string, value: (name: string) => number | null | undefined): DerivedQuantity[] | null {
  const topo = topologyFor(model);
  if (!topo) return null;
  const S = (x: string) => x.toUpperCase();
  const p: Record<string, number> = {};
  let rest = 1;
  for (const s of topo.states.slice(1)) {
    const v = value(`P${S(s)}`);
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    p[s] = v;
    rest -= v;
  }
  p.a = rest;

  const out: DerivedQuantity[] = [{ key: 'PA', label: 'PA', value: fin(p.a), unit: '' }];
  const rates: Record<string, number> = {};
  for (const [i, j] of topo.edges) {
    const kex = value(`KEX_${S(i)}${S(j)}`);
    if (kex === null || kex === undefined || !Number.isFinite(kex)) return null;
    const denom = p[i] + p[j];
    rates[`${i}${j}`] = denom > 0 ? (kex * p[j]) / denom : NaN;
    rates[`${j}${i}`] = denom > 0 ? (kex * p[i]) / denom : NaN;
  }
  for (const [i, j] of topo.edges) {
    out.push({ key: `K${S(i)}${S(j)}`, label: `K${S(i)}${S(j)}`, value: fin(rates[`${i}${j}`]), unit: 's⁻¹' });
    out.push({ key: `K${S(j)}${S(i)}`, label: `K${S(j)}${S(i)}`, value: fin(rates[`${j}${i}`]), unit: 's⁻¹' });
  }
  for (const s of topo.states) {
    const leaving = Object.entries(rates)
      .filter(([k]) => k[0] === s)
      .reduce((sum, [, r]) => sum + r, 0);
    out.push({ key: `TAU_${S(s)}`, label: `τ_${S(s)}`, value: leaving > 0 ? fin(1 / leaving) : null, unit: 's' });
  }
  return out;
}
