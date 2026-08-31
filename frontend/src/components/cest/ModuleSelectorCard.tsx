import React from "react";
import { ExternalLink, Layers } from "lucide-react";
import type { ExperimentModuleInfo } from "../../lib/experimentPlugin";

export interface ModuleSelectorCardProps {
  selectedModule: string;
  onSelectModule: (moduleName: string) => void;
  availableModules?: ExperimentModuleInfo[];
  extraValues?: Record<string, any>;
  onChangeExtraValue?: (key: string, value: any) => void;
  flags?: Record<string, boolean>;
  onToggleFlag?: (flag: string, value: boolean) => void;
}

export const CEST_MODULE_GROUPS = [
  {
    groupName: "15N Amide",
    modules: [
      { id: "cest_15n", name: "15N CW CEST", probe: "15N", key: "G2N", desc: "Pure in-phase 15N CEST experiment" },
      { id: "cest_15n_cw", name: "15N CW Decoupling CEST", probe: "15N", key: "G2N", desc: "15N CEST with 1H continuous-wave decoupling" },
      { id: "cest_15n_tr", name: "15N TROSY CEST", probe: "15N", key: "G2N-HN", desc: "TROSY 15N CEST for large macromolecules (>30 kDa)" },
    ],
  },
  {
    groupName: "13C Aliphatic / Carbonyl",
    modules: [
      { id: "cest_13c", name: "13C In-Phase CEST", probe: "13C", key: "G2C", desc: "Pure in-phase 13C CEST experiment" },
    ],
  },
  {
    groupName: "1H Amide",
    modules: [
      { id: "cest_1hn_ap", name: "1HN Anti-Phase CEST", probe: "1HN", key: "G2HN-N", desc: "Anti-phase 1H-15N CEST experiment" },
      { id: "cest_1hn_ip_ap", name: "1HN IP/AP CEST", probe: "1HN", key: "G2HN-N", desc: "In-phase/anti-phase 1H-15N CEST experiment" },
    ],
  },
  {
    groupName: "13CH3 Methyl 1H",
    modules: [
      { id: "cest_ch3_1h_ip_ap", name: "CH3 1H IP/AP CEST", probe: "13CH3", key: "L3HD1-CD1", desc: "In-phase/anti-phase 1H CEST for methyl groups" },
    ],
  },
];

export const ModuleSelectorCard: React.FC<ModuleSelectorCardProps> = ({
  selectedModule,
  onSelectModule,
  extraValues = {},
  onChangeExtraValue,
  flags = {},
  onToggleFlag,
}) => {
  const currentMod = CEST_MODULE_GROUPS.flatMap(g => g.modules).find(m => m.id === selectedModule) || {
    id: selectedModule,
    name: selectedModule,
    probe: "15N",
    key: "G2N",
    desc: "ChemEx experiment module",
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
            ChemEx CEST Experiment Module
          </h3>
        </div>
        <a
          href={`https://chemex.readthedocs.io/en/latest/experiments/${selectedModule}.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 flex items-center gap-1 font-medium"
        >
          <span>ChemEx Docs</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
            Selected Module
          </label>
          <select
            value={selectedModule}
            onChange={(e) => onSelectModule(e.target.value)}
            className="w-full text-sm px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-medium focus:ring-2 focus:ring-blue-500"
          >
            {CEST_MODULE_GROUPS.map((grp) => (
              <optgroup key={grp.groupName} label={grp.groupName}>
                {grp.modules.map((mod) => (
                  <option key={mod.id} value={mod.id}>
                    {mod.name} ({mod.probe} • {mod.key})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="flex flex-col justify-center bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200/60 dark:border-slate-700/60">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {currentMod.name}
            </span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
              {currentMod.probe}
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300">
              key: {currentMod.key}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
            {currentMod.desc}
          </p>
        </div>
      </div>

      {/* Module-specific parameter inputs */}
      {selectedModule === "cest_15n_cw" && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              Decoupling Carrier (ppm)
            </label>
            <input
              type="number"
              step="0.1"
              value={extraValues.carrier_dec ?? 8.5}
              onChange={(e) => onChangeExtraValue?.("carrier_dec", parseFloat(e.target.value))}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              Decoupling B1 Field (Hz)
            </label>
            <input
              type="number"
              step="100"
              value={extraValues.b1_frq_dec ?? 2000}
              onChange={(e) => onChangeExtraValue?.("b1_frq_dec", parseFloat(e.target.value))}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
          </div>
        </div>
      )}

      {selectedModule === "cest_15n_tr" && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Anti-TROSY Mode
            </span>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Observe anti-TROSY component instead of standard TROSY component
            </p>
          </div>
          <input
            type="checkbox"
            checked={Boolean(flags.antitrosy)}
            onChange={(e) => onToggleFlag?.("antitrosy", e.target.checked)}
            className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500"
          />
        </div>
      )}

      {(selectedModule === "cest_1hn_ip_ap" || selectedModule === "cest_ch3_1h_ip_ap") && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              Relaxation Delay d1 (s)
            </label>
            <input
              type="number"
              step="0.1"
              value={extraValues.d1 ?? 1.0}
              onChange={(e) => onChangeExtraValue?.("d1", parseFloat(e.target.value))}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              taua (s)
            </label>
            <input
              type="number"
              step="0.001"
              value={extraValues.taua ?? 0.002}
              onChange={(e) => onChangeExtraValue?.("taua", parseFloat(e.target.value))}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
          </div>
          {selectedModule === "cest_1hn_ip_ap" && (
            <div className="flex flex-col justify-center pt-2">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={Boolean(flags.eta_block)}
                  onChange={(e) => onToggleFlag?.("eta_block", e.target.checked)}
                  className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500"
                />
                <span>eta_block</span>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
