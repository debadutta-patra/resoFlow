import React from "react";
import { Sliders } from "lucide-react";

export interface B1DistributionConfig {
  type: string;
  scale?: number;
  res?: number;
  skew?: number;
  [key: string]: any;
}

export interface NestedConfigGroupProps {
  distribution: B1DistributionConfig;
  onChangeDistribution: (config: B1DistributionConfig) => void;
}

export const DISTRIBUTION_TYPES = [
  { id: "dephasing", name: "Dephasing (Fast)", desc: "Calculates steady-state dephasing without integration over sub-points (recommended for CW CEST)" },
  { id: "gaussian", name: "Gaussian Distribution", desc: "Gaussian B1 distribution with finite resolution" },
  { id: "beta", name: "Beta Distribution", desc: "Beta-distributed B1 field profile" },
  { id: "skewed", name: "Skewed Gaussian", desc: "Asymmetric / skewed Gaussian distribution" },
  { id: "rectangular", name: "Rectangular / Uniform", desc: "Uniform step distribution" },
  { id: "triangle", name: "Triangular Distribution", desc: "Triangular distribution profile" },
  { id: "lorentzian", name: "Lorentzian Distribution", desc: "Lorentzian distribution profile" },
  { id: "none", name: "None (Ideal B1)", desc: "Uniform nominal B1 field with zero inhomogeneity" },
];

export const NestedConfigGroup: React.FC<NestedConfigGroupProps> = ({
  distribution,
  onChangeDistribution,
}) => {
  const currentType = distribution.type || "dephasing";
  const showSubFields = currentType !== "dephasing" && currentType !== "none";

  const handleTypeChange = (newType: string) => {
    if (newType === "dephasing" || newType === "none") {
      onChangeDistribution({ type: newType });
    } else {
      onChangeDistribution({
        type: newType,
        scale: distribution.scale ?? 0.1,
        res: distribution.res ?? 11,
        ...(newType === "skewed" ? { skew: distribution.skew ?? 0.0 } : {}),
      });
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center gap-2">
        <Sliders className="w-4 h-4 text-purple-600 dark:text-purple-400" />
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
          B1 Field Inhomogeneity & Distribution (<code className="text-xs">[experiment.b1_distribution]</code>)
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
            Distribution Type
          </label>
          <select
            value={currentType}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="w-full text-sm px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-medium focus:ring-2 focus:ring-purple-500"
          >
            {DISTRIBUTION_TYPES.map((dt) => (
              <option key={dt.id} value={dt.id}>
                {dt.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col justify-center bg-purple-50/50 dark:bg-purple-950/20 rounded-lg p-3 border border-purple-100 dark:border-purple-900/40">
          <span className="text-xs font-semibold text-purple-900 dark:text-purple-300">
            {DISTRIBUTION_TYPES.find(dt => dt.id === currentType)?.name}
          </span>
          <p className="text-xs text-purple-700 dark:text-purple-400 mt-0.5">
            {DISTRIBUTION_TYPES.find(dt => dt.id === currentType)?.desc}
          </p>
        </div>
      </div>

      {showSubFields && (
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              Scale (<code className="text-[11px]">scale</code>)
            </label>
            <input
              type="number"
              step="0.01"
              min="0.001"
              max="1.0"
              value={distribution.scale ?? 0.1}
              onChange={(e) => onChangeDistribution({ ...distribution, scale: parseFloat(e.target.value) })}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
            <span className="text-[10px] text-slate-400">Relative spread (fraction)</span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              Resolution (<code className="text-[11px]">res</code>)
            </label>
            <input
              type="number"
              step="2"
              min="3"
              max="51"
              value={distribution.res ?? 11}
              onChange={(e) => onChangeDistribution({ ...distribution, res: parseInt(e.target.value, 10) })}
              className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
            <span className="text-[10px] text-slate-400">Grid sample points (odd integer)</span>
          </div>

          {currentType === "skewed" && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                Skew (<code className="text-[11px]">skew</code>)
              </label>
              <input
                type="number"
                step="0.1"
                value={distribution.skew ?? 0.0}
                onChange={(e) => onChangeDistribution({ ...distribution, skew: parseFloat(e.target.value) })}
                className="w-full text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
              />
              <span className="text-[10px] text-slate-400">Asymmetry parameter</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
