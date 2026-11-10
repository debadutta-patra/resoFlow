/**
 * "Starting values ▾" menu: write values from the last completed run into the NEXT run's
 * parameters file (ParameterConfig → parameters.toml), with an old → new preview.
 *
 * Within one run ChemEx v2 already carries values between steps; these actions only matter
 * for the next run. Each action is named by its effect on the parameters file:
 *   - "Write STEP2 fitted values → parameters"   every FIT coordinate committed by that step
 *   - "Write STEP1 grid minimum → parameters"    the committed GRID point of that step's axes
 * Values keep full precision (the old buttons rounded to 2–4 decimals) and any parameter name
 * is supported (the old "Use fitted" only handled PB, KEX_AB, CS_A and DW_AB).
 */

import type { ParamValue, ParameterConfig } from './parameterConfig';
import type { RunOverview } from './runOverview';
import { SpinSystemKey } from './spinSystem';

export type StartingValueKind = 'fitted' | 'grid';

export interface StartingValueAction {
  id: string;
  kind: StartingValueKind;
  stepName: string;
  label: string;
  description: string;
}

/** One value to write: global (residue '') or per residue, optionally field-qualified. */
export interface StartingValueEntry {
  name: string;
  residue: string;
  qualifier: string;
  value: number;
}

export interface StartingValueChange {
  /** Parameter-file location, e.g. "PB" or "DW_AB · 13N". */
  label: string;
  section: 'global' | 'residue';
  key: string;
  residue: string;
  oldValue: number | null;
  newValue: number;
}

export interface StartingValuePreview {
  next: ParameterConfig;
  changes: StartingValueChange[];
  /** Values the run committed that are already in the file (no change). */
  unchanged: number;
}

/** Menu items for a completed run, in step order: fitted values for every step, grid minimum for GRID steps. */
export function startingValueActions(ov: RunOverview | null | undefined): StartingValueAction[] {
  if (!ov) return [];
  const out: StartingValueAction[] = [];
  for (const s of ov.steps) {
    if (s.status === 'missing') continue;
    const fitted = Object.values(s.values).some(p => p.copies.some(c => c.role === 'fit' && c.value !== null));
    if (s.grid && s.grid.axes.some(a => a.best !== null)) {
      out.push({
        id: `grid:${s.name}`,
        kind: 'grid',
        stepName: s.name,
        label: `Write ${s.name} grid minimum → parameters`,
        description: `Grid axes (${s.grid.axes.map(a => a.param).join(', ')}) at the committed grid point; other parameters unchanged.`,
      });
    }
    if (fitted) {
      out.push({
        id: `fitted:${s.name}`,
        kind: 'fitted',
        stepName: s.name,
        label: `Write ${s.name} fitted values → parameters`,
        description: `Every FIT coordinate committed by ${s.name} becomes the next run's starting value.`,
      });
    }
  }
  return out;
}

/** The values an action would write. */
export function startingValueEntries(ov: RunOverview, action: StartingValueAction): StartingValueEntry[] {
  const step = ov.steps.find(s => s.name === action.stepName);
  if (!step) return [];
  if (action.kind === 'grid') {
    return (step.grid?.axes ?? [])
      .filter(a => a.best !== null && Number.isFinite(a.best))
      .map(a => {
        const m = /NUC->\s*([^,\s]+)/i.exec(a.qualifier || '');
        return { name: a.param.toUpperCase(), residue: m ? m[1] : '', qualifier: '', value: a.best as number };
      });
  }
  const out: StartingValueEntry[] = [];
  for (const [name, param] of Object.entries(step.values)) {
    const fits = param.copies.filter(c => c.role === 'fit' && c.value !== null && Number.isFinite(c.value));
    // One field-qualifier only → the unqualified section already means "that field".
    const qualifiers = new Set(fits.map(c => c.qualifier));
    for (const c of fits) {
      out.push({ name: name.toUpperCase(), residue: c.residue, qualifier: qualifiers.size > 1 ? c.qualifier : '', value: c.value as number });
    }
  }
  return out;
}

/** Residue key already used by the config for this spin system (matched via SpinSystemKey), else the given one. */
function residueKeyFor(config: ParameterConfig, residue: string): string {
  const want = SpinSystemKey.parse(residue);
  for (const key of Object.keys(config.residues)) {
    const k = SpinSystemKey.parse(key);
    if (k.resNum === want.resNum && (!k.symbol || !want.symbol || k.symbol === want.symbol)) return key;
  }
  return residue;
}

function fieldKey(entry: StartingValueEntry): string {
  return (entry.qualifier ? `${entry.name}, ${entry.qualifier}` : entry.name).toLowerCase();
}

/** Apply entries to a parameter config; returns the new config and the old → new diff. */
export function previewStartingValues(
  config: ParameterConfig,
  entries: StartingValueEntry[],
  sourceLabel: string,
  at = new Date().toISOString()
): StartingValuePreview {
  const next: ParameterConfig = { ...config, globals: { ...config.globals }, residues: { ...config.residues } };
  const changes: StartingValueChange[] = [];
  let unchanged = 0;
  const source = { kind: 'inherited' as const, sourceRunId: sourceLabel, sourceRunLabel: sourceLabel, at };
  for (const e of entries) {
    const key = fieldKey(e);
    const pv: ParamValue = { value: e.value, source };
    if (!e.residue) {
      const old = next.globals[key]?.value ?? null;
      if (old === e.value) {
        unchanged++;
        continue;
      }
      next.globals[key] = pv;
      changes.push({ label: e.qualifier ? `${e.name} (${e.qualifier})` : e.name, section: 'global', key, residue: '', oldValue: old, newValue: e.value });
    } else {
      const resKey = residueKeyFor(next, e.residue);
      const res = { ...(next.residues[resKey] ?? {}) };
      const old = res[key]?.value ?? null;
      if (old === e.value) {
        unchanged++;
        continue;
      }
      res[key] = pv;
      // DW_AB written explicitly: drop a stale CS_B so only [DW_AB] is emitted (as before).
      if (key === 'dw_ab') delete res.cs_b;
      next.residues[resKey] = res;
      changes.push({
        label: `${e.qualifier ? `${e.name} (${e.qualifier})` : e.name} · ${resKey}`,
        section: 'residue',
        key,
        residue: resKey,
        oldValue: old,
        newValue: e.value,
      });
    }
  }
  return { next, changes, unchanged };
}
