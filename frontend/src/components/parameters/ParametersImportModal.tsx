import React, { useState } from 'react';
import { Upload, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { tomlToConfig } from '../../lib/parameterToml';
import type { ParameterConfig } from '../../lib/parameterConfig';

interface ParametersImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (importedConfig: ParameterConfig, unparsed: string[]) => void;
}

export const ParametersImportModal: React.FC<ParametersImportModalProps> = ({
  isOpen,
  onClose,
  onImport,
}) => {
  const [tomlText, setTomlText] = useState('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleExecuteImport = () => {
    if (!tomlText.trim()) {
      setError('Please provide TOML content to import.');
      return;
    }
    try {
      const { config, unparsed } = tomlToConfig(tomlText);
      const globalCount = Object.keys(config.globals || {}).length;
      const residueCount = Object.keys(config.residues || {}).length;

      if (globalCount === 0 && residueCount === 0) {
        setError('No valid [GLOBAL] or residue sections found in the provided TOML.');
        return;
      }

      onImport(config, unparsed);
      setTomlText('');
      setError('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to parse parameters TOML.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Import parameters.toml
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Paste existing ChemEx parameters TOML to populate the structured model.
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

        {/* Body */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2">
              TOML Content
            </label>
            <textarea
              rows={12}
              value={tomlText}
              onChange={(e) => {
                setTomlText(e.target.value);
                if (error) setError('');
              }}
              placeholder={`# Example parameters.toml\n[GLOBAL]\nPB = 0.05\nKEX_AB = 500\nTAUC_A = 4\n\n[CS_A]\n13N = 112.444\n\n[DW_AB]\n13N = 2.500`}
              className="w-full text-xs font-mono p-3 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 leading-relaxed resize-y"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2 bg-slate-50/50 dark:bg-slate-900">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExecuteImport}
            disabled={!tomlText.trim()}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm disabled:opacity-50 transition-all flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Parse & Import</span>
          </button>
        </div>
      </div>
    </div>
  );
};
