import React, { useMemo, useState } from 'react';
import { Upload, X, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import {
  DEFAULT_PARAMETER_CODEC,
  isResoflowGenerated,
  migrateLegacyCommentExclusions,
  parseWithLegacyExclusions,
  type ParameterCodec,
} from '../../lib/parameterToml';
import type { ParameterConfig } from '../../lib/parameterConfig';
import { convertLegacyTc, scanLegacyTc } from '../../lib/tcModel';

interface ParametersImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** `legacyExcluded`: residues converted from old-style commented lines into exclusions. */
  onImport: (importedConfig: ParameterConfig, unparsed: string[], legacyExcluded: string[], warnings: string[]) => void;
  /** Experiment-specific parameters.toml codec (defaults to the shared one). */
  codec?: ParameterCodec;
}

export const ParametersImportModal: React.FC<ParametersImportModalProps> = ({
  isOpen,
  onClose,
  onImport,
  codec = DEFAULT_PARAMETER_CODEC,
}) => {
  const [tomlText, setTomlText] = useState('');
  const [error, setError] = useState('');
  const [treatCommentsAsExclusions, setTreatCommentsAsExclusions] = useState(false);
  // Obsolete .tc DWP/DWM: never converted silently; the user picks convert or keep.
  const [tcChoice, setTcChoice] = useState<'convert' | 'keep' | null>(null);
  const legacyTc = useMemo(() => scanLegacyTc(tomlText), [tomlText]);
  const needsTcChoice = legacyTc.rows.length > 0 && tcChoice === null;
  const legacy = useMemo(() => {
    const excluded = migrateLegacyCommentExclusions(tomlText).excluded;
    return { count: excluded.length, generated: isResoflowGenerated(tomlText) };
  }, [tomlText]);

  if (!isOpen) return null;

  const handleExecuteImport = () => {
    if (!tomlText.trim()) {
      setError('Please provide TOML content to import.');
      return;
    }
    try {
      // resoFlow-written files: commented residue lines are old exclusions. Foreign files: only on request.
      const text = legacyTc.rows.length > 0 && tcChoice === 'convert' ? convertLegacyTc(tomlText) : tomlText;
      const { config, unparsed, legacyExcluded, warnings } = parseWithLegacyExclusions(
        codec.fromToml,
        text,
        legacy.generated ? true : treatCommentsAsExclusions
      );
      const globalCount = Object.keys(config.globals || {}).length;
      const residueCount = Object.keys(config.residues || {}).length;

      if (globalCount === 0 && residueCount === 0) {
        setError('No valid [GLOBAL] or residue sections found in the provided TOML.');
        return;
      }

      onImport(config, unparsed, legacyExcluded, warnings ?? []);
      setTomlText('');
      setTreatCommentsAsExclusions(false);
      setTcChoice(null);
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
                setTcChoice(null);
                if (error) setError('');
              }}
              placeholder={`# Example parameters.toml\n[GLOBAL]\nPB = 0.05\nKEX_AB = 500\nTAUC_A = 4\n\n[CS_A]\n13N = 112.444\n\n[DW_AB]\n13N = 2.500`}
              className="w-full text-xs font-mono p-3 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 leading-relaxed resize-y"
            />
          </div>

          {legacyTc.rows.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 space-y-2">
              <p>
                <strong>Obsolete .tc parameters (DWP/DWM).</strong> ChemEx 2026.9 removed them with no alias and refuses the
                file. Convert with DW0_AX = DWP_AX + TREF·DWM_AX and DW1_AX = DWM_AX, using TREF = {legacyTc.tref} °C
                {legacyTc.trefFromFile ? ' (from the file)' : ' (ChemEx default; the file sets none)'}.
              </p>
              <div className="overflow-x-auto max-h-40">
                <table className="text-[11px] font-mono" aria-label="DWP/DWM conversion preview">
                  <thead>
                    <tr className="text-left">
                      <th className="pr-3">Residue</th>
                      <th className="pr-3">DWP</th>
                      <th className="pr-3">DWM</th>
                      <th className="pr-3">→ DW0</th>
                      <th className="pr-3">DW1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legacyTc.rows.map(r => (
                      <tr key={`${r.residue}-${r.pair}`}>
                        <td className="pr-3">
                          {r.residue} ({r.pair})
                        </td>
                        <td className="pr-3">{r.dwp ?? '—'}</td>
                        <td className="pr-3">{r.dwm ?? '—'}</td>
                        <td className="pr-3">{Number(r.dw0.toPrecision(6))}</td>
                        <td className="pr-3">
                          {Number(r.dw1.toPrecision(6))}
                          {r.boundsDropped ? ' · bounds dropped' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {legacyTc.rows.some(r => r.boundsDropped) && (
                <p>Bounds change meaning in the new coordinates, so they are not converted: review and set them again.</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTcChoice('convert')}
                  aria-pressed={tcChoice === 'convert'}
                  className={`px-2.5 py-1 rounded-md font-semibold border ${tcChoice === 'convert' ? 'bg-amber-600 text-white border-amber-600' : 'bg-white dark:bg-slate-800 border-amber-300 dark:border-amber-700'}`}
                >
                  Convert to DW0/DW1
                </button>
                <button
                  type="button"
                  onClick={() => setTcChoice('keep')}
                  aria-pressed={tcChoice === 'keep'}
                  className={`px-2.5 py-1 rounded-md font-semibold border ${tcChoice === 'keep' ? 'bg-slate-700 text-white border-slate-700' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'}`}
                >
                  Keep as is
                </button>
              </div>
            </div>
          )}

          {legacy.count > 0 && (
            <div className="p-3 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-800 dark:text-blue-300 flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              {legacy.generated ? (
                <span>
                  This file was written by an older resoFlow: its {legacy.count} commented residue line
                  {legacy.count === 1 ? '' : 's'} will be imported as exclusions.
                </span>
              ) : (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={treatCommentsAsExclusions}
                    onChange={e => setTreatCommentsAsExclusions(e.target.checked)}
                  />
                  <span>
                    Treat {legacy.count} commented residue line{legacy.count === 1 ? '' : 's'} as exclusions (old resoFlow
                    convention). Otherwise they stay comments.
                  </span>
                </label>
              )}
            </div>
          )}
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
            disabled={!tomlText.trim() || needsTcChoice}
            title={needsTcChoice ? 'Choose whether to convert the obsolete DWP/DWM parameters first' : undefined}
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
