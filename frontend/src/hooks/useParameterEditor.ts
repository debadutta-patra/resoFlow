/**
 * Shared Parameters-tab state for every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * All pages use the same `ParameterConfig` model. The only per-experiment piece is the
 * TOML codec (CPMG canonicalizes residue keys) and the optional legacy migration, both
 * supplied by the experiment plugin. State lives in the manager so raw edits, unparsed
 * lines and validation survive tab switches.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ParameterConfig, PickSetData, ProfileRef } from '../lib/parameterConfig';
import {
  canonicalizeParameterConfig,
  dropLegacyDefaultGlobals,
  isResidueExcluded,
  staleResidueKeys,
  startingValuesFromGlobals,
  toggleExcludeResidue,
} from '../lib/parameterConfig';
import { DEFAULT_PARAMETER_CODEC, type ParameterCodec } from '../lib/parameterToml';
import { defaultsLookupFromCatalog, type CatalogDefaultsRow } from '../lib/chemexDefaults';

export type { ParameterCodec };

export interface SavedParameterState {
  parameter_config?: (ParameterConfig & { rawOverride?: string }) | null;
  parameter_toml?: string | null;
}

export interface UseParameterEditorOptions {
  createDefault: () => ParameterConfig;
  codec?: ParameterCodec;
  profiles: ProfileRef[];
  picks: Record<string, PickSetData>;
}

export function useParameterEditor(opts: UseParameterEditorOptions) {
  const { createDefault, profiles, picks } = opts;
  const codec = opts.codec ?? DEFAULT_PARAMETER_CODEC;

  const [parameterConfig, setParameterConfig] = useState<ParameterConfig>(createDefault);
  const [rawParamToml, setRawParamToml] = useState('');
  const [isRawParamEditMode, setIsRawParamEditMode] = useState(false);
  const [unparsedParamTomlLines, setUnparsedParamTomlLines] = useState<string[]>([]);
  // ChemEx default values/bounds for the current model (backend catalogue; static table until loaded).
  const [catalog, setCatalog] = useState<CatalogDefaultsRow[] | null>(null);
  // One-time notices about migrations applied while loading a saved config.
  const [notices, setNotices] = useState<string[]>([]);
  const dismissNotices = useCallback(() => setNotices([]), []);
  const defaults = useMemo(() => defaultsLookupFromCatalog(catalog), [catalog]);
  const toToml = useCallback((cfg: ParameterConfig) => codec.toToml(cfg, { defaults }), [codec, defaults]);

  // ── Raw TOML mode ──
  const enterRawMode = () => {
    setRawParamToml(toToml(parameterConfig));
    setIsRawParamEditMode(true);
  };
  const toggleRawMode = () => (isRawParamEditMode ? setIsRawParamEditMode(false) : enterRawMode());
  const applyRawToml = () => {
    const parsed = codec.fromToml(rawParamToml);
    setParameterConfig(canonicalizeParameterConfig(parsed.config, profiles));
    setUnparsedParamTomlLines(parsed.unparsed);
    setIsRawParamEditMode(false);
  };
  const discardRawToml = () => {
    setRawParamToml(toToml(parameterConfig));
    setIsRawParamEditMode(false);
  };

  /** Replace the whole config (import, inherit, re-sync, grid apply). Leaves raw mode. */
  const replaceConfig = useCallback(
    (next: ParameterConfig, unparsed?: string[]) => {
      setParameterConfig(next);
      setRawParamToml(toToml(next));
      if (unparsed) setUnparsedParamTomlLines(unparsed);
      setIsRawParamEditMode(false);
    },
    [toToml]
  );

  // ── Residue exclusion (SpinSystemKey-aware, same rule on every page) ──
  const isExcluded = useCallback(
    (resKey: string) => isResidueExcluded(parameterConfig, resKey, profiles),
    [parameterConfig, profiles]
  );
  const toggleExclude = (resKey: string) => setParameterConfig(prev => toggleExcludeResidue(prev, resKey, profiles));
  const addExcluded = (resKeys: string[]) =>
    setParameterConfig(prev => ({
      ...prev,
      excludedResidues: Array.from(new Set([...(prev.excludedResidues || []), ...resKeys])),
    }));
  const setExcluded = (resKeys: string[]) =>
    setParameterConfig(prev => ({ ...prev, excludedResidues: resKeys.length > 0 ? resKeys : undefined }));

  // ── Derived ──
  const staleResidues = useMemo(() => staleResidueKeys(parameterConfig, picks), [parameterConfig, picks]);
  const startingValues = useMemo(() => startingValuesFromGlobals(parameterConfig, defaults), [parameterConfig, defaults]);

  // ── Persistence ──
  const effectiveParameterToml = isRawParamEditMode ? rawParamToml : toToml(parameterConfig);
  const parameterConfigForSave: ParameterConfig = isRawParamEditMode
    ? { ...parameterConfig, rawOverride: rawParamToml }
    : parameterConfig;

  /** Restore from a saved (already normalized) config. Returns true if anything was restored. */
  const restore = useCallback(
    (saved: SavedParameterState, restoreProfiles: ProfileRef[] = []): boolean => {
      const rawCfg = saved.parameter_config;
      if (rawCfg && typeof rawCfg === 'object' && rawCfg.globals) {
        const { rawOverride, ...structured } = (codec.migrate ? codec.migrate(rawCfg) : rawCfg) as ParameterConfig;
        const legacy = dropLegacyDefaultGlobals(structured);
        const canon = canonicalizeParameterConfig(legacy.config, restoreProfiles);
        setNotices(
          legacy.dropped.length
            ? [
                `Removed resoFlow's old pre-filled starting values (${legacy.dropped.join(', ')}) that were never edited; ` +
                  `these parameters now start from ChemEx's defaults. Set them again if you relied on them.`,
              ]
            : []
        );
        const override = rawOverride ?? rawCfg.rawOverride;
        setParameterConfig(canon);
        if (override && override.trim()) {
          setRawParamToml(override);
          setIsRawParamEditMode(true);
        } else {
          setRawParamToml(codec.toToml(canon)); // stable identity: restore must not change when the catalogue loads
          setIsRawParamEditMode(false);
        }
        return true;
      }
      if (saved.parameter_toml) {
        const parsed = codec.fromToml(saved.parameter_toml);
        const canon = canonicalizeParameterConfig(parsed.config, restoreProfiles);
        setParameterConfig(canon);
        setRawParamToml(saved.parameter_toml);
        setUnparsedParamTomlLines(parsed.unparsed);
        return true;
      }
      return false;
    },
    [codec]
  );

  return {
    parameterConfig,
    setParameterConfig,
    replaceConfig,
    rawParamToml,
    setRawParamToml,
    isRawParamEditMode,
    enterRawMode,
    toggleRawMode,
    applyRawToml,
    discardRawToml,
    unparsedParamTomlLines,
    isExcluded,
    toggleExclude,
    addExcluded,
    setExcluded,
    staleResidues,
    startingValues,
    effectiveParameterToml,
    parameterConfigForSave,
    toToml,
    /** ChemEx default values/bounds lookup (catalogue-backed). */
    defaults,
    /** Feed the backend parameter catalogue (from useMethodEditor's `onCatalog`). */
    setCatalog,
    /** One-time migration notices from the last restore. */
    notices,
    dismissNotices,
    restore,
  };
}

export type ParameterEditor = ReturnType<typeof useParameterEditor>;
