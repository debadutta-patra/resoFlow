import React, { useState, useMemo } from 'react';
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
} from '../../lib/parameterConfig';
import { fallbackDefaults, fmtDefault, type ParamDefaultsLookup } from '../../lib/chemexDefaults';
import { NumericField } from './NumericField';
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
}

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

export type FilterSource = 'all' | 'picked' | 'manual' | 'stale' | 'no_b' | 'imported' | 'excluded';
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
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sourceFilter, setSourceFilter] = useState<FilterSource>('all');
  const [sortField, setSortField] = useState<SortField>('residue');
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

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

  // Method treatment for active step
  const activeStep = methodConfig?.steps?.[activeStepIdx];
  const methodTreatmentMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (!activeStep) return map;

    const fitNames = activeStep.parameters.filter(p => p.mode === 'fit').map(p => p.name.toUpperCase());
    const fixNames = activeStep.parameters.filter(p => p.mode === 'fix').map(p => p.name.toUpperCase());

    const isFit = fitNames.includes('CS_A') || fitNames.includes('DW_AB');
    const isFix = fixNames.includes('CS_A') && fixNames.includes('DW_AB');

    const excludedSet = new Set(
      activeStep.residueMode === 'exclude' ? (activeStep.residues || []) : []
    );
    const includedSet = new Set(
      activeStep.residueMode === 'include' ? (activeStep.residues || []) : []
    );

    const allRes = Object.keys(config.residues || {});
    for (const res of allRes) {
      if (excludedSet.has(res)) {
        map[res] = 'Excluded';
      } else if (activeStep.residueMode === 'include' && includedSet.size > 0 && !includedSet.has(res)) {
        map[res] = 'Excluded';
      } else if (isFit) {
        map[res] = 'Fit';
      } else if (isFix) {
        map[res] = 'Fixed';
      } else {
        map[res] = 'Active';
      }
    }
    return map;
  }, [activeStep, config.residues]);

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
        sourceCsA: rParams.cs_a?.source || (hasPick ? { kind: 'default' } : undefined),
        sourceDw: rParams.dw_ab?.source || (hasPick ? { kind: 'default' } : undefined),
        isStale,
        hasNoBPick,
        hasPick,
        isExcluded,
        methodTreatment,
        profile: prof,
        params: rParams,
      };
    });
  }, [config.residues, config.excludedResidues, picks, profiles, profileMap, methodTreatmentMap, expectsBPicks]);

  // Aggregate Counts for Summary Header
  const counts = useMemo(() => {
    let picked = 0;
    let manual = 0;
    let stale = 0;
    let no_b = 0;
    let imported = 0;
    let excluded = 0;

    for (const r of allRows) {
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
    };
  }, [allRows]);

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
  }, [allRows, searchTerm, sourceFilter, sortField, sortAsc]);

  // Paginated slice
  const paginatedRows = useMemo(() => {
    const start = page * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const totalPages = Math.ceil(filteredRows.length / pageSize);

  // Cell Edit Handlers
  const handleCellEdit = (
    resKey: string,
    field: 'cs_a' | 'cs_b' | 'dw_ab',
    newVal: number
  ) => {
    const canonicalKey = getCanonicalResidueKey(resKey, profiles);
    const existing = config.residues?.[canonicalKey] || {};
    const now = new Date().toISOString();

    const currentCsA = existing.cs_a?.value ?? allRows.find(r => r.resKey === canonicalKey)?.cs_a ?? 0;
    const currentDw = existing.dw_ab?.value ?? allRows.find(r => r.resKey === canonicalKey)?.dw_ab ?? null;

    let updatedCsA = currentCsA;
    let updatedDw = currentDw;

    if (field === 'cs_a') {
      updatedCsA = newVal;
      // If dw was present, keep cs_b unchanged: dw_ab = cs_b - cs_a
      if (currentDw !== null) {
        const cs_b = currentCsA + currentDw;
        updatedDw = parseFloat((cs_b - updatedCsA).toFixed(3));
      }
    } else if (field === 'cs_b') {
      // dw_ab recomputes: dw_ab = cs_b - cs_a
      updatedDw = parseFloat((newVal - currentCsA).toFixed(3));
    } else if (field === 'dw_ab') {
      updatedDw = newVal;
    }

    // Clean up any duplicate alias keys for this physical residue
    const nextResidues = { ...config.residues };
    for (const key of Object.keys(nextResidues)) {
      if (getCanonicalResidueKey(key, profiles) === canonicalKey && key !== canonicalKey) {
        delete nextResidues[key];
      }
    }

    const updatedResEntry: ResidueParams = {
      ...existing,
      cs_a: withValue(existing.cs_a, updatedCsA, { kind: 'manual', at: now }),
    };

    if (updatedDw !== null) {
      updatedResEntry.dw_ab = withValue(existing.dw_ab, updatedDw, { kind: 'manual', at: now });
    }

    nextResidues[canonicalKey] = updatedResEntry;

    onChange({
      ...config,
      residues: nextResidues,
    });
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

  const columnCount = expectsBPicks ? 9 : 8;

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
          {counts.stale > 0 && (
            <button
              onClick={() => { setSourceFilter('stale'); setPage(0); }}
              className={`px-2.5 py-1 rounded-md border font-bold transition-all flex items-center gap-1.5 ${
                sourceFilter === 'stale'
                  ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200 border-amber-400 dark:border-amber-600 shadow-2xs'
                  : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 hover:bg-amber-100/50'
              }`}
            >
              <AlertTriangle className="w-3 h-3 text-amber-500 animate-pulse" />
              {staleLabel} ({counts.stale})
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

      {/* Main Table Container */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto max-h-[550px]">
          <table className="w-full text-xs text-left">
            <thead className="sticky top-0 bg-slate-100/95 dark:bg-slate-800/95 backdrop-blur-xs text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-20 border-b border-slate-200 dark:border-slate-700">
              <tr>
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
                    <span>Δω_AB (ppm)</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
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
                        className={`group hover:bg-blue-50/40 dark:hover:bg-blue-900/10 transition-colors ${
                          row.isExcluded
                            ? 'opacity-60 bg-slate-100/60 dark:bg-slate-950/40'
                            : row.isStale
                            ? 'bg-amber-50/30 dark:bg-amber-950/20'
                            : row.hasNoBPick
                            ? 'bg-purple-50/20 dark:bg-purple-950/10'
                            : ''
                        }`}
                      >
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
                        </td>

                        {/* CS_A Input */}
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.001"
                            value={row.cs_a != null && !isNaN(row.cs_a) ? row.cs_a : ''}
                            onChange={(e) =>
                              handleCellEdit(row.resKey, 'cs_a', parseFloat(e.target.value) || 0)
                            }
                            className="w-24 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-800 dark:text-slate-200 focus:ring-1 focus:ring-blue-500"
                            placeholder="—"
                          />
                        </td>

                        {/* CS_B Input (Computed display helper: dw_ab = cs_b - cs_a) */}
                        {expectsBPicks && <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.001"
                            value={row.cs_b != null && !isNaN(row.cs_b) ? row.cs_b : ''}
                            onChange={(e) =>
                              handleCellEdit(row.resKey, 'cs_b', parseFloat(e.target.value) || 0)
                            }
                            className="w-24 px-2 py-1 bg-slate-50 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-700 dark:text-slate-300 focus:ring-1 focus:ring-blue-500"
                            placeholder="—"
                            title="Editing CS_B updates Δω_AB = CS_B - CS_A"
                          />
                        </td>}

                        {/* DW_AB Input */}
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.001"
                            value={row.dw_ab != null && !isNaN(row.dw_ab) ? row.dw_ab : ''}
                            onChange={(e) =>
                              handleCellEdit(row.resKey, 'dw_ab', parseFloat(e.target.value) || 0)
                            }
                            className={`w-24 px-2 py-1 bg-white dark:bg-slate-950 border rounded text-xs font-mono font-semibold focus:ring-1 focus:ring-blue-500 ${
                              row.dw_ab != null && Math.abs(row.dw_ab) > 6.0
                                ? 'border-amber-400 text-amber-700 dark:text-amber-300'
                                : 'border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200'
                            }`}
                            placeholder="—"
                          />
                        </td>

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
                                  ? 'Include this residue (uncomment in parameter file)'
                                  : 'Exclude this residue (comment out in parameter file)'
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
                                    <input
                                      type="number"
                                      step="0.01"
                                      value={row.r1_a ?? ''}
                                      onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        const existing = config.residues?.[row.resKey] || {};
                                        onChange({
                                          ...config,
                                          residues: {
                                            ...config.residues,
                                            [row.resKey]: {
                                              ...existing,
                                              r1_a: isNaN(val)
                                                ? undefined
                                                : withValue(existing.r1_a, val, { kind: 'manual', at: new Date().toISOString() }),
                                            },
                                          },
                                        });
                                      }}
                                      className="w-full px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono"
                                      placeholder="Auto / Fit"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                                      R2_A (s⁻¹)
                                    </label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={row.r2_a ?? ''}
                                      onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        const existing = config.residues?.[row.resKey] || {};
                                        onChange({
                                          ...config,
                                          residues: {
                                            ...config.residues,
                                            [row.resKey]: {
                                              ...existing,
                                              r2_a: isNaN(val)
                                                ? undefined
                                                : withValue(existing.r2_a, val, { kind: 'manual', at: new Date().toISOString() }),
                                            },
                                          },
                                        });
                                      }}
                                      className="w-full px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono"
                                      placeholder="Auto / Fit"
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
                                  <span>CS_A source: {row.sourceCsA?.kind || 'default'}</span>
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
