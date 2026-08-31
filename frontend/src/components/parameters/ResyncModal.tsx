import React, { useState, useMemo } from 'react';
import {
  RefreshCw,
  X,
  CheckSquare,
  Square,
  PlusCircle,
  MinusCircle,
  Edit3,
  CheckCircle2,
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
} from '../../lib/parameterConfig';
import { ParameterBadge } from './ParameterBadge';

export interface ResyncItem {
  residue: string;
  displayLabel?: string;
  paramKey: 'cs_a' | 'dw_ab';
  oldValue: number | undefined;
  newValue: number | null;
  oldSource?: any;
  status: 'added' | 'changed' | 'removed' | 'unchanged';
  isManual: boolean;
  selected: boolean;
}

interface ResyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ParameterConfig;
  picks: Record<string, PickSetData>;
  profiles?: ProfileRef[];
  residueLabels?: Record<string, string>;
  onApply: (updatedConfig: ParameterConfig) => void;
}

export const ResyncModal: React.FC<ResyncModalProps> = ({
  isOpen,
  onClose,
  config,
  picks,
  profiles = [],
  residueLabels = {},
  onApply,
}) => {
  if (!isOpen) return null;

  // Build diff list between config.residues and current picks (canonicalized)
  const initialDiffItems = useMemo<ResyncItem[]>(() => {
    const items: ResyncItem[] = [];

    // Map of canonicalKey -> { canonicalKey, aliases, label }
    const canonicalMap = new Map<string, {
      canonicalKey: string;
      aliases: string[];
      label: string;
    }>();

    // 1. Profiles
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
        aliases,
        label: residueLabels[canonical] || p.full_residue || normalizeResidueKey(canonical) || canonical,
      });
    }

    // 2. Config residues
    for (const res of Object.keys(config.residues || {})) {
      const canonical = getCanonicalResidueKey(res, profiles);
      if (!canonicalMap.has(canonical)) {
        canonicalMap.set(canonical, {
          canonicalKey: canonical,
          aliases: [res, canonical, normalizeResidueKey(res)],
          label: residueLabels[res] || normalizeResidueKey(res) || res,
        });
      } else {
        const entry = canonicalMap.get(canonical)!;
        if (!entry.aliases.includes(res)) entry.aliases.push(res);
      }
    }

    // 3. Picks
    for (const res of Object.keys(picks || {})) {
      const canonical = getCanonicalResidueKey(res, profiles);
      if (!canonicalMap.has(canonical)) {
        canonicalMap.set(canonical, {
          canonicalKey: canonical,
          aliases: [res, canonical, normalizeResidueKey(res)],
          label: residueLabels[res] || normalizeResidueKey(res) || res,
        });
      } else {
        const entry = canonicalMap.get(canonical)!;
        if (!entry.aliases.includes(res)) entry.aliases.push(res);
      }
    }

    const sortedEntries = Array.from(canonicalMap.values()).sort((a, b) => {
      const numA = extractResidueNumber(a.canonicalKey);
      const numB = extractResidueNumber(b.canonicalKey);
      return numA !== numB ? numA - numB : a.canonicalKey.localeCompare(b.canonicalKey);
    });

    for (const { canonicalKey, aliases, label } of sortedEntries) {
      // Find rConfig among aliases
      let rConfig: ResidueParams = config.residues[canonicalKey] || {};
      if (!rConfig.cs_a && !rConfig.dw_ab) {
        for (const alias of aliases) {
          if (config.residues[alias]?.cs_a || config.residues[alias]?.dw_ab) {
            rConfig = { ...config.residues[alias], ...rConfig };
          }
        }
      }

      // Find pick among aliases
      let pk: PickSetData | undefined = picks[canonicalKey];
      if (!pk || pk.cs_a == null) {
        for (const alias of aliases) {
          if (picks[alias]?.cs_a != null) {
            pk = picks[alias];
            break;
          }
        }
      }

      // 1. CS_A
      const oldCsA = rConfig.cs_a?.value;
      const newCsA = pk?.cs_a != null && !isNaN(pk.cs_a) ? pk.cs_a : null;
      const sourceCsA = rConfig.cs_a?.source;
      const isManualCsA = sourceCsA?.kind === 'manual';

      let statusCsA: ResyncItem['status'] = 'unchanged';
      if (oldCsA === undefined && newCsA !== null) {
        statusCsA = 'added';
      } else if (oldCsA !== undefined && newCsA === null) {
        statusCsA = 'removed';
      } else if (oldCsA !== undefined && newCsA !== null && Math.abs(oldCsA - newCsA) > 1e-4) {
        statusCsA = 'changed';
      }

      items.push({
        residue: canonicalKey,
        displayLabel: label,
        paramKey: 'cs_a',
        oldValue: oldCsA,
        newValue: newCsA,
        oldSource: sourceCsA,
        status: statusCsA,
        isManual: isManualCsA,
        selected: statusCsA !== 'unchanged' && !isManualCsA,
      });

      // 2. DW_AB
      const oldDw = rConfig.dw_ab?.value;
      const hasBPick = pk?.cs_b != null && !isNaN(pk.cs_b);
      let newDw: number | null = null;
      if (newCsA !== null && hasBPick) {
        newDw = pk!.cs_b! - newCsA;
      }
      const sourceDw = rConfig.dw_ab?.source;
      const isManualDw = sourceDw?.kind === 'manual';

      let statusDw: ResyncItem['status'] = 'unchanged';
      if (hasBPick) {
        if (oldDw === undefined && newDw !== null) {
          statusDw = 'added';
        } else if (oldDw !== undefined && newDw === null) {
          statusDw = 'removed';
        } else if (oldDw !== undefined && newDw !== null && Math.abs(oldDw - newDw) > 1e-4) {
          statusDw = 'changed';
        }
      } else {
        // No B-pick: do not invent a DW_AB = 0.0 or force CS_B = CS_A
        statusDw = 'unchanged';
      }

      items.push({
        residue: canonicalKey,
        displayLabel: label,
        paramKey: 'dw_ab',
        oldValue: oldDw,
        newValue: newDw,
        oldSource: sourceDw,
        status: statusDw,
        isManual: isManualDw,
        selected: statusDw !== 'unchanged' && !isManualDw,
      });
    }

    return items;
  }, [config, picks, profiles, residueLabels]);

  const [diffItems, setDiffItems] = useState<ResyncItem[]>(initialDiffItems);
  const [filterChangedOnly, setFilterChangedOnly] = useState(true);

  const toggleSelect = (idx: number) => {
    setDiffItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], selected: !next[idx].selected };
      return next;
    });
  };

  const handleSelectAll = (select: boolean) => {
    setDiffItems((prev) =>
      prev.map((item) =>
        filterChangedOnly && item.status === 'unchanged'
          ? item
          : { ...item, selected: select }
      )
    );
  };

  const handleResetToSafe = () => {
    setDiffItems((prev) =>
      prev.map((item) => ({
        ...item,
        selected: item.status !== 'unchanged' && !item.isManual,
      }))
    );
  };

  const selectedCount = diffItems.filter((i) => i.selected).length;
  const changedCount = diffItems.filter((i) => i.status !== 'unchanged').length;
  const manualChangedCount = diffItems.filter(
    (i) => i.status !== 'unchanged' && i.isManual
  ).length;

  const handleConfirm = () => {
    const updatedResidues = { ...config.residues };
    const now = new Date().toISOString();

    for (const item of diffItems) {
      if (!item.selected) continue;

      const canonicalKey = getCanonicalResidueKey(item.residue, profiles);

      // Clean up any duplicate alias keys
      for (const key of Object.keys(updatedResidues)) {
        if (getCanonicalResidueKey(key, profiles) === canonicalKey && key !== canonicalKey) {
          delete updatedResidues[key];
        }
      }

      if (!updatedResidues[canonicalKey]) {
        updatedResidues[canonicalKey] = {};
      }

      if (item.newValue === null) {
        // Removed
        delete updatedResidues[canonicalKey][item.paramKey];
      } else {
        // Find pick
        let pk = picks[canonicalKey];
        if (!pk || pk.cs_a == null) {
          for (const [k, p] of Object.entries(picks)) {
            if (getCanonicalResidueKey(k, profiles) === canonicalKey && p.cs_a != null) {
              pk = p;
              break;
            }
          }
        }
        const pHash = computePickHash(pk);
        updatedResidues[canonicalKey][item.paramKey] = {
          value: parseFloat(item.newValue.toFixed(3)),
          source: { kind: 'pick', pickSetHash: pHash, at: now },
        };
      }
    }

    onApply({
      ...config,
      residues: updatedResidues,
    });
    onClose();
  };

  const displayedItems = filterChangedOnly
    ? diffItems.filter((i) => i.status !== 'unchanged')
    : diffItems;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
              <RefreshCw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Re-sync Parameters from Picks
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Review differences before updating. Manual edits are protected by default.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Summary Info Bar */}
        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {changedCount} total change{changedCount === 1 ? '' : 's'}
            </span>
            {manualChangedCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 font-bold flex items-center gap-1">
                <Edit3 className="w-3 h-3" />
                {manualChangedCount} manual edit{manualChangedCount === 1 ? '' : 's'} (unchecked)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSelectAll(true)}
              className="px-2.5 py-1 text-[11px] font-semibold bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
            >
              Select All
            </button>
            <button
              onClick={handleResetToSafe}
              className="px-2.5 py-1 text-[11px] font-semibold bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors text-blue-600 dark:text-blue-400"
            >
              Reset to Safe Default
            </button>
            <button
              onClick={() => handleSelectAll(false)}
              className="px-2.5 py-1 text-[11px] font-semibold bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
            >
              Deselect All
            </button>
          </div>
        </div>

        {/* Diff Table */}
        <div className="flex-1 overflow-y-auto p-4">
          {displayedItems.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500 mb-2" />
              All parameters are in sync with your current picks!
            </div>
          ) : (
            <table className="w-full text-xs text-left">
              <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-10">
                <tr>
                  <th className="px-3 py-2 w-10 text-center">Sync</th>
                  <th className="px-3 py-2">Residue</th>
                  <th className="px-3 py-2">Parameter</th>
                  <th className="px-3 py-2">Current Value</th>
                  <th className="px-3 py-2">Current Source</th>
                  <th className="px-3 py-2">New Pick Value</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {displayedItems.map((item) => {
                  const globalIdx = diffItems.indexOf(item);
                  return (
                    <tr
                      key={`${item.residue}-${item.paramKey}`}
                      onClick={() => toggleSelect(globalIdx)}
                      className={`cursor-pointer hover:bg-blue-50/40 dark:hover:bg-blue-900/20 transition-colors ${
                        item.selected
                          ? 'bg-blue-50/20 dark:bg-blue-900/10'
                          : item.isManual
                          ? 'bg-amber-50/30 dark:bg-amber-900/10'
                          : ''
                      }`}
                    >
                      <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => toggleSelect(globalIdx)}
                          className="text-blue-600 dark:text-blue-400 focus:outline-hidden"
                        >
                          {item.selected ? (
                            <CheckSquare className="w-4 h-4" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2 font-bold text-slate-800 dark:text-slate-200">
                        {item.displayLabel || residueLabels[item.residue] || item.residue}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold text-blue-600 dark:text-blue-400 uppercase">
                        {item.paramKey}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600 dark:text-slate-300">
                        {item.oldValue != null ? item.oldValue.toFixed(3) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <ParameterBadge source={item.oldSource} compact />
                      </td>
                      <td className="px-3 py-2 font-mono font-bold text-slate-900 dark:text-white">
                        {item.newValue != null ? item.newValue.toFixed(3) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {item.status === 'added' && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 font-bold">
                            <PlusCircle className="w-3 h-3" /> Added
                          </span>
                        )}
                        {item.status === 'removed' && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-rose-600 font-bold">
                            <MinusCircle className="w-3 h-3" /> Removed
                          </span>
                        )}
                        {item.status === 'changed' && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 font-bold">
                            <RefreshCw className="w-3 h-3" /> Changed
                          </span>
                        )}
                        {item.status === 'unchanged' && (
                          <span className="text-[10px] text-slate-400">Unchanged</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filterChangedOnly}
              onChange={(e) => setFilterChangedOnly(e.target.checked)}
              className="w-3.5 h-3.5 accent-blue-600 rounded"
            />
            Show only changed residues
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedCount === 0}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm disabled:opacity-50 transition-all flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Apply Selected ({selectedCount})</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
