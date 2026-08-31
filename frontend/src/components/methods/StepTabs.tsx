import React, { useState } from 'react';
import type { Step } from '../../lib/methodConfig';
import {
  Plus,
  Copy,
  Trash2,
  GripVertical,
  AlertCircle,
  Edit2,
  Check
} from 'lucide-react';

interface StepTabsProps {
  steps: Step[];
  activeStepIdx: number;
  onSelectStep: (idx: number) => void;
  onAddStep: () => void;
  onDuplicateStep: (idx: number) => void;
  onDeleteStep: (idx: number) => void;
  onRenameStep: (idx: number, newName: string) => void;
  onReorderSteps: (startIndex: number, endIndex: number) => void;
  readOnly?: boolean;
}

export const StepTabs: React.FC<StepTabsProps> = ({
  steps,
  activeStepIdx,
  onSelectStep,
  onAddStep,
  onDuplicateStep,
  onDeleteStep,
  onRenameStep,
  onReorderSteps,
  readOnly = false,
}) => {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [tempName, setTempName] = useState('');
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const startRename = (idx: number, currentName: string) => {
    if (readOnly) return;
    setEditingIdx(idx);
    setTempName(currentName);
  };

  const commitRename = () => {
    if (editingIdx !== null && tempName.trim()) {
      const sanitized = tempName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      onRenameStep(editingIdx, sanitized || `STEP${editingIdx + 1}`);
    }
    setEditingIdx(null);
    setTempName('');
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    if (readOnly) return;
    setDraggedIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (draggedIdx !== null && draggedIdx !== targetIdx) {
      onReorderSteps(draggedIdx, targetIdx);
    }
    setDraggedIdx(null);
  };

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2 pt-1 border-b border-slate-200 dark:border-slate-800">
      <div className="flex items-center gap-1.5 flex-grow">
        {steps.map((step, idx) => {
          const isActive = idx === activeStepIdx;
          const fitParams = step.parameters.filter(p => p.mode === 'fit');
          const gridParams = step.parameters.filter(p => p.mode === 'grid');
          const hasNothingToFit = fitParams.length === 0 && gridParams.length === 0;

          return (
            <div
              key={step.id || idx}
              draggable={!readOnly && editingIdx !== idx}
              onDragStart={e => handleDragStart(e, idx)}
              onDragOver={handleDragOver}
              onDrop={e => handleDrop(e, idx)}
              className={`group relative flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all border cursor-pointer select-none ${
                isActive
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-700/60 shadow-sm'
                  : 'bg-slate-100/70 hover:bg-slate-200/70 dark:bg-slate-900/60 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200/80 dark:border-slate-800'
              }`}
              onClick={() => {
                if (editingIdx !== idx) onSelectStep(idx);
              }}
            >
              {/* Drag Handle */}
              {!readOnly && (
                <span title="Drag to reorder step">
                  <GripVertical className="w-3 h-3 text-slate-400 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" />
                </span>
              )}

              {/* Warning for empty step */}
              {hasNothingToFit && (
                <span title="This step has no fitted parameters and no grid search">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 animate-pulse" />
                </span>
              )}

              {/* Label or Inline Edit */}
              {editingIdx === idx ? (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <input
                    type="text"
                    autoFocus
                    value={tempName}
                    onChange={e => setTempName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') setEditingIdx(null);
                    }}
                    onBlur={commitRename}
                    className="font-mono text-xs px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-blue-500 text-slate-900 dark:text-white outline-none w-24"
                  />
                  <button
                    type="button"
                    onClick={commitRename}
                    className="text-emerald-600 hover:text-emerald-500 p-0.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <span
                  onDoubleClick={() => startRename(idx, step.name)}
                  className="font-mono tracking-wide font-bold"
                  title="Double-click to rename"
                >
                  {step.name || `STEP${idx + 1}`}
                </span>
              )}

              {/* Step Summary Badges */}
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 font-mono">
                {fitParams.length} fit
              </span>

              {/* Actions on hover/active */}
              {!readOnly && (
                <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      startRename(idx, step.name);
                    }}
                    className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    title="Rename step"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onDuplicateStep(idx);
                    }}
                    className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                    title="Duplicate step"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={steps.length <= 1}
                    onClick={e => {
                      e.stopPropagation();
                      onDeleteStep(idx);
                    }}
                    className={`p-1 hover:bg-red-100 dark:hover:bg-red-900/40 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 ${
                      steps.length <= 1 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                    title={steps.length <= 1 ? 'Cannot delete the only remaining step' : 'Delete step'}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Add Step Button */}
        {!readOnly && (
          <button
            type="button"
            onClick={onAddStep}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-50 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 text-blue-600 dark:text-blue-400 border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 transition-colors shadow-sm"
            title="Add a new fitting step"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Step</span>
          </button>
        )}
      </div>
    </div>
  );
};
export default StepTabs;
