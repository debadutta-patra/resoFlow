import React from "react";
import { ExternalLink, Layers } from "lucide-react";

export interface CpmgModuleDefinition {
  id: string;
  name: string;
  group: "15N Amide" | "1H Amide" | "15N-1H DQ/ZQ" | "13C / Carbonyl" | "Methyl (13CH3 / 13CHD2)";
  probe: string;
  observedNucleus: string;
  spinKeyFormat: string;
  spinKeyExample: string;
  description: string;
  docsUrl: string;
  has0013Variant?: boolean;
  hasAntiTrosy?: boolean;
  hasSmallProtein?: boolean;
  hasDqFlag?: boolean;
  requiredFields: string[];
}

export interface CpmgModuleGroup {
  groupName: string;
  modules: CpmgModuleDefinition[];
}

export const CPMG_MODULE_GROUPS: CpmgModuleGroup[] = [
  {
    groupName: "15N Amide",
    modules: [
      {
        id: "cpmg_15n_rc",
        name: "15N Relaxation-Compensated CPMG",
        group: "15N Amide" as const,
        probe: "15N",
        observedNucleus: "15N",
        spinKeyFormat: "Two-Spin (15N-1H)",
        spinKeyExample: "G2N-HN",
        description: "Relaxation-compensated 15N CPMG (hsqcrexetf3gpsitc3d): two CPMG blocks with central P-element.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_rc.html",
        requiredFields: ["time_t2", "carrier", "pw90", "ncyc_max"],
      },
      {
        id: "cpmg_15n_ip",
        name: "15N In-Phase CPMG",
        group: "15N Amide" as const,
        probe: "15N",
        observedNucleus: "15N",
        spinKeyFormat: "Single-Spin (15N)",
        spinKeyExample: "G2N",
        description: "Pure in-phase 15N CPMG relaxation dispersion experiment for backbone amides.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_ip.html",
        has0013Variant: true,
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
      {
        id: "cpmg_15n_tr",
        name: "15N TROSY CPMG",
        group: "15N Amide" as const,
        probe: "15N",
        observedNucleus: "15N",
        spinKeyFormat: "Two-Spin (15N-1H)",
        spinKeyExample: "G2N-HN",
        description: "TROSY-selected 15N CPMG relaxation dispersion for high-MW systems (>30 kDa).",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_tr.html",
        has0013Variant: true,
        hasAntiTrosy: true,
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
    ],
  },
  {
    groupName: "1H Amide",
    modules: [
      {
        id: "cpmg_1hn_ap",
        name: "1HN Anti-Phase CPMG",
        group: "1H Amide" as const,
        probe: "1HN",
        observedNucleus: "1H",
        spinKeyFormat: "Two-Spin (1H-15N)",
        spinKeyExample: "G2HN-N",
        description: "Anti-phase 1H-15N CPMG relaxation dispersion experiment for amide protons.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_1hn_ap.html",
        has0013Variant: true,
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
    ],
  },
  {
    groupName: "15N-1H DQ/ZQ",
    modules: [
      {
        id: "cpmg_hn_dq_zq",
        name: "15N-1H DQ/ZQ CPMG",
        group: "15N-1H DQ/ZQ" as const,
        probe: "15N-1H",
        observedNucleus: "15N",
        spinKeyFormat: "Two-Spin (15N-1H)",
        spinKeyExample: "G2N-HN",
        description: "Double- and zero-quantum 15N-1H CPMG relaxation dispersion experiment.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_hn_dq_zq.html",
        hasDqFlag: true,
        requiredFields: ["time_t2", "carrier_h", "carrier_n", "pw90_h", "pw90_n"],
      },
    ],
  },
  {
    groupName: "13C / Carbonyl",
    modules: [
      {
        id: "cpmg_13c_ip",
        name: "13C In-Phase CPMG",
        group: "13C / Carbonyl" as const,
        probe: "13C",
        observedNucleus: "13C",
        spinKeyFormat: "Single-Spin (13C)",
        spinKeyExample: "G2C",
        description: "Pure in-phase 13C CPMG relaxation dispersion for aliphatic carbons.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_13c_ip.html",
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
      {
        id: "cpmg_13co_ap",
        name: "13CO Anti-Phase CPMG",
        group: "13C / Carbonyl" as const,
        probe: "13CO",
        observedNucleus: "13C",
        spinKeyFormat: "Single-Spin (13C)",
        spinKeyExample: "G2C",
        description: "Anti-phase 13CO carbonyl CPMG relaxation dispersion experiment.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_13co_ap.html",
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
    ],
  },
  {
    groupName: "Methyl (13CH3 / 13CHD2)",
    modules: [
      {
        id: "cpmg_ch3_mq",
        name: "CH3 Multiple-Quantum (MQ) CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "13C",
        spinKeyFormat: "Methyl MQ (13C-1H)",
        spinKeyExample: "L3CD1-HD1",
        description: "Multiple-quantum methyl CPMG. Assumes on-resonance 13C excitation.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_mq.html",
        hasSmallProtein: true,
        requiredFields: ["time_t2"],
      },
      {
        id: "cpmg_ch3_13c_h2c",
        name: "CH3 13C H2C CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "13C",
        spinKeyFormat: "Methyl MQ (13C-1H)",
        spinKeyExample: "L3CD1-HD1",
        description: "Methyl 13C CPMG with H2C polarization transfer block.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_13c_h2c.html",
        has0013Variant: true,
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
      {
        id: "cpmg_ch3_1h_sq",
        name: "CH3 1H Single-Quantum CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "1H",
        spinKeyFormat: "Methyl 1H (1H-13C)",
        spinKeyExample: "L3HD1-CD1",
        description: "Single-quantum 1H CPMG relaxation dispersion for 13CH3 methyls.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_sq.html",
        requiredFields: ["time_t2", "carrier", "pw90", "ncyc_max"],
      },
      {
        id: "cpmg_ch3_1h_dq",
        name: "CH3 1H Double-Quantum CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "1H",
        spinKeyFormat: "Methyl 1H (1H-13C)",
        spinKeyExample: "L3HD1-CD1",
        description: "Double-quantum 1H CPMG relaxation dispersion for 13CH3 methyls.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_dq.html",
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
      {
        id: "cpmg_ch3_1h_tq",
        name: "CH3 1H Triple-Quantum CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "1H",
        spinKeyFormat: "Methyl 1H (1H-13C)",
        spinKeyExample: "L3HD1-CD1",
        description: "Triple-quantum 1H CPMG relaxation dispersion for 13CH3 methyls.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_tq.html",
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
      {
        id: "cpmg_ch3_1h_tq_diff",
        name: "CH3 1H Triple-Quantum Diffusion CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CH3",
        observedNucleus: "1H",
        spinKeyFormat: "Methyl 1H (1H-13C)",
        spinKeyExample: "L3HD1-CD1",
        description: "Triple-quantum 1H CPMG with pulsed-field gradient diffusion filter.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_tq_diff.html",
        requiredFields: ["time_t2", "carrier", "pw90", "delta", "gradient"],
      },
      {
        id: "cpmg_chd2_1h_ap",
        name: "13CHD2 1H Anti-Phase CPMG",
        group: "Methyl (13CH3 / 13CHD2)" as const,
        probe: "13CHD2",
        observedNucleus: "1H",
        spinKeyFormat: "Methyl 1H (1H-13C)",
        spinKeyExample: "L3HD1-CD1",
        description: "Anti-phase 1H CPMG relaxation dispersion for 13CHD2 methyl groups.",
        docsUrl: "https://chemex.readthedocs.io/en/latest/experiments/cpmg_chd2_1h_ap.html",
        requiredFields: ["time_t2", "carrier", "pw90"],
      },
    ],
  },
];

export const CPMG_MODULES: CpmgModuleDefinition[] = CPMG_MODULE_GROUPS.flatMap((g) => g.modules);

export interface CpmgModuleSelectorProps {
  selectedParentId: string;
  onSelectParent: (parentId: string) => void;
  is0013: boolean;
  onToggle0013: (val: boolean) => void;
  isAntiTrosy: boolean;
  onToggleAntiTrosy: (val: boolean) => void;
  isSmallProtein: boolean;
  onToggleSmallProtein: (val: boolean) => void;
  isDoubleQuantum: boolean;
  onToggleDoubleQuantum: (val: boolean) => void;
}

export const CpmgModuleSelector: React.FC<CpmgModuleSelectorProps> = ({
  selectedParentId,
  onSelectParent,
  is0013,
  onToggle0013,
  isAntiTrosy,
  onToggleAntiTrosy,
  isSmallProtein,
  onToggleSmallProtein,
  isDoubleQuantum,
  onToggleDoubleQuantum,
}) => {
  const selectedDef = CPMG_MODULES.find((m) => m.id === selectedParentId) || CPMG_MODULES[0];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
            ChemEx CPMG Experiment Module
          </h3>
        </div>
        <a
          href={selectedDef.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 flex items-center gap-1 font-medium"
        >
          <span>ChemEx Docs</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* Grid: Module selector and Details Box */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
            Selected Module
          </label>
          <select
            value={selectedParentId}
            onChange={(e) => onSelectParent(e.target.value)}
            className="w-full text-sm px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-medium focus:ring-2 focus:ring-blue-500"
          >
            {CPMG_MODULE_GROUPS.map((grp) => (
              <optgroup key={grp.groupName} label={grp.groupName}>
                {grp.modules.map((mod) => (
                  <option key={mod.id} value={mod.id}>
                    {mod.name} ({mod.probe} • {mod.spinKeyExample})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Right column: Badge & Description */}
        <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700/60 flex flex-col justify-center space-y-1 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800 dark:text-slate-200">{selectedDef.name}</span>
            <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-mono text-[10px] font-bold">
              {selectedDef.probe}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-mono text-[10px] font-bold">
              key: {selectedDef.spinKeyExample}
            </span>
            {is0013 && selectedDef.has0013Variant && (
              <span className="px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-mono text-[10px] font-bold">
                [0013]
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
            {selectedDef.description}
          </p>
        </div>
      </div>

      {/* Variant Toggles */}
      {(selectedDef.has0013Variant || selectedDef.hasAntiTrosy || selectedDef.hasSmallProtein || selectedDef.hasDqFlag) && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center gap-4 text-xs">
          <span className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">
            Variant Options:
          </span>

          {selectedDef.has0013Variant && (
            <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
              <input
                type="checkbox"
                checked={is0013}
                onChange={(e) => onToggle0013(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600 rounded"
              />
              <span>[0013] Phase Cycle</span>
            </label>
          )}

          {selectedDef.hasAntiTrosy && (
            <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
              <input
                type="checkbox"
                checked={isAntiTrosy}
                onChange={(e) => onToggleAntiTrosy(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600 rounded"
              />
              <span>Anti-TROSY Component</span>
            </label>
          )}

          {selectedDef.hasSmallProtein && (
            <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
              <input
                type="checkbox"
                checked={isSmallProtein}
                onChange={(e) => onToggleSmallProtein(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600 rounded"
              />
              <span>Small Protein Mode</span>
            </label>
          )}

          {selectedDef.hasDqFlag && (
            <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
              <input
                type="checkbox"
                checked={isDoubleQuantum}
                onChange={(e) => onToggleDoubleQuantum(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600 rounded"
              />
              <span>Double-Quantum Mode</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
};
