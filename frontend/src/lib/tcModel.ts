/**
 * ChemEx `.tc` (temperature-coefficient) models, 2026.9.2:
 *
 *   CS_A(T)  = CS0_A  + (T − TREF)·CS1_A        DW_AX(T) = DW0_AX + (T − TREF)·DW1_AX
 *
 * TREF is one protected [GLOBAL] constant (default 25 °C; no bounds, no method role).
 * Under `.tc`, CS_A and DW_AX are model-owned expressions: a plain [CS_A]/[DW_AB] entry is
 * accepted by ChemEx but turns them into fixed constants, detaching the coefficients
 * (verified on a real session), so starting values belong in CS0_A/DW0_AX.
 * The released DWP_AX/DWM_AX names were removed with no alias:
 *   DW0_AX = DWP_AX + TREF·DWM_AX,  DW1_AX = DWM_AX.
 */

import type { ParameterConfig, ParamValue, ResidueParams } from './parameterConfig';

export const TREF_DEFAULT = 25;

/** True for `2st.tc`, `3st_eyring.tc`, `2st.mf.tc`, … */
export const isTcModel = (model: string | undefined | null): boolean =>
  (model || '').toLowerCase().split('.').slice(1).includes('tc');

/** Per-residue coefficient keys shown instead of CS_A / DW_AB under `.tc`. */
export const TC_RESIDUE_KEYS = ['cs0_a', 'cs1_a', 'dw0_ab', 'dw1_ab'] as const;

/** CS_A and DW_AB of one residue at temperature `tC` (°C), or null where a coefficient is unset. */
export function tcDerived(params: ResidueParams | undefined, tref: number, tC: number): { cs_a: number | null; dw_ab: number | null } {
  const v = (k: string) => params?.[k]?.value;
  const at = (c0?: number, c1?: number) => (c0 === undefined ? null : c0 + (tC - tref) * (c1 ?? 0));
  return { cs_a: at(v('cs0_a'), v('cs1_a')), dw_ab: at(v('dw0_ab'), v('dw1_ab')) };
}

/** Residues with plain CS_A / DW_A* entries (which `.tc` would freeze as constants). */
export function plainShiftResidues(config: ParameterConfig): string[] {
  return Object.entries(config.residues || {})
    .filter(([, p]) => Object.keys(p || {}).some(k => k === 'cs_a' || /^dw_a[b-f]$/.test(k)))
    .map(([k]) => k);
}

/**
 * Move plain CS_A → CS0_A and DW_AX → DW0_AX (with CS1/DW1 unset, CS_A(T) is unchanged at
 * any T), keeping bounds and provenance. Existing coefficients are not overwritten.
 */
export function convertPlainShiftsToTc(config: ParameterConfig): ParameterConfig {
  const residues: Record<string, ResidueParams> = {};
  for (const [key, params] of Object.entries(config.residues || {})) {
    const next: ResidueParams = {};
    for (const [k, pv] of Object.entries(params || {})) {
      if (!pv) continue;
      const target = k === 'cs_a' ? 'cs0_a' : /^dw_a[b-f]$/.test(k) ? `dw0_${k.slice(3)}` : null;
      if (target) {
        if (!params[target]) next[target] = pv;
      } else {
        next[k] = pv;
      }
    }
    residues[key] = next;
  }
  return { ...config, residues };
}

// ── Legacy DWP/DWM ───────────────────────────────────────────────────────

export interface LegacyTcRow {
  residue: string;
  pair: string; // e.g. "AB"
  dwp: number | null;
  dwm: number | null;
  dw0: number;
  dw1: number;
  boundsDropped: boolean;
}

export interface LegacyTcScan {
  tref: number;
  trefFromFile: boolean;
  rows: LegacyTcRow[];
}

const SECTION = /^\[\s*"?(DW[PM])_A([B-F])"?\s*\]$/i;
const KV = /^("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/;

function firstNumber(raw: string): { value: number | null; listed: boolean } {
  const s = raw.replace(/\s+#.*$/, '').trim();
  const listed = s.startsWith('[');
  const n = Number((listed ? s.slice(1, -1).split(',')[0] : s).trim());
  return { value: Number.isFinite(n) ? n : null, listed };
}

/** Find DWP_AX / DWM_AX sections (and TREF) in a parameters.toml. Empty `rows` = nothing to convert. */
export function scanLegacyTc(toml: string): LegacyTcScan {
  let section = '';
  let tref: number | null = null;
  const acc = new Map<string, { dwp: number | null; dwm: number | null; listed: boolean }>();
  for (const line of (toml || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) {
      const m = SECTION.exec(t);
      section = m ? `${m[1].toUpperCase()}|${m[2].toUpperCase()}` : t.replace(/[[\]"\s]/g, '').toUpperCase();
      continue;
    }
    const kv = KV.exec(t);
    if (!kv) continue;
    const key = kv[1].replace(/^"(.*)"$/, '$1');
    if (section === 'GLOBAL' && key.toUpperCase() === 'TREF') tref = firstNumber(kv[2]).value;
    const [kind, state] = section.split('|');
    if (kind !== 'DWP' && kind !== 'DWM') continue;
    const id = `${key}|${state}`;
    const cur = acc.get(id) ?? { dwp: null, dwm: null, listed: false };
    const { value, listed } = firstNumber(kv[2]);
    if (kind === 'DWP') cur.dwp = value;
    else cur.dwm = value;
    cur.listed ||= listed;
    acc.set(id, cur);
  }
  const T = tref ?? TREF_DEFAULT;
  const rows: LegacyTcRow[] = [];
  for (const [id, v] of acc) {
    const [residue, state] = id.split('|');
    const dwm = v.dwm ?? 0;
    rows.push({ residue, pair: `A${state}`, dwp: v.dwp, dwm: v.dwm, dw0: (v.dwp ?? 0) + T * dwm, dw1: dwm, boundsDropped: v.listed });
  }
  return { tref: T, trefFromFile: tref !== null, rows };
}

/** Replace DWP_AX/DWM_AX sections with DW0_AX/DW1_AX (values only; bounds need review). */
export function convertLegacyTc(toml: string): string {
  const scan = scanLegacyTc(toml);
  if (scan.rows.length === 0) return toml;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) skipping = SECTION.test(t);
    if (!skipping) out.push(line);
  }
  const pairs = Array.from(new Set(scan.rows.map(r => r.pair))).sort();
  for (const pair of pairs) {
    const rows = scan.rows.filter(r => r.pair === pair);
    out.push('', `[DW0_${pair}]`, ...rows.map(r => `${r.residue} = ${Number(r.dw0.toPrecision(12))}`));
    out.push('', `[DW1_${pair}]`, ...rows.map(r => `${r.residue} = ${Number(r.dw1.toPrecision(12))}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Residue keys that still carry obsolete DWP/DWM parameters. */
export function obsoleteTcKeys(config: ParameterConfig): string[] {
  const names = new Set<string>();
  const scan = (p: Record<string, ParamValue | undefined>) =>
    Object.keys(p || {}).forEach(k => /^dw[pm]_a[b-f]$/.test(k) && names.add(k.toUpperCase()));
  scan(config.globals || {});
  Object.values(config.residues || {}).forEach(p => scan(p as Record<string, ParamValue | undefined>));
  return Array.from(names).sort();
}

