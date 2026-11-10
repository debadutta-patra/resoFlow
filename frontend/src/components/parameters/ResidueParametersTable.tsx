import React, { useEffect, useState, useMemo } from 'react';
import {
  Search,
  ArrowUpDown,
  RefreshCw,
  AlertTriangle,
  MinusCircle,
  PlusCircle,
  HelpCircle,
  CheckCircle2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import type {
  ParameterConfig,
  ResidueParams,
  PickSetData,
  ProfileRef,
} from '../../lib/parameterConfig';
import {
  computePickHash,
  extractResidueNumber,
  normalizeResidueKey,
  getCanonicalResidueKey,
  isResidueExcluded,
  toggleExcludeResidue,
  isPickSourceStale,
  withBound,
  withValue,
  editResidueValue,
  bulkEditResidues,
  unsetStartingParams,
  type ResidueCell,
} from '../../lib/parameterConfig';
import { fallbackDefaults, fmtDefault, type ParamDefaultsLookup } from '../../lib/chemexDefaults';
import { NumericField } from './NumericField';
import { residueTreatment, resolvedStepFor } from '../../lib/parameterRoleChip';
import type { ParameterIssue } from '../../lib/parameterValidation';
import { tcDerived } from '../../lib/tcModel';

const DEFAULT_START_NAMES = ['cs_a', 'dw_ab'];
import type { ResolvedStep } from '../../lib/resolvedRoles';
import type { MethodConfig } from '../../lib/methodConfig';
import type { ResidueProfileCell } from '../../lib/experimentPlugin';
import { ParameterBadge } from './ParameterBadge';
import { ProfileThumbnail, type CestProfile } from './ProfileThumbnail';

export type { ResidueProfileCell };

export interface ResidueParametersTableProps {
  config: ParameterConfig;
  onChange: (updatedConfig: ParameterConfig) => void;
  /** Starting-value "picks" per residue: CEST dip picks, or CPMG peak-fit CS_A. */
  picks: Record<string, PickSetData>;
  profiles: ProfileRef[];
  methodConfig?: MethodConfig;
  activeStepIdx?: number;
  onNavigateToMethods?: () => void;
  /**
   * Experiment capabilities (declared by the experiment plugin). Defaults reproduce
   * the CEST table: picks carry a B-state shift, rows show a CEST profile.
   */
  expectsBPicks?: boolean;
  profileTitle?: string;
  pickNoun?: string;
  pickedLabel?: string;
  staleLabel?: string;
  renderProfile?: (row: ResidueProfileCell, size: 'thumb' | 'large') => React.ReactNode;
  /** Optional override for excluding a residue (defaults to toggling config.excludedResidues). */
  onToggleExclude?: (resKey: string) => void;
  /** ChemEx default values and bounds (backend catalogue); defaults to the static table. */
  defaults?: ParamDefaultsLookup;
  /** |DW_AB| above which the cell is highlighted (nucleus-aware, from the module). */
  maxDwWarn?: number;
  /** ChemEx-resolved roles per method step (authoritative for the Method Step column). */
  resolvedSteps?: ResolvedStep[];
  /** Validation issues per residue key (shown as a row badge). */
  issuesByResidue?: Record<string, ParameterIssue[]>;
  /** Scroll to and highlight this residue (nonce changes on every request). */
  focus?: { resKey: string; nonce: number } | null;
  /** `.tc` model: edit CS0_A/CS1_A/DW0_AB/DW1_AB; CS_A/DW_AB are derived at `temperatureC`. */
  tc?: { tref: number; temperatureC: number };
  /** Per-residue starting parameters counted for "ChemEx default" (default CS_A, DW_AB). */
  startNames?: string[];
}

const TC_COLUMNS: Array<{ key: 'cs0_a' | 'cs1_a' | 'dw0_ab' | 'dw1_ab'; label: string; title: string }> = [
  { key: 'cs0_a', label: 'CS0_A (ppm)', title: 'State-A shift at TREF' },
  { key: 'cs1_a', label: 'CS1_A (ppm/°C)', title: 'State-A shift temperature coefficient' },
  { key: 'dw0_ab', label: 'DW0_AB (ppm)', title: 'CS_B − CS_A at TREF' },
  { key: 'dw1_ab', label: 'DW1_AB (ppm/°C)', title: 'Temperature coefficient of CS_B − CS_A' },
];

const BOUND_PARAMS: Array<{ key: 'cs_a' | 'dw_ab' | 'r1_a' | 'r2_a'; label: string }> = [
  { key: 'cs_a', label: 'CS_A' },
  { key: 'dw_ab', label: 'DW_AB' },
  { key: 'r1_a', label: 'R1_A' },
  { key: 'r2_a', label: 'R2_A' },
];

const defaultRenderProfile = (row: ResidueProfileCell, size: 'thumb' | 'large') => (
  <ProfileThumbnail
    profile={row.profile as CestProfile | undefined}
    csA={row.cs_a}
    csB={row.cs_b}
    width={size === 'thumb' ? 130 : 480}
    height={size === 'thumb' ? 34 : 120}
    className={size === 'large' ? 'w-full' : undefined}
  />
);

export type FilterSource =
  | 'all'
  | 'picked'
  | 'manual'
  | 'stale'
  | 'no_b'
  | 'imported'
  | 'excluded'
  | 'chemex_default'
  | 'issues';

const COLUMNS_STORAGE_KEY = 'resoflow.parameters.showRelaxationColumns';
const readShowRates = (): boolean => {
  try {
    return localStorage.getItem(COLUMNS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
const BULK_FIELDS: Array<{ key: ResidueCell; label: string }> = [
  { key: 'cs_a', label: 'CS_A' },
  { key: 'dw_ab', label: 'DW_AB' },
  { key: 'r1_a', label: 'R1_A' },
  { key: 'r2_a', label: 'R2_A' },
];
export type SortField = 'residue' | 'cs_a' | 'cs_b' | 'dw_ab' | 'source';

interface TableRowData {
  resKey: string;
  label: string;
  cs_a: number | null;
  cs_b: number | null;
  dw_ab: number | null;
  r1_a?: number | null;
  r2_a?: number | null;
  sourceCsA?: any;
  sourceDw?: any;
  isStale: boolean;
  hasNoBPick: boolean;
  hasPick: boolean;
  isExcluded: boolean;
  methodTreatment?: string;
  profile?: ProfileRef;
  /** The residue's stored parameters (for bounds). */
  params: ResidueParams;
  /** Values actually written to parameters.toml (null = ChemEx default applies). */
  cfgCsA: number | null;
  cfgDw: number | null;
  /** Pick values not yet applied to the config (shown as a hint). */
  pickCsA: number | null;
  pickDw: number | null;
}

export const ResidueParametersTable: React.FC<ResidueParametersTableProps> = ({
  config,
  onChange,
  picks,
  profiles,
  methodConfig,
  activeStepIdx = 0,
  onNavigateToMethods,
  expectsBPicks = true,
  profileTitle = 'CEST Profile',
  pickNoun = 'pick',
  pickedLabel = 'Picked',
  staleLabel = 'Pick Moved',
  renderProfile = defaultRenderProfile,
  onToggleExclude,
  defaults = fallbackDefaults,
  maxDwWarn = 15,
  resolvedSteps,
  issuesByResidue = {},
  focus = null,
  tc,
  startNames = DEFAULT_START_NAMES,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sourceFilter, setSourceFilter] = useState<FilterSource>('all');
  const [sortField, setSortField] = useState<SortField>('residue');
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkField, setBulkField] = useState<ResidueCell>('cs_a');
  const [bulkValue, setBulkValue] = useState<number | undefined>(undefined);
  const [showRates, setShowRates] = useState<boolean>(readShowRates);
  const toggleRates = () =>
    setShowRates(prev => {
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, prev ? '0' : '1');
      } catch {
        /* per-viewer convenience only */
      }
      return !prev;
    });
  const issuesFor = (resKey: string): ParameterIssue[] =>
    Object.entries(issuesByResidue)
      .filter(([k]) => k === resKey || getCanonicalResidueKey(k, profiles) === resKey)
      .flatMap(([, v]) => v);

  // Pagination for fast rendering with 300+ residues
  const pageSize = 50;
  const [page, setPage] = useState(0);

  // Quick lookup for profiles
  const profileMap = useMemo(() => {
    const map: Record<string, ProfileRef> = {};
    for (const p of profiles) {
      map[p.residue] = p;
      if (p.full_residue) map[p.full_residue] = p;
    }
    return map;
  }, [profiles]);

  // Method treatment for the active step: ChemEx's resolved roles, else the step's table/rules.
  const activeStep = methodConfig?.steps?.[activeStepIdx];
  const resolvedActive = resolvedStepFor(resolvedSteps, activeStep, activeStepIdx);
  const methodTreatmentMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (!activeStep) return map;
    const keys = new Set([...Object.keys(config.residues || {}), ...profiles.map(p => p.residue)]);
    for (const res of keys) {
      const t = residueTreatment(activeStep, resolvedActive, res, defaults);
      if (t) map[res] = t;
    }
    return map;
  }, [activeStep, resolvedActive, config.residues, profiles, defaults]);

  // Transform config & picks into deduplicated TableRowData
  const allRows = useMemo<TableRowData[]>(() => {
    // Group all residues by their canonical key
    const canonicalMap = new Map<string, {
      canonicalKey: string;
      label: string;
      aliases: string[];
      profile?: ProfileRef;
    }>();

    // 1. Register from profiles (ground truth experiment files)
    for (const p of profiles) {
      const canonical = p.residue;
      const aliases = Array.from(new Set([
        p.residue,
        p.full_residue || '',
        normalizeResidueKey(p.full_residue || ''),
        normalizeResidueKey(p.residue),
        p.residue.replace(/\D/g, '') + 'N',
      ])).filter(Boolean);

      canonicalMap.set(canonical, {
        canonicalKey: canonical,
        label: p.full_residue || normalizeResidueKey(p.residue) || p.residue,
        aliases,
        profile: p,
      });
    }

    // 2. Register from config.residues
    for (const resKey of Object.keys(config.residues || {})) {
      const canonical = getCanonicalResidueKey(resKey, profiles);
      if (!canonicalMap.has(canonical)) {
        canonicalMap.set(canonical, {
          canonicalKey: canonical,
          label: normalizeResidueKey(resKey) || resKey,
          aliases: [resKey, canonical, normalizeResidueKey(resKey)],
          profile: profileMap[resKey] || profileMap[canonical],
        });
      } else {
        const entry = canonicalMap.get(canonical)!;
        if (!entry.aliases.includes(resKey)) entry.aliases.push(resKey);
      }
    }

    // 3. Register from picks
    for (const resKey of Object.keys(picks || {})) {
      const canonical = getCanonicalResidueKey(resKey, profiles);
      if (!canonicalMap.has(canonical)) {
        canonicalMap.set(canonical, {
          canonicalKey: canonical,
          label: normalizeResidueKey(resKey) || resKey,
          aliases: [resKey, canonical, normalizeResidueKey(resKey)],
          profile: profileMap[resKey] || profileMap[canonical],
        });
      } else {
        const entry = canonicalMap.get(canonical)!;
        if (!entry.aliases.includes(resKey)) entry.aliases.push(resKey);
      }
    }

    // Build exactly one row per physical residue
    return Array.from(canonicalMap.values()).map(({ canonicalKey, label, aliases, profile: prof }) => {
      // Find rParams: check canonicalKey first, then search aliases
      let rParams: ResidueParams = config.residues?.[canonicalKey] || {};
      if (!rParams.cs_a && !rParams.dw_ab) {
        for (const alias of aliases) {
          if (config.residues?.[alias]?.cs_a || config.residues?.[alias]?.dw_ab) {
            rParams = { ...config.residues[alias], ...rParams };
          }
        }
      }

      // Find picks: check canonicalKey first, then search aliases
      let pk: PickSetData | undefined = picks[canonicalKey];
      if (!pk || pk.cs_a == null) {
        for (const alias of aliases) {
          if (picks[alias]?.cs_a != null) {
            pk = picks[alias];
            break;
          }
        }
      }

      const cs_a_val = rParams.cs_a?.value ?? (pk?.cs_a != null ? pk.cs_a : null);
      const hasBPick = pk?.cs_b != null && !isNaN(pk.cs_b);
      const dw_ab_val = rParams.dw_ab?.value ?? (hasBPick && pk?.cs_a != null ? pk.cs_b! - pk.cs_a : null);
      
      let cs_b_val: number | null = null;
      if (cs_a_val !== null && dw_ab_val !== null) {
        cs_b_val = parseFloat((cs_a_val + dw_ab_val).toFixed(3));
      } else if (hasBPick && pk?.cs_b != null) {
        cs_b_val = pk.cs_b;
      }

      // Check staleness
      const isStale = isPickSourceStale(rParams.cs_a?.source, pk) || isPickSourceStale(rParams.dw_ab?.source, pk);

      const hasPick = pk?.cs_a != null;
      const hasNoBPick = expectsBPicks && pk?.cs_a != null && (pk.cs_b == null || isNaN(pk.cs_b));

      // Method treatment
      let methodTreatment = methodTreatmentMap[canonicalKey];
      if (!methodTreatment) {
        for (const alias of aliases) {
          if (methodTreatmentMap[alias]) {
            methodTreatment = methodTreatmentMap[alias];
            break;
          }
        }
      }

      const isExcluded = isResidueExcluded(config, canonicalKey, profiles) ||
        aliases.some(a => isResidueExcluded(config, a, profiles));

      return {
        resKey: canonicalKey,
        label: label || canonicalKey,
        cs_a: cs_a_val,
        cs_b: cs_b_val,
        dw_ab: dw_ab_val,
        r1_a: rParams.r1_a?.value ?? null,
        r2_a: rParams.r2_a?.value ?? null,
        sourceCsA: rParams.cs_a?.source,
        sourceDw: rParams.dw_ab?.source ?? config.globals?.dw_ab?.source,
        isStale,
        hasNoBPick,
        hasPick,
        isExcluded,
        methodTreatment,
        profile: prof,
        params: rParams,
        cfgCsA: rParams.cs_a?.value ?? null,
        cfgDw: rParams.dw_ab?.value ?? config.globals?.dw_ab?.value ?? null,
        pickCsA: pk?.cs_a != null && !isNaN(pk.cs_a) ? pk.cs_a : null,
        pickDw: hasBPick && pk?.cs_a != null ? parseFloat((pk.cs_b! - pk.cs_a).toFixed(3)) : null,
      };
    });
  }, [config.residues, config.globals, config.excludedResidues, picks, profiles, profileMap, methodTreatmentMap, expectsBPicks]);

  // Aggregate Counts for Summary Header
  const counts = useMemo(() => {
    let picked = 0;
    let manual = 0;
    let stale = 0;
    let no_b = 0;
    let imported = 0;
    let excluded = 0;
    let chemexDefault = 0;
    let staleAll = 0;
    let withIssues = 0;

    for (const r of allRows) {
      if (!r.isExcluded && unsetStartingParams(config, r.resKey, startNames).length > 0) chemexDefault++;
      if (r.isStale && !r.isExcluded) staleAll++;
      if (issuesFor(r.resKey).length > 0) withIssues++;
      if (r.isExcluded) {
        excluded++;
      } else if (r.isStale) {
        stale++;
      } else if (r.hasNoBPick) {
        no_b++;
      } else if (r.sourceCsA?.kind === 'manual' || r.sourceDw?.kind === 'manual') {
        manual++;
      } else if (r.sourceCsA?.kind === 'pick' || r.sourceDw?.kind === 'pick') {
        picked++;
      } else if (r.sourceCsA?.kind === 'imported' || r.sourceDw?.kind === 'imported') {
        imported++;
      }
    }
    return {
      total: allRows.length,
      picked,
      manual,
      stale,
      no_b,
      imported,
      excluded,
      chemexDefault,
      staleAll,
      withIssues,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- issuesFor reads issuesByResidue/profiles
  }, [allRows, config, issuesByResidue, profiles, startNames]);

  // Filter & Sort
  const filteredRows = useMemo(() => {
    return allRows.filter(row => {
      // 1. Search term
      if (searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        if (!row.resKey.toLowerCase().includes(term) && !row.label.toLowerCase().includes(term)) {
          return false;
        }
      }

      // 2. Source Filter
      if (sourceFilter === 'excluded') {
        return row.isExcluded;
      }
      if (sourceFilter === 'picked') {
        return (row.sourceCsA?.kind === 'pick' || row.sourceDw?.kind === 'pick') && !row.isStale && !row.isExcluded;
      }
      if (sourceFilter === 'manual') {
        return (row.sourceCsA?.kind === 'manual' || row.sourceDw?.kind === 'manual') && !row.isExcluded;
      }
      if (sourceFilter === 'stale') {
        return row.isStale && !row.isExcluded;
      }
      if (sourceFilter === 'no_b') {
        return row.hasNoBPick && !row.isExcluded;
      }
      if (sourceFilter === 'chemex_default') {
        return !row.isExcluded && unsetStartingParams(config, row.resKey, startNames).length > 0;
      }
      if (sourceFilter === 'issues') {
        return issuesFor(row.resKey).length > 0;
      }
      if (sourceFilter === 'imported') {
        return (row.sourceCsA?.kind === 'imported' || row.sourceDw?.kind === 'imported') && !row.isExcluded;
      }

      return true;
    }).sort((a, b) => {
      let cmp = 0;
      if (sortField === 'residue') {
        const numA = extractResidueNumber(a.resKey);
        const numB = extractResidueNumber(b.resKey);
        cmp = numA !== numB ? numA - numB : a.resKey.localeCompare(b.resKey);
      } else if (sortField === 'cs_a') {
        cmp = (a.cs_a ?? -999) - (b.cs_a ?? -999);
      } else if (sortField === 'cs_b') {
        cmp = (a.cs_b ?? -999) - (b.cs_b ?? -999);
      } else if (sortField === 'dw_ab') {
        cmp = (a.dw_ab ?? -999) - (b.dw_ab ?? -999);
      } else if (sortField === 'source') {
        const getSrcPriority = (r: TableRowData) => {
          if (r.isExcluded) return 0;
          if (r.isStale) return 1;
          if (r.hasNoBPick) return 2;
          if (r.sourceCsA?.kind === 'manual') return 3;
          if (r.sourceCsA?.kind === 'pick') return 4;
          return 5;
        };
        cmp = getSrcPriority(a) - getSrcPriority(b);
      }
      return sortAsc ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- issuesFor reads issuesByResidue/profiles
  }, [allRows, searchTerm, sourceFilter, sortField, sortAsc, config, issuesByResidue, profiles, startNames]);

  // Paginated slice
  const paginatedRows = useMemo(() => {
    const start = page * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const totalPages = Math.ceil(filteredRows.length / pageSize);

  // Cell Edit Handlers
  const handleCellEdit = (resKey: string, field: ResidueCell, newVal: number | undefined) => {
    onChange(editResidueValue(config, getCanonicalResidueKey(resKey, profiles), field, newVal, profiles));
  };

  const handleResyncSingleRow = (resKey: string) => {
    const canonicalKey = getCanonicalResidueKey(resKey, profiles);
    let pk = picks[canonicalKey];
    if (!pk || pk.cs_a == null) {
      for (const [k, p] of Object.entries(picks)) {
        if (getCanonicalResidueKey(k, profiles) === canonicalKey && p.cs_a != null) {
          pk = p;
          break;
        }
      }
    }
    if (!pk || pk.cs_a == null) return;

    const existing = config.residues?.[canonicalKey] || {};
    const now = new Date().toISOString();
    const pHash = computePickHash(pk);

    const cs_a = pk.cs_a;
    const hasBPick = pk.cs_b != null && !isNaN(pk.cs_b);

    const nextResidues = { ...config.residues };
    for (const key of Object.keys(nextResidues)) {
      if (getCanonicalResidueKey(key, profiles) === canonicalKey && key !== canonicalKey) {
        delete nextResidues[key];
      }
    }

    const updatedResEntry: ResidueParams = {
      ...existing,
      cs_a: withValue(existing.cs_a, cs_a, { kind: 'pick', pickSetHash: pHash, at: now }),
    };

    if (hasBPick) {
      const dw_ab = parseFloat((pk.cs_b! - cs_a).toFixed(3));
      updatedResEntry.dw_ab = withValue(existing.dw_ab, dw_ab, { kind: 'pick', pickSetHash: pHash, at: now });
    } else {
      // If there is No B-pick, do nothing for DW_AB / do not set DW_AB to 0.0 or CS_B to CS_A
      delete updatedResEntry.dw_ab;
    }

    nextResidues[canonicalKey] = updatedResEntry;

    onChange({
      ...config,
      residues: nextResidues,
    });
  };

  const handleToggleExclude = (resKey: string) => {
    if (onToggleExclude) {
      onToggleExclude(resKey);
      return;
    }
    onChange(toggleExcludeResidue(config, resKey, profiles));
  };

  const handleBoundEdit = (
    row: TableRowData,
    paramKey: 'cs_a' | 'dw_ab' | 'r1_a' | 'r2_a',
    side: 'lower' | 'upper',
    bound: number | undefined
  ) => {
    const existing = config.residues?.[row.resKey] || {};
    const displayed = (row[paramKey] as number | null | undefined) ?? defaults(paramKey)?.value;
    const next = withBound(existing[paramKey] ?? row.params[paramKey], side, bound, displayed);
    const entry: ResidueParams = { ...existing };
    if (next) entry[paramKey] = next;
    else delete entry[paramKey];
    onChange({ ...config, residues: { ...config.residues, [row.resKey]: entry } });
  };

  const shiftColumns = tc ? TC_COLUMNS.length : expectsBPicks ? 3 : 2;
  const columnCount = 6 + shiftColumns + 1 + (showRates ? 2 : 0);

  // ── Focus a residue (from a validation item): show it, then scroll & highlight. ──
  const [focusNonce, setFocusNonce] = useState<number | null>(null);
  if (focus && focus.nonce !== focusNonce) {
    setFocusNonce(focus.nonce);
    const target = getCanonicalResidueKey(focus.resKey, profiles);
    setSourceFilter('all');
    setSearchTerm('');
    const idx = allRows
      .slice()
      .sort((a, b) => extractResidueNumber(a.resKey) - extractResidueNumber(b.resKey) || a.resKey.localeCompare(b.resKey))
      .findIndex(r => r.resKey === target);
    setSortField('residue');
    setSortAsc(true);
    if (idx >= 0) setPage(Math.floor(idx / pageSize));
  }
  const focusKey = focus ? getCanonicalResidueKey(focus.resKey, profiles) : null;
  useEffect(() => {
    if (!focus || !focusKey) return;
    const el = document.getElementById(`param-row-${focusKey}`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focus, focusKey, page]);

  // ── Multi-select & bulk edit ──
  const visibleKeys = filteredRows.map(r => r.resKey);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every(k => selected.has(k));
  const toggleSelected = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAllVisible = () =>
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleKeys.forEach(k => next.delete(k));
      else visibleKeys.forEach(k => next.add(k));
      return next;
    });
  const applyBulk = (value: number | undefined) => {
    onChange(bulkEditResidues(config, Array.from(selected), bulkField, value, profiles));
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary Badges Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-200">
            Residue Status:
          </span>
          <button
            onClick={() => { setSourceFilter('all'); setPage(0); }}
            className={`px-2.5 py-1 rounded-md border font-semibold transition-all ${
              sourceFilter === 'all'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 border-slate-300 dark:border-slate-600 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 border-transparent hover:bg-slate-200/50'
            }`}
          >
            All ({counts.total})
          </button>
          <button
            onClick={() => { setSourceFilter('picked'); setPage(0); }}
            className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
              sourceFilter === 'picked'
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 shadow-2xs'
                : 'text-emerald-700 dark:text-emerald-400 border-transparent hover:bg-emerald-50/50'
            }`}
          >
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            {pickedLabel} ({counts.picked})
          </button>
          <button
            onClick={() => { setSourceFilter('manual'); setPage(0); }}
            className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
              sourceFilter === 'manual'
                ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700 shadow-2xs'
                : 'text-blue-600 dark:text-blue-400 border-transparent hover:bg-blue-50/50'
            }`}
          >
            <Sparkles className="w-3 h-3 text-blue-500" />
            Edited ({counts.manual})
          </button>
            <button
              onClick={() => { setSourceFilter('stale'); setPage(0); }}
              className={`px-2.5 py-1 rounded-md border font-bold transition-all flex items-center gap-1.5 ${
                sourceFilter === 'stale'
                  ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200 border-amber-400 dark:border-amber-600 shadow-2xs'
                  : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 hover:bg-amber-100/50'
              }`}
            >
              <AlertTriangle className={`w-3 h-3 text-amber-500 ${counts.stale > 0 ? 'animate-pulse' : ''}`} />
              {staleLabel} ({counts.staleAll})
            </button>
          <button
            onClick={() => { setSourceFilter('chemex_default'); setPage(0); }}
            title="Residues whose CS_A or DW_AB is not in parameters.toml, so ChemEx starts them at its default"
            className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
              sourceFilter === 'chemex_default'
                ? 'bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100 border-slate-400 dark:border-slate-500 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 border-transparent hover:bg-slate-200/50'
            }`}
          >
            ChemEx default ({counts.chemexDefault})
          </button>
          {counts.withIssues > 0 && (
            <button
              onClick={() => { setSourceFilter('issues'); setPage(0); }}
              className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
                sourceFilter === 'issues'
                  ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200 border-amber-400 dark:border-amber-600 shadow-2xs'
                  : 'text-amber-700 dark:text-amber-400 border-transparent hover:bg-amber-50/50'
              }`}
            >
              <AlertTriangle className="w-3 h-3" />
              Issues ({counts.withIssues})
            </button>
          )}
          {counts.no_b > 0 && (
            <button
              onClick={() => { setSourceFilter('no_b'); setPage(0); }}
              className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
                sourceFilter === 'no_b'
                  ? 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-700 shadow-2xs'
                  : 'text-purple-600 dark:text-purple-400 border-transparent hover:bg-purple-50/50'
              }`}
            >
              <HelpCircle className="w-3 h-3 text-purple-500" />
              No B-Pick ({counts.no_b})
            </button>
          )}
          {counts.excluded > 0 && (
            <button
              onClick={() => { setSourceFilter('excluded'); setPage(0); }}
              className={`px-2.5 py-1 rounded-md border font-semibold transition-all flex items-center gap-1.5 ${
                sourceFilter === 'excluded'
                  ? 'bg-rose-100 dark:bg-rose-900/60 text-rose-800 dark:text-rose-200 border-rose-400 dark:border-rose-600 shadow-2xs'
                  : 'text-rose-600 dark:text-rose-400 border-transparent hover:bg-rose-50/50'
              }`}
            >
              <MinusCircle className="w-3 h-3 text-rose-500" />
              Excluded ({counts.excluded})
            </button>
          )}
        </div>

        {/* Search & Filter Controls */}
        <div className="flex items-center gap-2.5">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer" title="Show R1_A / R2_A columns">
            <input type="checkbox" checked={showRates} onChange={toggleRates} />
            <span>R1_A/R2_A columns</span>
          </label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(0); }}
              placeholder="Search residue..."
              className="text-xs pl-8 pr-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-slate-800 dark:text-slate-200 w-36 sm:w-48 transition-all"
            />
          </div>
        </div>
      </div>

      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk edit"
          className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-900 dark:text-blue-200"
        >
          <span className="font-bold">{selected.size} selected</span>
          <select
            aria-label="Bulk parameter"
            value={bulkField}
            onChange={e => setBulkField(e.target.value as ResidueCell)}
            className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md font-mono text-slate-800 dark:text-slate-200"
          >
            {BULK_FIELDS.map(f => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <NumericField
            ariaLabel="Bulk value"
            value={bulkValue}
            onCommit={setBulkValue}
            placeholder={`ChemEx ${fmtDefault(defaults(bulkField)?.value)}`}
            className="w-28 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md font-mono text-slate-800 dark:text-slate-200"
          />
          <button
            type="button"
            disabled={bulkValue === undefined}
            onClick={() => applyBulk(bulkValue)}
            className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-40"
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => applyBulk(undefined)}
            className="px-2.5 py-1 rounded-md bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 font-semibold"
            title="Remove the value so ChemEx's default (or [GLOBAL]) applies"
          >
            Clear
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto underline">
            Deselect all
          </button>
        </div>
      )}

      {/* Main Table Container */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto max-h-[550px]">
          <table className="w-full text-xs text-left">
            <thead className="sticky top-0 bg-slate-100/95 dark:bg-slate-800/95 backdrop-blur-xs text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-20 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-2 py-2.5 w-8 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all visible residues"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="px-3 py-2.5 w-10 text-center"></th>
                <th
                  onClick={() => toggleSort('residue')}
                  className="px-3 py-2.5 cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Residue</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                {tc ? (
                  <>
                    {TC_COLUMNS.map(c => (
                      <th key={c.key} className="px-3 py-2.5" title={c.title}>
                        {c.label}
                      </th>
                    ))}
                  </>
                ) : (
                  <>
                <th
                  onClick={() => toggleSort('cs_a')}
                  className="px-3 py-2.5 cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  <div className="flex items-center gap-1.5">
                    <span>CS_A (ppm)</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                {expectsBPicks && (
                  <th
                    onClick={() => toggleSort('cs_b')}
                    className="px-3 py-2.5 cursor-pointer hover:text-slate-900 dark:hover:text-white"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>CS_B (ppm)</span>
                      <span className="text-[9px] font-normal text-slate-400 lowercase">(calc)</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </div>
                  </th>
                )}
                <th
                  onClick={() => toggleSort('dw_ab')}
                  className="px-3 py-2.5 cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  <div className="flex items-center gap-1.5">
                    <span title="DW_AB = CS_B − CS_A (ppm). Negative values are valid: state B is upfield of A. CPMG alone is insensitive to the sign; CEST is not.">
                      DW_AB (CS_B − CS_A, ppm)
                    </span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                  </>
                )}
                {showRates && <th className="px-3 py-2.5">R1_A (s⁻¹)</th>}
                {showRates && <th className="px-3 py-2.5">R2_A (s⁻¹)</th>}
                <th className="px-3 py-2.5">Profile</th>
                <th
                  onClick={() => toggleSort('source')}
                  className="px-3 py-2.5 cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Provenance</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="px-3 py-2.5">Method Step</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-150 dark:divide-slate-800">
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="py-12 text-center text-slate-400 text-xs">
                    No residues found matching the current filter.
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const isExpanded = expandedRow === row.resKey;
                  return (
                    <React.Fragment key={row.resKey}>
                      <tr
                        id={`param-row-${row.resKey}`}
                        className={`group hover:bg-blue-50/40 dark:hover:bg-blue-900/10 transition-colors ${
                          focusKey === row.resKey ? 'ring-2 ring-inset ring-amber-400 dark:ring-amber-500 ' : ''
                        }${
                          row.isExcluded
                            ? 'opacity-60 bg-slate-100/60 dark:bg-slate-950/40'
                            : row.isStale
                            ? 'bg-amber-50/30 dark:bg-amber-950/20'
                            : row.hasNoBPick
                            ? 'bg-purple-50/20 dark:bg-purple-950/10'
                            : ''
                        }`}
                      >
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.label}`}
                            checked={selected.has(row.resKey)}
                            onChange={() => toggleSelected(row.resKey)}
                          />
                        </td>
                        {/* Expand toggle */}
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => setExpandedRow(isExpanded ? null : row.resKey)}
                            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                            title={isExpanded ? 'Collapse row' : 'Expand row details'}
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-blue-500" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </td>

                        {/* Residue Label */}
                        <td className="px-3 py-2 font-bold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          <span className={row.isExcluded ? 'line-through text-slate-400 dark:text-slate-500' : ''}>
                            {row.label}
                          </span>
                          {(() => {
                            const rowIssues = issuesFor(row.resKey);
                            return rowIssues.length > 0 ? (
                              <span
                                className="ml-1.5 inline-flex items-center gap-0.5 px-1 rounded text-[9px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                                title={rowIssues.map(i => `${i.paramKey ? `(${i.paramKey}) ` : ''}${i.message}`).join('\n')}
                                aria-label={`${rowIssues.length} validation issue${rowIssues.length === 1 ? '' : 's'}`}
                              >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {rowIssues.length}
                              </span>
                            ) : null;
                          })()}
                        </td>

                        {tc ? (
                          <>
                            {TC_COLUMNS.map(c => (
                              <td key={c.key} className="px-3 py-2">
                                <NumericField
                                  ariaLabel={`${c.label} for ${row.label}`}
                                  value={row.params[c.key]?.value}
                                  onCommit={v => handleCellEdit(row.resKey, c.key, v)}
                                  placeholder={`ChemEx ${fmtDefault(defaults(c.key)?.value)}`}
                                  className="w-24 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-800 dark:text-slate-200"
                                />
                                {c.key === 'dw0_ab' && (() => {
                                  const d = tcDerived(row.params, tc.tref, tc.temperatureC);
                                  return (
                                    <div className="text-[9px] text-slate-400 mt-0.5" title={`Derived by ChemEx at ${tc.temperatureC} °C (TREF ${tc.tref} °C)`}>
                                      @{fmtDefault(tc.temperatureC)} °C: CS_A {d.cs_a === null ? '—' : d.cs_a.toFixed(3)} · DW_AB {d.dw_ab === null ? '—' : d.dw_ab.toFixed(3)}
                                    </div>
                                  );
                                })()}
                              </td>
                            ))}
                          </>
                        ) : (
                          <>
                        {/* CS_A Input */}
                        <td className="px-3 py-2">
                          <NumericField
                            ariaLabel={`CS_A for ${row.label}`}
                            value={row.cfgCsA}
                            onCommit={v => handleCellEdit(row.resKey, 'cs_a', v)}
                            className="w-24 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-800 dark:text-slate-200 focus:ring-1 focus:ring-blue-500 placeholder:text-amber-500/80"
                            placeholder={`ChemEx ${fmtDefault(defaults('cs_a')?.value)}`}
                            title={row.cfgCsA == null ? `Not in parameters.toml: ChemEx starts CS_A at ${fmtDefault(defaults('cs_a')?.value)} ppm` : undefined}
                          />
                          {row.cfgCsA == null && row.pickCsA != null && (
                            <div className="text-[9px] text-slate-400 mt-0.5" title={`A ${pickNoun} exists but is not applied; use re-sync to write it`}>
                              {pickNoun} {row.pickCsA.toFixed(3)} · not applied
                            </div>
                          )}
                        </td>

                        {/* CS_B Input (Computed display helper: dw_ab = cs_b - cs_a) */}
                        {expectsBPicks && <td className="px-3 py-2">
                          <NumericField
                            ariaLabel={`CS_B for ${row.label}`}
                            value={row.cfgCsA != null && row.cfgDw != null ? parseFloat((row.cfgCsA + row.cfgDw).toFixed(3)) : null}
                            onCommit={v => handleCellEdit(row.resKey, 'cs_b', v)}
                            disabled={row.cfgCsA == null}
                            className="w-24 px-2 py-1 bg-slate-50 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-700 dark:text-slate-300 focus:ring-1 focus:ring-blue-500"
                            placeholder="—"
                            title={row.cfgCsA == null ? 'Set CS_A first: CS_B is derived as CS_A + DW_AB' : 'Editing CS_B updates DW_AB = CS_B − CS_A'}
                          />
                        </td>}

                        {/* DW_AB Input */}
                        <td className="px-3 py-2">
                          <NumericField
                            ariaLabel={`DW_AB for ${row.label}`}
                            value={row.params.dw_ab?.value}
                            onCommit={v => handleCellEdit(row.resKey, 'dw_ab', v)}
                            title={
                              row.params.dw_ab
                                ? undefined
                                : config.globals?.dw_ab
                                  ? `Not set for this residue: starts from [GLOBAL] DW_AB = ${fmtDefault(config.globals.dw_ab.value)} ppm`
                                  : `Not in parameters.toml: ChemEx starts DW_AB at ${fmtDefault(defaults('dw_ab')?.value)} ppm`
                            }
                            className={`w-24 px-2 py-1 bg-white dark:bg-slate-950 border rounded text-xs font-mono font-semibold focus:ring-1 focus:ring-blue-500 ${
                              row.dw_ab != null && Math.abs(row.dw_ab) > maxDwWarn
                                ? 'border-amber-400 text-amber-700 dark:text-amber-300'
                                : 'border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200'
                            }`}
                            placeholder={config.globals?.dw_ab ? `[GLOBAL] ${fmtDefault(config.globals.dw_ab.value)}` : `ChemEx ${fmtDefault(defaults('dw_ab')?.value)}`}
                          />
                          {!row.params.dw_ab && row.pickDw != null && (
                            <div className="text-[9px] text-slate-400 mt-0.5">{pickNoun} {row.pickDw.toFixed(3)} · not applied</div>
                          )}
                        </td>

                          </>
                        )}

                        {showRates &&
                          (['r1_a', 'r2_a'] as const).map(k => (
                            <td key={k} className="px-3 py-2">
                              <NumericField
                                ariaLabel={`${k.toUpperCase()} column for ${row.label}`}
                                value={row.params[k]?.value}
                                onCommit={v => handleCellEdit(row.resKey, k, v)}
                                placeholder={config.globals?.[k] ? `[GLOBAL] ${fmtDefault(config.globals[k].value)}` : `ChemEx ${fmtDefault(defaults(k)?.value)}`}
                                className="w-20 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-800 dark:text-slate-200"
                              />
                            </td>
                          ))}

                        {/* Profile Thumbnail */}
                        <td className="px-3 py-2">
                          <div className="inline-block">{renderProfile(row, 'thumb')}</div>
                        </td>

                        {/* Provenance Badge */}
                        <td className="px-3 py-2">
                          <ParameterBadge
                            source={row.sourceCsA}
                            isStale={row.isStale}
                            hasNoBPick={row.hasNoBPick}
                            isExcluded={row.isExcluded}
                            chemexDefault={defaults('cs_a')?.value}
                            unit="ppm"
                          />
                        </td>

                        {/* Treatment in Methods */}
                        <td className="px-3 py-2">
                          {row.methodTreatment ? (
                            <button
                              type="button"
                              onClick={onNavigateToMethods}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-all ${
                                row.methodTreatment === 'Fit'
                                  ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
                                  : row.methodTreatment === 'Fixed'
                                  ? 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                                  : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800'
                              }`}
                              title={`Treatment in Method "${activeStep?.name || 'Current'}": ${row.methodTreatment}. Click to view in Methods tab.`}
                            >
                              <span>{row.methodTreatment}</span>
                              <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400">—</span>
                          )}
                        </td>

                        {/* Row Actions */}
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {row.hasPick && (
                              <button
                                type="button"
                                onClick={() => handleResyncSingleRow(row.resKey)}
                                className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-colors"
                                title={`Re-sync this row from its ${pickNoun}`}
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleToggleExclude(row.resKey)}
                              className={`p-1 rounded transition-colors ${
                                row.isExcluded
                                  ? 'text-rose-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                                  : 'text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                              }`}
                              title={
                                row.isExcluded
                                  ? 'Include this residue again (its profile returns to the experiment files)'
                                  : 'Exclude this residue (its profile is left out of the experiment files)'
                              }
                            >
                              {row.isExcluded ? (
                                <PlusCircle className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <MinusCircle className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded Row View */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70 dark:bg-slate-850/70 border-b border-slate-200 dark:border-slate-800">
                          <td colSpan={columnCount} className="p-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              {/* Enlarged Profile Preview */}
                              <div className="md:col-span-2 bg-slate-900 p-3 rounded-xl border border-slate-700 flex flex-col justify-between">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-xs font-bold text-white flex items-center gap-2">
                                    <span>{profileTitle}: {row.label}</span>
                                    <span className="text-[10px] font-normal text-slate-400">
                                      (A: {row.cs_a?.toFixed(3) || '—'} ppm{expectsBPicks && <> | B: {row.cs_b?.toFixed(3) || '—'} ppm</>} | Δω: {row.dw_ab?.toFixed(3) || '—'} ppm)
                                    </span>
                                  </span>
                                  {row.dw_ab != null ? (
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800">
                                      Sign: {row.dw_ab < 0 ? 'Negative (Upfield)' : 'Positive (Downfield)'}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                                      {expectsBPicks ? 'No B-Pick' : 'No Δω'}
                                    </span>
                                  )}
                                </div>
                                {renderProfile(row, 'large')}
                              </div>

                              {/* Additional Parameters (R1, R2, etc.) */}
                              <div className="space-y-3 p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
                                <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                  Relaxation Rates (Optional)
                                </h5>
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                                      R1_A (s⁻¹)
                                    </label>
                                    <NumericField
                                      ariaLabel={`R1_A for ${row.label}`}
                                      value={row.r1_a}
                                      onCommit={v => handleCellEdit(row.resKey, 'r1_a', v)}
                                      className="w-full px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono"
                                      placeholder={`ChemEx ${fmtDefault(defaults('r1_a')?.value)}`}
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                                      R2_A (s⁻¹)
                                    </label>
                                    <NumericField
                                      ariaLabel={`R2_A for ${row.label}`}
                                      value={row.r2_a}
                                      onCommit={v => handleCellEdit(row.resKey, 'r2_a', v)}
                                      className="w-full px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono"
                                      placeholder={`ChemEx ${fmtDefault(defaults('r2_a')?.value)}`}
                                    />
                                  </div>
                                </div>

                                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                                  <h6 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400" title="ChemEx [init, lower, upper]: explicit bounds replace ChemEx's default bounds (and the MCMC prior support)">
                                    Bounds
                                  </h6>
                                  {BOUND_PARAMS.map(({ key, label }) => {
                                    const pv = row.params[key];
                                    const def = defaults(key);
                                    return (
                                      <div key={key} className="grid grid-cols-[3.5rem_1fr_1fr] items-center gap-1.5">
                                        <span className="text-[10px] font-semibold text-slate-500">{label}</span>
                                        <NumericField
                                          ariaLabel={`${label} lower bound for ${row.label}`}
                                          value={pv?.lower}
                                          onCommit={v => handleBoundEdit(row, key, 'lower', v)}
                                          placeholder={fmtDefault(def?.lower)}
                                          title={`Lower bound (ChemEx default ${fmtDefault(def?.lower)})`}
                                          className="w-full px-1.5 py-0.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-[11px] font-mono text-slate-800 dark:text-slate-200"
                                        />
                                        <NumericField
                                          ariaLabel={`${label} upper bound for ${row.label}`}
                                          value={pv?.upper}
                                          onCommit={v => handleBoundEdit(row, key, 'upper', v)}
                                          placeholder={fmtDefault(def?.upper)}
                                          title={`Upper bound (ChemEx default ${fmtDefault(def?.upper)})`}
                                          className="w-full px-1.5 py-0.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-[11px] font-mono text-slate-800 dark:text-slate-200"
                                        />
                                      </div>
                                    );
                                  })}
                                </div>

                                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400">
                                  <span>CS_A source: {row.sourceCsA?.kind ?? 'ChemEx default'}</span>
                                  {row.sourceCsA && 'at' in row.sourceCsA && (
                                    <span className="block text-[9px] text-slate-400">
                                      Modified: {new Date(row.sourceCsA.at).toLocaleString()}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {filteredRows.length > pageSize && (
          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs text-slate-500">
            <div>
              Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filteredRows.length)} of {filteredRows.length} residues
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                className="px-2.5 py-1 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded disabled:opacity-40 font-semibold"
              >
                Prev
              </button>
              <span className="px-2">
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
                className="px-2.5 py-1 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded disabled:opacity-40 font-semibold"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
