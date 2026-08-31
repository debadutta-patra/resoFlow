import React, { useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import type { CpmgModuleDefinition } from "./CpmgModuleSelector";
import { KINETIC_MODELS } from "../../lib/methodConfig";

export interface CpmgSetupFormProps {
  moduleDef: CpmgModuleDefinition;
  values: {
    time_t2: number;
    carrier: number;
    pw90: number;
    data_error: "duplicates" | "file";
    carrier_h?: number;
    carrier_n?: number;
    pw90_h?: number;
    pw90_n?: number;
    taub?: number;
    t_zeta?: number;
    ncyc_max?: number;
    delta?: number;
    gradient?: number;
    temperature?: number;
    p_total?: number;
    l_total?: number;
  };
  onChangeValue: (key: string, val: any) => void;
  selectedSpectraFields: number[]; // e.g. [600, 800]
  model: string;
  onChangeModel: (model: string) => void;
  useHeight: boolean;
  onChangeUseHeight: (val: boolean) => void;
}

export const CpmgSetupForm: React.FC<CpmgSetupFormProps> = ({
  moduleDef,
  values,
  onChangeValue,
  selectedSpectraFields,
  model,
  onChangeModel,
  useHeight,
  onChangeUseHeight,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const isMultiField = selectedSpectraFields.length > 1;
  const inputCls = "w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200";
  const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1 uppercase tracking-wider";
  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";

  return (
    <div className="space-y-4">
      {/* Static Field Warning */}
      {!isMultiField && (
        <div className="p-3.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">Single Static Field: </span>
            Separating exchange population (p<sub>b</sub>) from chemical shift difference (|Δω|) in CPMG fundamentally requires two or more static fields (e.g. 600 MHz and 800 MHz).
          </div>
        </div>
      )}

      {/* Main Parameters Card */}
      <div className={sectionCls}>
        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3">
          CPMG Parameters
        </h4>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className={labelCls}>Kinetic Model</label>
            <select
              value={model}
              onChange={(e) => onChangeModel(e.target.value)}
              className={inputCls}
            >
              {KINETIC_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Intensity</label>
            <select
              value={useHeight ? "height" : "amp"}
              onChange={(e) => onChangeUseHeight(e.target.value === "height")}
              className={inputCls}
            >
              <option value="height">Height</option>
              <option value="amp">Amplitude</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div>
            <label className={labelCls}>Constant-Time Delay (time_t2 in s)</label>
            <input
              type="number"
              step="0.005"
              value={values.time_t2}
              onChange={(e) => onChangeValue("time_t2", parseFloat(e.target.value) || 0)}
              className={inputCls}
            />
          </div>

          {moduleDef.id !== "cpmg_ch3_mq" && moduleDef.id !== "cpmg_hn_dq_zq" && (
            <div>
              <label className={labelCls}>Carrier Position (ppm)</label>
              <input
                type="number"
                step="0.1"
                value={values.carrier}
                onChange={(e) => onChangeValue("carrier", parseFloat(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
          )}

          {moduleDef.id !== "cpmg_ch3_mq" && moduleDef.id !== "cpmg_hn_dq_zq" && (
            <div>
              <label className={labelCls}>90° Pulse Width (pw90 in s)</label>
              <input
                type="number"
                step="1e-6"
                value={values.pw90}
                onChange={(e) => onChangeValue("pw90", parseFloat(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
          )}

          {/* Uncertainty Error Mode */}
          <div>
            <label className={labelCls}>Uncertainty Error Mode</label>
            <select
              value={values.data_error}
              onChange={(e) => onChangeValue("data_error", e.target.value as any)}
              className={inputCls}
            >
              <option value="duplicates">Duplicates (Repeated νcpmg)</option>
              <option value="file">File (Peak fitting errors)</option>
            </select>
          </div>
        </div>

        {/* DQ/ZQ special carriers */}
        {moduleDef.id === "cpmg_hn_dq_zq" && (
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className={labelCls}>1H Carrier (ppm)</label>
              <input
                type="number"
                step="0.1"
                value={values.carrier_h || 8.5}
                onChange={(e) => onChangeValue("carrier_h", parseFloat(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>15N Carrier (ppm)</label>
              <input
                type="number"
                step="0.1"
                value={values.carrier_n || 117.0}
                onChange={(e) => onChangeValue("carrier_n", parseFloat(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
          </div>
        )}

        {/* Advanced Collapsible */}
        <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Advanced Settings
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              {(values.taub !== undefined || moduleDef.id === "cpmg_15n_rc") && (
                <div>
                  <label className={labelCls}>P-Element Delay (taub in s)</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={values.taub ?? 0.00268}
                    onChange={(e) => onChangeValue("taub", parseFloat(e.target.value) || 0)}
                    className={inputCls}
                  />
                </div>
              )}

              {values.t_zeta !== undefined && (
                <div>
                  <label className={labelCls}>t_zeta (s)</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={values.t_zeta}
                    onChange={(e) => onChangeValue("t_zeta", parseFloat(e.target.value) || 0)}
                    className={inputCls}
                  />
                </div>
              )}

              {(values.ncyc_max !== undefined || moduleDef.id === "cpmg_15n_rc" || moduleDef.has0013Variant) && (
                <div>
                  <label className={labelCls}>Max Cycles (ncyc_max)</label>
                  <input
                    type="number"
                    step="1"
                    value={values.ncyc_max ?? 20}
                    onChange={(e) => onChangeValue("ncyc_max", parseInt(e.target.value) || 0)}
                    className={inputCls}
                  />
                </div>
              )}

              <div>
                <label className={labelCls}>Temperature (K)</label>
                <input
                  type="number"
                  step="0.1"
                  value={values.temperature || 298.15}
                  onChange={(e) => onChangeValue("temperature", parseFloat(e.target.value) || 298.15)}
                  className={inputCls}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
