import React, { useState } from "react";
import { Filter, Plus, Trash2, Info } from "lucide-react";

export interface ProfileFilterControlsProps {
  filterOffsets: Array<[number, number]>;
  onChangeFilterOffsets: (offsets: Array<[number, number]>) => void;
  filterPlanes: number[];
  onChangeFilterPlanes: (planes: number[]) => void;
  dataError: "file" | "scatter";
  onChangeDataError: (err: "file" | "scatter") => void;
  allowedDataErrors?: string[];
  b1Nominal?: number;
}

export const ProfileFilterControls: React.FC<ProfileFilterControlsProps> = ({
  filterOffsets,
  onChangeFilterOffsets,
  filterPlanes,
  onChangeFilterPlanes,
  dataError,
  onChangeDataError,
  allowedDataErrors = ["file", "scatter"],
  b1Nominal = 25.0,
}) => {
  const [newOffset, setNewOffset] = useState<string>("0.0");
  const [newBw, setNewBw] = useState<string>(String(b1Nominal));
  const [newPlane, setNewPlane] = useState<string>("");

  const handleAddOffset = () => {
    const off = parseFloat(newOffset);
    const bw = parseFloat(newBw);
    if (!isNaN(off) && !isNaN(bw) && bw > 0) {
      onChangeFilterOffsets([...filterOffsets, [off, bw]]);
      setNewOffset("0.0");
      setNewBw(String(b1Nominal));
    }
  };

  const handleRemoveOffset = (index: number) => {
    const updated = filterOffsets.filter((_, idx) => idx !== index);
    onChangeFilterOffsets(updated);
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
          <div>
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              Excluded Offset Ranges (filter_offsets)
            </span>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Offset ranges in Hz relative to resonance centre masked out of ChemEx fitting.
            </p>
          </div>

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
              className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </div>

          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
            {filterOffsets.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No offset ranges excluded.</p>
            ) : (
              filterOffsets.map(([off, bw], idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200/60 dark:border-slate-700/60 text-xs"
                >
                  <span className="font-mono text-slate-700 dark:text-slate-300">
                    Offset: {off > 0 ? `+${off}` : off} Hz (±{(bw / 2).toFixed(1)} Hz)
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveOffset(idx)}
                    className="text-slate-400 hover:text-rose-500 p-0.5 rounded cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
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
