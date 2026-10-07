import React, { useState, useEffect } from "react";
import { Filter, Plus, Trash2, Info, RotateCcw } from "lucide-react";

export interface SelectedSpectrumInfo {
  id: number;
  name: string;
  b1?: number | null;
  b0?: number | null;
}

export interface ProfileFilterControlsProps {
  selectedSpectra?: SelectedSpectrumInfo[];
  filterOffsetsBySpectrum?: Record<number, Array<[number, number]>>;
  onChangeFilterOffsetsForSpectrum?: (spectrumId: number, offsets: Array<[number, number]>) => void;
  onResetOffsetsForSpectrum?: (spectrumId: number) => void;
  // Fallbacks for legacy/direct usage
  filterOffsets?: Array<[number, number]>;
  onChangeFilterOffsets?: (offsets: Array<[number, number]>) => void;
  filterPlanes: number[];
  onChangeFilterPlanes: (planes: number[]) => void;
  dataError: "file" | "scatter";
  onChangeDataError: (err: "file" | "scatter") => void;
  allowedDataErrors?: string[];
  b1Nominal?: number;
}

export const ProfileFilterControls: React.FC<ProfileFilterControlsProps> = ({
  selectedSpectra,
  filterOffsetsBySpectrum,
  onChangeFilterOffsetsForSpectrum,
  onResetOffsetsForSpectrum,
  filterOffsets,
  onChangeFilterOffsets,
  filterPlanes,
  onChangeFilterPlanes,
  dataError,
  onChangeDataError,
  allowedDataErrors = ["file", "scatter"],
  b1Nominal = 25.0,
}) => {
  const [activeSpectrumId, setActiveSpectrumId] = useState<number | null>(null);

  // Sync active spectrum if selectedSpectra changes
  const activeSpec = (selectedSpectra && selectedSpectra.length > 0)
    ? (selectedSpectra.find(s => s.id === activeSpectrumId) || selectedSpectra[0])
    : null;

  const currentB1Nominal = activeSpec?.b1 != null ? Number(activeSpec.b1) : b1Nominal;

  // Current active offsets list
  const currentOffsets: Array<[number, number]> = activeSpec
    ? (filterOffsetsBySpectrum?.[activeSpec.id] ?? [[0.0, currentB1Nominal]])
    : (filterOffsets ?? [[0.0, b1Nominal]]);

  const [newOffset, setNewOffset] = useState<string>("0.0");
  const [newBw, setNewBw] = useState<string>(String(currentB1Nominal));
  const [newPlane, setNewPlane] = useState<string>("");

  useEffect(() => {
    setNewBw(String(currentB1Nominal));
  }, [currentB1Nominal, activeSpec?.id]);

  const handleAddOffset = () => {
    const off = parseFloat(newOffset);
    const bw = parseFloat(newBw);
    if (!isNaN(off) && !isNaN(bw) && bw > 0) {
      const updated: Array<[number, number]> = [...currentOffsets, [off, bw]];
      if (activeSpec && onChangeFilterOffsetsForSpectrum) {
        onChangeFilterOffsetsForSpectrum(activeSpec.id, updated);
      } else if (onChangeFilterOffsets) {
        onChangeFilterOffsets(updated);
      }
      setNewOffset("0.0");
      setNewBw(String(currentB1Nominal));
    }
  };

  const handleRemoveOffset = (index: number) => {
    const updated = currentOffsets.filter((_, idx) => idx !== index);
    if (activeSpec && onChangeFilterOffsetsForSpectrum) {
      onChangeFilterOffsetsForSpectrum(activeSpec.id, updated);
    } else if (onChangeFilterOffsets) {
      onChangeFilterOffsets(updated);
    }
  };

  const handleResetOffset = () => {
    const defaultList: Array<[number, number]> = [[0.0, currentB1Nominal]];
    if (activeSpec && onResetOffsetsForSpectrum) {
      onResetOffsetsForSpectrum(activeSpec.id);
    } else if (activeSpec && onChangeFilterOffsetsForSpectrum) {
      onChangeFilterOffsetsForSpectrum(activeSpec.id, defaultList);
    } else if (onChangeFilterOffsets) {
      onChangeFilterOffsets(defaultList);
    }
  };

  const handleAddPlane = () => {
    const p = parseInt(newPlane, 10);
    if (!isNaN(p) && p >= 0 && !filterPlanes.includes(p)) {
      onChangeFilterPlanes([...filterPlanes, p].sort((a, b) => a - b));
      setNewPlane("");
    }
  };

  const handleRemovePlane = (planeNum: number) => {
    onChangeFilterPlanes(filterPlanes.filter((p) => p !== planeNum));
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
            Data Quality & Fit Exclusions (<code className="text-xs">[data.filter_*]</code>)
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
            Uncertainty Mode:
          </label>
          <select
            value={dataError}
            onChange={(e) => onChangeDataError(e.target.value as "file" | "scatter")}
            className="text-xs px-2.5 py-1 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-medium"
          >
            {allowedDataErrors.map((err) => (
              <option key={err} value={err}>
                {err === "scatter" ? "scatter (from baseline)" : "file (from spectrum errors)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Filter Offsets Section */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                Excluded Offset Ranges (filter_offsets)
              </span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Offset ranges in Hz relative to resonance centre masked out of ChemEx fitting.
              </p>
            </div>
            {activeSpec && (
              <button
                type="button"
                onClick={handleResetOffset}
                title={`Reset to default direct saturation filter [0, ${currentB1Nominal} Hz]`}
                className="text-[11px] px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center gap-1 shrink-0 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset ([0, {currentB1Nominal}])</span>
              </button>
            )}
          </div>

          {/* Spectrum selector pills if spectra are selected */}
          {selectedSpectra && selectedSpectra.length > 1 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
                Select Spectrum to Configure:
              </span>
              <div className="flex flex-wrap gap-1.5 pb-1 max-h-24 overflow-y-auto">
                {selectedSpectra.map((s) => {
                  const isActive = s.id === activeSpec?.id;
                  const specB1 = s.b1 != null ? `${s.b1} Hz` : "No B1";
                  const specOffsets = filterOffsetsBySpectrum?.[s.id] ?? [[0.0, s.b1 != null ? Number(s.b1) : 25.0]];
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setActiveSpectrumId(s.id)}
                      className={`px-2 py-1 text-xs rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
                        isActive
                          ? "bg-blue-600 text-white font-semibold shadow-xs"
                          : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                      }`}
                    >
                      <span className="truncate max-w-[120px]">{s.name}</span>
                      <span
                        className={`text-[10px] px-1 py-0.2 rounded font-mono ${
                          isActive
                            ? "bg-blue-700 text-blue-100"
                            : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400"
                        }`}
                      >
                        B1: {specB1}
                      </span>
                      <span
                        className={`text-[9px] px-1 rounded-full font-bold ${
                          isActive
                            ? "bg-blue-500 text-white"
                            : "bg-slate-300 dark:bg-slate-600 text-slate-600 dark:text-slate-300"
                        }`}
                      >
                        {specOffsets.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedSpectra && selectedSpectra.length === 1 && (
            <div className="px-2.5 py-1 bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/40 rounded-lg text-xs text-blue-800 dark:text-blue-300 flex items-center justify-between">
              <span className="font-medium truncate max-w-[200px]">{selectedSpectra[0].name}</span>
              <span className="font-mono text-[11px] font-semibold">B1: {currentB1Nominal} Hz</span>
            </div>
          )}

          {selectedSpectra && selectedSpectra.length === 0 ? (
            <div className="p-3 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-xs text-slate-400 italic text-center">
              Select one or more CEST spectra above to configure per-spectrum filter offsets.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <input
                    type="number"
                    step="5"
                    placeholder="Offset (Hz)"
                    value={newOffset}
                    onChange={(e) => setNewOffset(e.target.value)}
                    className="w-full text-xs px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
                  />
                </div>
                <div className="flex-1">
                  <input
                    type="number"
                    step="5"
                    placeholder="Bandwidth (Hz)"
                    value={newBw}
                    onChange={(e) => setNewBw(e.target.value)}
                    className="w-full text-xs px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAddOffset}
                  className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add</span>
                </button>
              </div>

              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {currentOffsets.length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic">No offset ranges excluded.</p>
                ) : (
                  currentOffsets.map(([off, bw], idx) => {
                    const isCarrierDefault = off === 0 && bw === currentB1Nominal;
                    return (
                      <div
                        key={idx}
                        className="flex items-center justify-between px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200/60 dark:border-slate-700/60 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            Offset: {off > 0 ? `+${off}` : off} Hz (±{(bw / 2).toFixed(1)} Hz)
                          </span>
                          {isCarrierDefault && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-medium">
                              Default [0, B1]
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveOffset(idx)}
                          className="text-slate-400 hover:text-rose-500 p-0.5 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>

        {/* Filter Planes Section */}
        <div className="space-y-3">
          <div>
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              Excluded Planes (filter_planes)
            </span>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Specific plane indices excluded from calculation (or click points on profile plot).
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              placeholder="Plane index (e.g. 3)"
              value={newPlane}
              onChange={(e) => setNewPlane(e.target.value)}
              className="flex-1 text-xs px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
            />
            <button
              type="button"
              onClick={handleAddPlane}
              className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Exclude</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
            {filterPlanes.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No planes excluded.</p>
            ) : (
              filterPlanes.map((plane) => (
                <span
                  key={plane}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded-lg text-xs font-mono font-medium"
                >
                  <span>Plane {plane}</span>
                  <button
                    type="button"
                    onClick={() => handleRemovePlane(plane)}
                    className="hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer ml-0.5"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Plane 0 Rule Info Banner */}
      <div className="px-3 py-2 bg-blue-50/70 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/50 rounded-lg text-xs text-blue-800 dark:text-blue-300 flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold">Plane 0 Rule:</span> In ChemEx, Plane 0 represents the reference spectrum (unperturbed reference intensity \(I_0\)) and is automatically excluded from fit curve minimization by default.
        </div>
      </div>
    </div>
  );
};
