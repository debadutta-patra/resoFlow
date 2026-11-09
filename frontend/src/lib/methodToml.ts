/**
 * ChemEx method.toml codec — the frontend half of the ChemEx method contract
 * (mirror: backend/app/services/fitting/method_emitter.py).
 *
 * `configToToml` always emits canonical ChemEx v2 (`FORMAT_VERSION = 2`):
 *   https://gbouvignies.github.io/ChemEx/docs/user_guide/fitting/method_files
 *
 * `tomlToConfig` reads v2 and legacy v1 files. v1 semantics are migrated
 * explicitly: implicit role carry-over becomes `ROLES_FROM = "<previous>"`,
 * implicit selection carry-over is repeated, `GRID` moves to `SEARCH.GRID`,
 * bare tuples become `values(...)`. v1-only constructs that v2 cannot express
 * (inequality bounds, FITMETHOD, THIN/WALKERS/WORKERS…) are reported in
 * `unparsed` so the UI can flag them.
 */

import type {
  MethodConfig,
  McmcConfig,
  ParamSetting,
  ParseResult,
  ResamplingConfig,
  RoleAction,
  RoleRule,
  SearchAxis,
  SearchFunction,
  StatisticsConfig,
  Step,
} from './methodConfig';
import { createDefaultStep, newMethodId, normalizeStep } from './methodConfig';
import { isValidSeed, toSeed } from './seed';
import { linkRolesFrom, rolesFromTarget, stepDisplayName } from './methodSteps';

// ── Emission ────────────────────────────────────────────────────────────

const q = (s: string): string => JSON.stringify(s);

const num = (x: number): string => {
  if (!Number.isFinite(x)) return '0';
  return String(x);
};

/** "PARAM" or "PARAM, NUC->G24N-H" */
export function axisSelector(axis: Pick<SearchAxis, 'param' | 'qualifier'>): string {
  const base = axis.param.trim().toUpperCase().replace(/^\[|\]$/g, '');
  const qual = (axis.qualifier || '').trim().replace(/^,\s*/, '');
  return qual ? `${base}, ${qual}` : base;
}

export function formatAxis(axis: SearchAxis, mode: 'grid' | 'de'): string {
  const sel = `[${axisSelector(axis)}]`;
  if (mode === 'grid' && axis.fn === 'values') {
    return `${sel} = values(${(axis.values ?? []).map(num).join(', ')})`;
  }
  const fn = axis.fn === 'log' ? 'log' : 'lin';
  if (mode === 'de') return `${sel} = ${fn}(${num(axis.low)}, ${num(axis.high)})`;
  return `${sel} = ${fn}(${num(axis.low)}, ${num(axis.high)}, ${Math.floor(axis.count)})`;
}

/** Plain-name constraint entry for a table parameter. */
function constraintEntry(p: ParamSetting): string | null {
  const expr = (p.expression || '').trim();
  if (!expr) return null;
  if (/^\s*\[[^\]]+\]\s*=/.test(expr)) return expr; // already a full equation
  return `[${p.name.toUpperCase()}] = ${expr}`;
}

/**
 * The ordered ROLES actions a step emits: the table's plain-name actions
 * (CONSTRAIN → FIX → FIT), then the explicit rules. Search targets are NOT added
 * to FIT implicitly — GRID/DE never change roles; an axis whose target is not a
 * final FIT coordinate is reported (see `materializeLegacySearchFits` for old configs).
 */
export function stepRoleActions(step: Step): Array<{ action: RoleAction; entries: string[] }> {
  const actions: Array<{ action: RoleAction; entries: string[] }> = [];
  const params = step.parameters || [];

  const constrain = params.filter(p => p.mode === 'constrain').map(constraintEntry).filter((e): e is string => !!e);
  if (constrain.length) actions.push({ action: 'CONSTRAIN', entries: constrain });

  const fix = params.filter(p => p.mode === 'fix').map(p => p.name.toUpperCase());
  if (fix.length) actions.push({ action: 'FIX', entries: fix });

  const fit = params.filter(p => p.mode === 'fit' || p.mode === 'grid').map(p => p.name.toUpperCase());
  if (fit.length) actions.push({ action: 'FIT', entries: fit });

  for (const rule of step.roleRules ?? []) {
    const entries = rule.entries.map(e => e.trim()).filter(Boolean);
    if (entries.length) actions.push({ action: rule.action, entries });
  }
  return actions;
}

function formatResidue(r: string): string {
  const s = String(r).trim();
  return /^\d+$/.test(s) ? s : q(s);
}

/** Seeds are u64 decimal strings, emitted as bare TOML integers. Invalid seeds are left to validation. */
function seedLine(seed: unknown): string | null {
  const s = toSeed(seed);
  return isValidSeed(s) ? `SEED = ${s}` : null;
}

function emitResampling(lines: string[], stepName: string, key: string, conf?: ResamplingConfig) {
  if (!conf?.enabled || !(conf.replicates > 0)) return;
  lines.push('', `[${stepName}.STATISTICS.${key}]`, `REPLICATES = ${Math.floor(conf.replicates)}`);
  const seed = seedLine(conf.seed);
  if (seed) lines.push(seed);
}

function emitMcmc(lines: string[], stepName: string, m?: McmcConfig) {
  if (!m?.enabled || !(m.steps > 0)) return;
  lines.push('', `[${stepName}.STATISTICS.MCMC]`, `STEPS = ${Math.floor(m.steps)}`);
  if (typeof m.burn === 'number' && Number.isFinite(m.burn)) lines.push(`BURN = ${Math.floor(m.burn)}`);
  const seed = seedLine(m.seed);
  if (seed) lines.push(seed);
}

/** TOML key for a step header: bare when possible, else a quoted basic string (as ChemEx renders). */
export const tomlKey = (name: string): string => (/^[A-Za-z0-9_-]+$/.test(name) ? name : q(name));

/** Step name as written to TOML (case preserved; ChemEx compares ROLES_FROM case-sensitively). */
/**
 * The compact `MC = 100, BS = 100, BSN = 100, MCMC = 5000` form, or null when an
 * enabled request carries a SEED or BURN (then every request uses expanded
 * [STEP.STATISTICS.X] tables) or nothing is enabled.
 */
export function compactStatistics(stats: StatisticsConfig): string | null {
  const parts: string[] = [];
  for (const [key, conf] of [['MC', stats.mc], ['BS', stats.bs], ['BSN', stats.bsn]] as const) {
    if (!conf?.enabled || !(conf.replicates > 0)) continue;
    if (isValidSeed(toSeed(conf.seed))) return null;
    parts.push(`${key} = ${Math.floor(conf.replicates)}`);
  }
  const m = stats.mcmc;
  if (m?.enabled && m.steps > 0) {
    if (isValidSeed(toSeed(m.seed)) || (typeof m.burn === 'number' && Number.isFinite(m.burn))) return null;
    parts.push(`MCMC = ${Math.floor(m.steps)}`);
  }
  return parts.length ? parts.join(', ') : null;
}

export const stepTomlName = (step: Step, idx: number): string => stepDisplayName(step, idx);

/**
 * Serializes a structured MethodConfig into canonical ChemEx v2 method.toml.
 */
export function configToToml(config: MethodConfig): string {
  if (config.rawOverride !== undefined && config.rawOverride.trim() !== '') {
    return config.rawOverride;
  }

  const lines: string[] = ['FORMAT_VERSION = 2'];

  config.steps.forEach((rawStep, idx) => {
    const step = normalizeStep(rawStep);
    const name = tomlKey(stepTomlName(step, idx));
    lines.push('', `[${name}]`);

    // Selection (step-local; omitted = all profiles)
    const residues = (step.residues || []).map(r => String(r).trim()).filter(Boolean);
    if (residues.length) {
      const key = step.residueMode === 'exclude' ? 'EXCLUDE' : 'INCLUDE';
      const isAll = residues.length === 1 && ['ALL', '*'].includes(residues[0].toUpperCase());
      lines.push(`${key} = ${isAll ? '"ALL"' : `[${residues.map(formatResidue).join(', ')}]`}`);
    }

    // By id → the target's current name; a dangling reference keeps its last known
    // name so the problem stays visible (validation reports it) instead of vanishing.
    const rf = rolesFromTarget(config.steps, idx);
    if (rf.status !== 'none' && rf.name) lines.push(`ROLES_FROM = ${q(rf.name)}`);

    const actions = stepRoleActions(step);
    if (actions.length) {
      lines.push('ROLES = [');
      for (const a of actions) {
        lines.push(`  { ${a.action} = [${a.entries.map(q).join(', ')}] },`);
      }
      lines.push(']');
    }

    // Compact STATISTICS = { … } goes in the step table itself, i.e. before any sub-table header.
    const compactStats = step.statistics ? compactStatistics(step.statistics) : null;
    if (compactStats) lines.push(`STATISTICS = { ${compactStats} }`);

    const search = step.search;
    if (search && search.mode !== 'none' && search.axes.length > 0) {
      if (search.mode === 'grid') {
        lines.push('', `[${name}.SEARCH.GRID]`, 'AXES = [');
        for (const axis of search.axes) lines.push(`  ${q(formatAxis(axis, 'grid'))},`);
        lines.push(']');
      } else {
        lines.push('', `[${name}.SEARCH.DE]`);
        const seed = seedLine(search.seed);
        if (seed) lines.push(seed);
        lines.push('COORDINATES = [');
        for (const axis of search.axes) lines.push(`  ${q(formatAxis(axis, 'de'))},`);
        lines.push(']');
      }
    }

    const stats = step.statistics;
    if (stats && !compactStats) {
      emitResampling(lines, name, 'MC', stats.mc);
      emitResampling(lines, name, 'BS', stats.bs);
      emitResampling(lines, name, 'BSN', stats.bsn);
      emitMcmc(lines, name, stats.mcmc);
    }
  });

  return lines.join('\n') + '\n';
}

/** @deprecated alias kept for callers that asked for v2 explicitly. */
export const configToTomlV2 = configToToml;

// ── Minimal TOML reader (subset used by method files) ───────────────────

/** Integers beyond Number.MAX_SAFE_INTEGER are returned as `bigint` (ChemEx seeds are u64). */
type TomlValue = string | number | bigint | boolean | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlSyntaxError extends Error {}

class TomlReader {
  private i = 0;
  readonly root: TomlTable = {};
  readonly comments: string[] = [];
  /** Ordered list of top-level table names as first declared. */
  readonly topOrder: string[] = [];
  private current: TomlTable = this.root;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): this {
    const s = this.src;
    while (this.i < s.length) {
      this.skipWs(true);
      if (this.i >= s.length) break;
      const c = s[this.i];
      if (c === '[') {
        if (s[this.i + 1] === '[') throw this.err('Arrays of tables ([[...]]) are not supported in method files');
        this.i++;
        const path = this.readKeyPath(']');
        this.expect(']');
        this.current = this.ensureTable(this.root, path, true);
        if (path.length && !this.topOrder.includes(path[0])) this.topOrder.push(path[0]);
      } else {
        const path = this.readKeyPath('=');
        this.expect('=');
        this.skipWs(false);
        const value = this.readValue();
        const parent = this.ensureTable(this.current, path.slice(0, -1), false);
        const last = path[path.length - 1];
        if (last in parent) throw this.err(`Duplicate key ${path.join('.')}`);
        parent[last] = value;
        if (this.current === this.root && isTable(value) && !this.topOrder.includes(last)) this.topOrder.push(last);
      }
      this.endOfLine();
    }
    return this;
  }

  private err(msg: string): TomlSyntaxError {
    const line = this.src.slice(0, this.i).split('\n').length;
    return new TomlSyntaxError(`${msg} (line ${line})`);
  }

  private ensureTable(base: TomlTable, path: string[], isHeader: boolean): TomlTable {
    let t = base;
    path.forEach((k, idx) => {
      const existing = t[k];
      if (existing === undefined) {
        const nt: TomlTable = {};
        t[k] = nt;
        t = nt;
      } else if (isTable(existing)) {
        t = existing;
      } else {
        throw this.err(`Key ${path.slice(0, idx + 1).join('.')} is not a table`);
      }
    });
    void isHeader;
    return t;
  }

  /** Skip spaces/tabs, comments, and (optionally) newlines. Full-line comments are collected. */
  private skipWs(newlines: boolean) {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\n' && newlines) this.i++;
      else if (c === '#') {
        const lineStart = s.lastIndexOf('\n', this.i - 1) + 1;
        const end = s.indexOf('\n', this.i);
        const stop = end === -1 ? s.length : end;
        if (s.slice(lineStart, this.i).trim() === '') this.comments.push(s.slice(lineStart, stop));
        this.i = stop;
      } else break;
    }
  }

  private endOfLine() {
    this.skipWs(false);
    if (this.i < this.src.length && this.src[this.i] !== '\n') throw this.err(`Unexpected '${this.src[this.i]}'`);
  }

  private expect(ch: string) {
    this.skipWs(false);
    if (this.src[this.i] !== ch) throw this.err(`Expected '${ch}'`);
    this.i++;
  }

  private readKeyPath(terminator: string): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs(false);
      const c = this.src[this.i];
      if (c === '"' || c === "'") parts.push(this.readString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.src.slice(this.i));
        if (!m) throw this.err('Invalid key');
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.skipWs(false);
      if (this.src[this.i] === '.') {
        this.i++;
        continue;
      }
      if (this.src[this.i] === terminator) return parts;
      throw this.err(`Expected '${terminator}'`);
    }
  }

  private readString(): string {
    const s = this.src;
    const quote = s[this.i];
    if (s.startsWith(quote.repeat(3), this.i)) throw this.err('Multi-line strings are not supported in method files');
    this.i++;
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\n') break;
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === '\\' && quote === '"') {
        const n = s[this.i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (n in map) {
          out += map[n];
          this.i += 2;
          continue;
        }
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(s.slice(this.i + 2, this.i + 2 + len), 16));
          this.i += 2 + len;
          continue;
        }
        throw this.err('Invalid escape');
      }
      out += c;
      this.i++;
    }
    throw this.err('Unterminated string');
  }

  private readValue(): TomlValue {
    const s = this.src;
    const c = s[this.i];
    if (c === '"' || c === "'") return this.readString();
    if (c === '[') {
      this.i++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.skipWs(true);
        if (s[this.i] === ']') {
          this.i++;
          return arr;
        }
        arr.push(this.readValue());
        this.skipWs(true);
        if (s[this.i] === ',') {
          this.i++;
          continue;
        }
        if (s[this.i] === ']') {
          this.i++;
          return arr;
        }
        throw this.err("Expected ',' or ']' in array");
      }
    }
    if (c === '{') {
      this.i++;
      const t: TomlTable = {};
      this.skipWs(false);
      if (s[this.i] === '}') {
        this.i++;
        return t;
      }
      for (;;) {
        const path = this.readKeyPath('=');
        this.expect('=');
        this.skipWs(false);
        const v = this.readValue();
        const parent = this.ensureTable(t, path.slice(0, -1), false);
        const last = path[path.length - 1];
        if (last in parent) throw this.err(`Duplicate key ${path.join('.')}`);
        parent[last] = v;
        this.skipWs(true); // tolerate newlines (TOML 1.1 style) inside inline tables
        if (s[this.i] === ',') {
          this.i++;
          this.skipWs(true);
          if (s[this.i] === '}') {
            this.i++;
            return t;
          }
          continue;
        }
        if (s[this.i] === '}') {
          this.i++;
          return t;
        }
        throw this.err("Expected ',' or '}' in inline table");
      }
    }
    const m = /^(true|false|[+-]?(?:inf|nan)|[+-]?[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?|0x[0-9a-fA-F_]+)/.exec(s.slice(this.i));
    if (!m) throw this.err('Invalid value');
    this.i += m[0].length;
    const tok = m[0];
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (/inf$/.test(tok)) return tok.startsWith('-') ? -Infinity : Infinity;
    if (/nan$/.test(tok)) return NaN;
    if (tok.startsWith('0x')) return safeInt(BigInt(tok.replace(/_/g, '')));
    const clean = tok.replace(/_/g, '');
    if (/^[+-]?\d+$/.test(clean)) return safeInt(BigInt(clean));
    return Number(clean);
  }
}

/** Integer token → number when exactly representable, else bigint (no precision loss). */
function safeInt(b: bigint): number | bigint {
  const n = Number(b);
  return Number.isSafeInteger(n) ? n : b;
}

/** JSON.stringify that tolerates bigint (used only for diagnostics in `unparsed`). */
function show(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

function isTable(v: unknown): v is TomlTable {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse TOML text into a plain object (subset sufficient for ChemEx method/parameter files). */
export function parseTomlDocument(text: string): { data: TomlTable; comments: string[]; topOrder: string[] } {
  const r = new TomlReader(text).parse();
  return { data: r.root, comments: r.comments, topOrder: r.topOrder };
}

// ── Interpretation ──────────────────────────────────────────────────────

/** Case-insensitive table lookup (ChemEx lower-cases method keys). */
function get(t: TomlTable | undefined, key: string): TomlValue | undefined {
  if (!t) return undefined;
  const k = Object.keys(t).find(x => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : t[k];
}

function strList(v: TomlValue | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(x => String(x));
  return [String(v)];
}

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_CONSTRAINT = /^\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*=\s*([\s\S]+)$/;
const BOUND_CONSTRAINT = /^\s*\[?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]?\s*(<=?|>=?)\s*[-+.\deE]+\s*$/;

function upsertParam(step: Step, name: string, update: Partial<ParamSetting>) {
  const uName = name.toUpperCase();
  const existing = step.parameters.find(p => p.name.toUpperCase() === uName);
  if (existing) Object.assign(existing, update);
  else step.parameters.push({ name: uName, mode: update.mode || 'fit', ...update });
}

/** Parse "[SEL] = fn(a, b[, n])" or legacy "[SEL] = (a, b, c)" / "[SEL] = [a, b, n]". */
export function parseAxisString(text: string): SearchAxis | null {
  const m = /^\s*\[([^\]]+)\]\s*=\s*([A-Za-z_]*)\s*[([]\s*([^)\]]*)[)\]]\s*$/.exec(text) ||
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_]*)\s*[([]\s*([^)\]]*)[)\]]\s*$/.exec(text);
  if (!m) return null;
  const selector = m[1].trim();
  const [param, ...quals] = selector.split(',').map(s => s.trim());
  const fnRaw = m[2].toLowerCase();
  const args = m[3].split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (args.some(a => !Number.isFinite(a))) return null;
  const base = { id: newMethodId('axis'), param: param.toUpperCase(), qualifier: quals.length ? quals.join(', ') : undefined };
  if (fnRaw === 'values' || fnRaw === '') {
    // legacy bare tuple "(a, b, c)" → values(...); legacy "[min, max, n]" handled by caller
    return { ...base, fn: 'values', low: Math.min(...args), high: Math.max(...args), count: args.length, values: args };
  }
  if (fnRaw !== 'lin' && fnRaw !== 'log') return null;
  return { ...base, fn: fnRaw as SearchFunction, low: args[0], high: args[1], count: args.length >= 3 ? Math.floor(args[2]) : 0 };
}

function parseRoles(step: Step, roles: TomlValue, unparsed: string[]) {
  if (!Array.isArray(roles)) {
    unparsed.push(`ROLES must be an array of single-key actions in step ${step.name}`);
    return;
  }
  const assigned = new Set<string>();
  let inTable = true;
  const rules: RoleRule[] = [];
  for (const actionTable of roles) {
    if (!isTable(actionTable) || Object.keys(actionTable).length !== 1) {
      unparsed.push(`Invalid ROLES action in step ${step.name}: ${show(actionTable)}`);
      continue;
    }
    const key = Object.keys(actionTable)[0].toUpperCase();
    if (key !== 'FIT' && key !== 'FIX' && key !== 'CONSTRAIN') {
      unparsed.push(`Unknown ROLES action ${key} in step ${step.name}`);
      continue;
    }
    const entries = strList(actionTable[Object.keys(actionTable)[0]]).map(e => e.trim()).filter(Boolean);
    const action = key as RoleAction;

    // Plain-name actions on not-yet-assigned parameters map onto the table;
    // anything selector-qualified or overriding switches to ordered rules.
    let names: string[] | null = null;
    if (inTable) {
      if (action === 'CONSTRAIN') {
        const targets = entries.map(e => PLAIN_CONSTRAINT.exec(e)?.[1]?.toUpperCase() ?? null);
        if (targets.every(t => t !== null)) names = targets as string[];
      } else if (entries.every(e => SIMPLE_NAME.test(e))) {
        names = entries.map(e => e.toUpperCase());
      } else {
        // Mixed FIT/FIX action: plain names on fresh parameters go to the table,
        // the qualified remainder becomes the first ordered rule (same effect).
        const plain = entries.filter(e => SIMPLE_NAME.test(e)).map(e => e.toUpperCase());
        const qualified = entries.filter(e => !SIMPLE_NAME.test(e));
        if (plain.length && plain.every(n => !assigned.has(n)) && new Set(plain).size === plain.length) {
          plain.forEach(n => {
            assigned.add(n);
            upsertParam(step, n, { mode: action === 'FIT' ? 'fit' : 'fix' });
          });
          inTable = false;
          rules.push({ id: newMethodId('rule'), action, entries: qualified });
          continue;
        }
      }
      if (names && (names.some(n => assigned.has(n)) || new Set(names).size !== names.length)) names = null;
    }
    if (inTable && names) {
      names.forEach((n, idx) => {
        assigned.add(n);
        if (action === 'CONSTRAIN') {
          upsertParam(step, n, { mode: 'constrain', expression: PLAIN_CONSTRAINT.exec(entries[idx])![2].trim() });
        } else {
          upsertParam(step, n, { mode: action === 'FIT' ? 'fit' : 'fix' });
        }
      });
    } else {
      inTable = false;
      rules.push({ id: newMethodId('rule'), action, entries });
    }
  }
  step.roleRules = rules;
}

/**
 * Read a SEED value. ChemEx requires a TOML integer; anything else is kept for
 * validation to report (as raw text) and recorded in `unparsed`, never dropped.
 */
function readSeed(v: TomlValue | undefined, unparsed: string[], ctx: string): string | undefined {
  if (v === undefined) return undefined;
  if ((typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint') return toSeed(v);
  unparsed.push(`${ctx} SEED = ${show(v)}  (SEED must be an unsigned 64-bit integer)`);
  return toSeed(typeof v === 'object' ? show(v) : v);
}

function parseResampling(v: TomlValue | undefined, unparsed: string[], ctx: string): ResamplingConfig | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return { enabled: true, replicates: Math.floor(v) };
  if (isTable(v)) {
    const reps = get(v, 'REPLICATES');
    const seed = get(v, 'SEED');
    if (typeof reps !== 'number') unparsed.push(`${ctx} REPLICATES = ${show(reps)}  (expected a positive integer; defaulted to 100)`);
    return {
      enabled: true,
      replicates: typeof reps === 'number' ? Math.floor(reps) : 100,
      seed: readSeed(seed, unparsed, ctx),
    };
  }
  unparsed.push(`${ctx} = ${show(v)}  (expected a replicate count or a table)`);
  return undefined;
}

function parseMcmc(v: TomlValue | undefined, unparsed: string[], stepName: string): McmcConfig | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return { enabled: true, steps: Math.floor(v), burn: 'auto' };
  if (!isTable(v)) {
    unparsed.push(`[${stepName}.STATISTICS] MCMC = ${show(v)}  (expected a step count or a table)`);
    return undefined;
  }
  const steps = get(v, 'STEPS');
  const burn = get(v, 'BURN');
  const seed = get(v, 'SEED');
  const m: McmcConfig = {
    enabled: true,
    steps: typeof steps === 'number' ? Math.floor(steps) : 5000,
    burn: typeof burn === 'number' ? Math.floor(burn) : 'auto',
    seed: readSeed(seed, unparsed, `[${stepName}.STATISTICS.MCMC]`),
  };
  for (const legacy of ['THIN', 'WALKERS', 'WORKERS', 'UPDATE_PARAMETERS']) {
    const lv = get(v, legacy);
    if (lv !== undefined) {
      unparsed.push(`[${stepName}.STATISTICS.MCMC] ${legacy} = ${String(lv)}  (v1-only; ignored by ChemEx v2)`);
      if (legacy === 'THIN' && typeof lv === 'number') m.thin = lv;
      if (legacy === 'WALKERS' && typeof lv === 'number') m.walkers = lv;
      if (legacy === 'WORKERS' && typeof lv === 'number') m.workers = lv;
      if (legacy === 'UPDATE_PARAMETERS') m.update_parameters = lv === true;
    }
  }
  return m;
}

function parseStatistics(v: TomlValue | undefined, unparsed: string[], stepName: string): StatisticsConfig | undefined {
  if (v === undefined) return undefined;
  if (!isTable(v)) {
    unparsed.push(`[${stepName}] STATISTICS = ${show(v)}  (expected a table)`);
    return undefined;
  }
  const stats: StatisticsConfig = {};
  const mc = parseResampling(get(v, 'MC'), unparsed, `[${stepName}.STATISTICS.MC]`);
  const bs = parseResampling(get(v, 'BS'), unparsed, `[${stepName}.STATISTICS.BS]`);
  const bsn = parseResampling(get(v, 'BSN'), unparsed, `[${stepName}.STATISTICS.BSN]`);
  const mcmc = parseMcmc(get(v, 'MCMC'), unparsed, stepName);
  if (mc) stats.mc = mc;
  if (bs) stats.bs = bs;
  if (bsn) stats.bsn = bsn;
  if (mcmc) stats.mcmc = mcmc;
  return Object.keys(stats).length ? stats : undefined;
}

function parseAxes(list: TomlValue | undefined, unparsed: string[], ctx: string): SearchAxis[] {
  const axes: SearchAxis[] = [];
  for (const entry of strList(list)) {
    // legacy "[PB] = [0.01, 0.2, 20]" (min, max, count) → lin
    const legacyArr = /^\s*\[?([A-Za-z_][A-Za-z0-9_]*)\]?\s*=\s*\[\s*([-+.\deE]+)\s*,\s*([-+.\deE]+)\s*,\s*(\d+)\s*\]\s*$/.exec(entry);
    if (legacyArr) {
      axes.push({
        id: newMethodId('axis'),
        param: legacyArr[1].toUpperCase(),
        fn: 'lin',
        low: Number(legacyArr[2]),
        high: Number(legacyArr[3]),
        count: parseInt(legacyArr[4], 10),
      });
      continue;
    }
    const axis = parseAxisString(entry);
    if (axis) axes.push(axis);
    else unparsed.push(`${ctx}: ${entry}`);
  }
  return axes;
}

const KNOWN_V2_STEP_KEYS = new Set(['INCLUDE', 'EXCLUDE', 'ROLES', 'ROLES_FROM', 'SEARCH', 'STATISTICS']);
const KNOWN_V1_STEP_KEYS = new Set(['INCLUDE', 'EXCLUDE', 'FIT', 'FIX', 'CONSTRAINTS', 'GRID', 'STATISTICS', 'FITMETHOD']);

function parseSelection(step: Step, sec: TomlTable) {
  const inc = get(sec, 'INCLUDE');
  const exc = get(sec, 'EXCLUDE');
  if (inc !== undefined) {
    step.residueMode = 'include';
    step.residues = strList(inc).map(s => (s === '*' ? 'ALL' : s));
  } else if (exc !== undefined) {
    step.residueMode = 'exclude';
    step.residues = strList(exc);
  }
}

function parseV2Step(name: string, sec: TomlTable, unparsed: string[]): Step {
  const step: Step = { id: newMethodId('step'), name, parameters: [], residueMode: 'include', residues: [], roleRules: [] };
  parseSelection(step, sec);
  const rf = get(sec, 'ROLES_FROM');
  if (typeof rf === 'string') step.rolesFrom = rf;
  const roles = get(sec, 'ROLES');
  if (roles !== undefined) parseRoles(step, roles, unparsed);

  const search = get(sec, 'SEARCH');
  if (isTable(search)) {
    const grid = get(search, 'GRID');
    const de = get(search, 'DE');
    if (isTable(grid)) {
      step.search = { mode: 'grid', axes: parseAxes(get(grid, 'AXES'), unparsed, `[${name}.SEARCH.GRID]`) };
    } else if (isTable(de)) {
      const seed = get(de, 'SEED');
      step.search = {
        mode: 'de',
        axes: parseAxes(get(de, 'COORDINATES'), unparsed, `[${name}.SEARCH.DE]`),
        seed: readSeed(seed, unparsed, `[${name}.SEARCH.DE]`),
      };
    }
  }
  const stats = parseStatistics(get(sec, 'STATISTICS'), unparsed, name);
  if (stats) step.statistics = stats;

  for (const k of Object.keys(sec)) {
    if (!KNOWN_V2_STEP_KEYS.has(k.toUpperCase())) unparsed.push(`[${name}] ${k} = ${show(sec[k])}  (not a v2 step field)`);
  }
  return step;
}

function parseV1Step(name: string, sec: TomlTable, unparsed: string[]): Step {
  const step: Step = { id: newMethodId('step'), name, parameters: [], residueMode: 'include', residues: [], roleRules: [] };
  parseSelection(step, sec);

  // v1 applies buckets CONSTRAINTS → FIX → FIT; FIT wins on overlap.
  for (const c of strList(get(sec, 'CONSTRAINTS'))) {
    const bound = BOUND_CONSTRAINT.exec(c);
    if (bound) {
      unparsed.push(`[${name}] CONSTRAINTS "${c}"  (inequality bounds are not supported by ChemEx v2 methods)`);
      const exists = step.parameters.some(p => p.name.toUpperCase() === bound[1].toUpperCase());
      upsertParam(step, bound[1], {
        ...(exists ? {} : { mode: 'default' as const }),
        bounds: c.replace(/^\s*\[?\s*[A-Za-z_][A-Za-z0-9_]*\s*\]?\s*/, ''),
      });
      continue;
    }
    const m = PLAIN_CONSTRAINT.exec(c);
    if (m) upsertParam(step, m[1], { mode: 'constrain', expression: m[2].trim() });
    else (step.roleRules ??= []).push({ id: newMethodId('rule'), action: 'CONSTRAIN', entries: [c] });
  }
  const applyBucket = (key: 'FIX' | 'FIT') => {
    for (const sel of strList(get(sec, key))) {
      if (SIMPLE_NAME.test(sel.trim())) upsertParam(step, sel.trim(), { mode: key === 'FIT' ? 'fit' : 'fix' });
      else (step.roleRules ??= []).push({ id: newMethodId('rule'), action: key, entries: [sel] });
    }
  };
  applyBucket('FIX');
  applyBucket('FIT');

  const grid = get(sec, 'GRID');
  if (grid !== undefined) {
    let entries: TomlValue = grid;
    if (isTable(grid)) {
      // legacy inline table { PB = [min, max, n] }
      entries = Object.entries(grid).map(([k, v]) =>
        Array.isArray(v) ? `[${k}] = [${v.join(', ')}]` : `[${k}] = ${String(v)}`
      );
    }
    step.search = { mode: 'grid', axes: parseAxes(entries, unparsed, `[${name}] GRID`) };
  }
  const fm = get(sec, 'FITMETHOD');
  if (fm !== undefined) unparsed.push(`[${name}] FITMETHOD = ${show(fm)}  (v2 has no FITMETHOD; TRF is implicit)`);

  const stats = parseStatistics(get(sec, 'STATISTICS'), unparsed, name);
  if (stats) step.statistics = stats;

  for (const k of Object.keys(sec)) {
    if (!KNOWN_V1_STEP_KEYS.has(k.toUpperCase())) unparsed.push(`[${name}] ${k} = ${show(sec[k])}  (unknown method field)`);
  }
  return step;
}

/**
 * Parse a ChemEx method.toml (v2, or legacy v1 migrated to v2 semantics).
 * Throws TomlSyntaxError on malformed TOML.
 */
export function tomlToConfig(toml: string): ParseResult {
  if (!toml || toml.trim() === '') {
    return { config: { steps: [createDefaultStep()] }, unparsed: [] };
  }
  const { data, comments, topOrder } = parseTomlDocument(toml);
  const unparsed: string[] = [...comments];

  const fv = get(data, 'FORMAT_VERSION');
  const isV2 = fv !== undefined;
  if (isV2 && fv !== 2) unparsed.push(`FORMAT_VERSION = ${String(fv)}  (only version 2 is supported)`);

  const steps: Step[] = [];
  for (const name of topOrder) {
    const sec = data[name];
    if (!isTable(sec)) continue;
    const stepName = name;
    steps.push(isV2 ? parseV2Step(stepName, sec, unparsed) : parseV1Step(stepName, sec, unparsed));
  }
  for (const k of Object.keys(data)) {
    if (!isTable(data[k]) && k.toUpperCase() !== 'FORMAT_VERSION') unparsed.push(`${k} = ${show(data[k])}  (top-level key outside any step)`);
  }

  // v1 carried roles and profile selection implicitly between steps; make that explicit.
  if (!isV2) {
    for (let i = 1; i < steps.length; i++) {
      steps[i].rolesFrom = steps[i - 1].name;
      steps[i].rolesFromStepId = steps[i - 1].id;
      if (steps[i].residues.length === 0 && steps[i - 1].residues.length > 0) {
        steps[i].residueMode = steps[i - 1].residueMode;
        steps[i].residues = [...steps[i - 1].residues];
      }
    }
  }

  return {
    config: linkRolesFrom({ steps: steps.length > 0 ? steps : [createDefaultStep()] }),
    unparsed,
  };
}
