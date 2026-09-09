import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Database,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  Info,
  Play,
  X,
} from 'lucide-react';
import api from '../services/api';
import Plot, { PLOT_COLORS } from './Plot';
import {
  checkFieldConsistency,
  constantsPayload,
  defaultConstantsForm,
  DELTA_SIGMA_PRESETS,
  eligibleSources,
  errorEllipse,
  filterResidues,
  includedResidues,
  R_NH_PRESETS,
  R2_PROVENANCE_OPTIONS,
  r2SourceType,
  rigidRotorCurve,
  sortResidues,
  validateConstants,
  type ConstantsForm,
  type R2Provenance,
  type SdmResidue,
  type SortKey,
  type SourceAnalysisOption,
} from '../lib/spectralDensity';

interface SdmAnalysisManagerProps {
  /** The SDM analysis row, created the standard way via POST /analysis. */
  analysis: { analysis_uuid: string; name: string; status: string; parameters?: string | null; experimental?: boolean };
  projectUuid: string;
  /** Every analysis in the project; sources are filtered out of this. */
  analyses: SourceAnalysisOption[];
  onUpdate?: () => void;
}

interface SdmResults {
  b0_h_mhz: number;
  variant: string;
  error_method: string;
  rex_source: string;
  experimental: boolean;
  experimental_notice: string | null;
  j0_caveat: string;
  constants_snapshot: Record<string, number | string>;
  physics_snapshot: Record<string, number | string>;
  summary: {
    tau_c_estimate_ns: number | null;
    j0_trimmed_mean: number;
    jwn_trimmed_mean: number;
    jh_trimmed_mean: number;
    n_residues: number;
    n_flagged: number;
    n_excluded: number;
    flag_counts: Record<string, number>;
    flag_descriptions: Record<string, string>;
    systematic_band: {
      description: string;
      j0_fractional: number;
      j_wn_fractional: number;
      j_h_fractional: number;
    };
  };
  residues: SdmResidue[];
  excluded_residues: Array<{ residue: string; res_num: number | null; reason: string }>;
}

interface SdmAnalysis {
  analysis_uuid: string;
  name: string;
  status: string;
  experimental: boolean;
  created_at: string | null;
  error_message: string | null;
  results?: SdmResults | null;
}

const inputCls =
  'w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200';
const labelCls =
  'block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1 uppercase tracking-wider';
const sectionCls =
  'bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700';

/** Shown wherever numbers from an experimental analysis are rendered. */
const ExperimentalBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-[10px] font-black uppercase tracking-wider border border-amber-300 dark:border-amber-700 ${className}`}
  >
    <FlaskConical className="w-3 h-3" />
    Experimental
  </span>
);

export const SdmAnalysisManager: React.FC<SdmAnalysisManagerProps> = ({
  analysis,
  projectUuid,
  analyses,
  onUpdate,
}) => {
  const [selected, setSelected] = useState<SdmAnalysis | null>(null);
  const [excludedResidues, setExcludedResidues] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState('');
  const [rexEnabled, setRexEnabled] = useState(false);
  const [rexFlagName, setRexFlagName] = useState('');

  const [r1Uuid, setR1Uuid] = useState('');
  const [r2Uuid, setR2Uuid] = useState('');
  const [noeUuid, setNoeUuid] = useState('');
  const [constants, setConstants] = useState<ConstantsForm>(defaultConstantsForm());
  const [variant, setVariant] = useState('farrow1995');
  const [errorMethod, setErrorMethod] = useState<'analytic' | 'monte_carlo'>('analytic');
  const [nReplicates, setNReplicates] = useState('2000');
  const [rexSource, setRexSource] = useState<'none' | 'cpmg_analysis' | 'multi_field'>('none');
  // The direct R2 experiment is the default; R2,0 from a CPMG fit is opt-in.
  const [r2Provenance, setR2Provenance] = useState<R2Provenance>('echo_decay');
  // Additional field triples, used only for multi-field consistency.
  const [extraFields, setExtraFields] = useState<
    Array<{ r1: string; r2: string; noe: string }>
  >([]);

  const [query, setQuery] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('res_num');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const r1Options = useMemo(() => eligibleSources(analyses, 'R1'), [analyses]);
  const r2Options = useMemo(
    () => eligibleSources(analyses, r2SourceType(r2Provenance)),
    [analyses, r2Provenance],
  );
  const noeOptions = useMemo(() => eligibleSources(analyses, 'hetNOE'), [analyses]);

  // Switching provenance changes which analyses are eligible, so a stale
  // selection must not survive into the request.
  useEffect(() => {
    setR2Uuid('');
  }, [r2Provenance]);

  const chosen = useMemo(
    () => [
      { role: 'R1', source: r1Options.find((a) => a.analysis_uuid === r1Uuid) ?? null },
      { role: 'R2', source: r2Options.find((a) => a.analysis_uuid === r2Uuid) ?? null },
      { role: 'hetNOE', source: noeOptions.find((a) => a.analysis_uuid === noeUuid) ?? null },
    ],
    [r1Options, r2Options, noeOptions, r1Uuid, r2Uuid, noeUuid],
  );

  // A multi-field CPMG fit legitimately spans several fields, and the backend
  // picks the R2,0 block matching R1/hetNOE. Comparing it against an
  // arbitrary one of its own fields here would reject a valid setup, so the
  // CPMG source sits out of this check.
  const fieldCheck = useMemo(
    () =>
      checkFieldConsistency(
        r2Provenance === 'cpmg_r2_0'
          ? chosen.filter((c) => c.role !== 'R2')
          : chosen,
      ),
    [chosen, r2Provenance],
  );
  const constantIssues = useMemo(() => validateConstants(constants), [constants]);
  const canRun =
    !!r1Uuid && !!r2Uuid && !!noeUuid && fieldCheck.ok && constantIssues.length === 0 && !isRunning;
  const r2Option = R2_PROVENANCE_OPTIONS.find((o) => o.value === r2Provenance)!;

  useEffect(() => {
    // Absent keys mean "disabled", so an older server never enables a
    // control the backend would reject.
    api
      .get('/api/capabilities')
      .then((res) => {
        setRexEnabled(Boolean(res.data?.features?.experimental_sdm_rex));
        setRexFlagName(String(res.data?.flags?.experimental_sdm_rex ?? ''));
      })
      .catch(() => setRexEnabled(false));
  }, []);

  // Restore the saved configuration and exclusions, the way every other
  // analysis module reads its own analysis.parameters.
  useEffect(() => {
    if (!analysis.parameters) return;
    try {
      const params = JSON.parse(analysis.parameters);
      setExcludedResidues(params.excludedResidues || []);
      if (params.source_r1_analysis_uuid) setR1Uuid(params.source_r1_analysis_uuid);
      if (params.source_r2_analysis_uuid) setR2Uuid(params.source_r2_analysis_uuid);
      if (params.source_noe_analysis_uuid) setNoeUuid(params.source_noe_analysis_uuid);
      if (params.variant) setVariant(params.variant);
      if (params.error_method) setErrorMethod(params.error_method);
      if (params.r2_provenance) setR2Provenance(params.r2_provenance);
      if (params.rex_source) setRexSource(params.rex_source);
      if (params.constants) {
        const c = params.constants;
        setConstants({
          mode: c.r_nh_angstrom != null ? 'custom' : 'preset',
          rNhPreset: c.r_nh_preset ?? '1.02',
          deltaSigmaPreset: c.delta_sigma_preset ?? '-160',
          rNhAngstrom: String(c.r_nh_angstrom ?? '1.02'),
          deltaSigmaPpm: String(c.delta_sigma_ppm ?? '-160'),
        });
      }
    } catch {
      // A malformed parameters blob should not stop the panel rendering.
    }
  }, [analysis.parameters]);

  const fetchResults = React.useCallback(() => {
    if (analysis.status !== 'COMPLETED') return;
    api
      .get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/sdm/results`)
      .then((res) => setSelected(res.data))
      .catch(() => undefined);
  }, [projectUuid, analysis.analysis_uuid, analysis.status]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const handleToggleResidueExclusion = async (assignment: string) => {
    try {
      const params = JSON.parse(analysis.parameters || '{}');
      const current: string[] = params.excludedResidues || [];
      const next = current.includes(assignment)
        ? current.filter((a) => a !== assignment)
        : [...current, assignment];
      params.excludedResidues = next;
      await api.put(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}`, {
        parameters: JSON.stringify(params),
      });
      setExcludedResidues(next);
      // Exclusions are applied server-side on read, so refetching brings back
      // a summary that matches the residues now shown.
      const res = await api.get(
        `/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/sdm/results`,
      );
      setSelected(res.data);
      onUpdate?.();
    } catch (err) {
      setError('Could not update the excluded residues');
    }
  };

  const handleRun = async () => {
    setIsRunning(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        name: analysis.name,
        source_r1_analysis_uuid: r1Uuid,
        source_r2_analysis_uuid: r2Uuid,
        source_noe_analysis_uuid: noeUuid,
        constants: constantsPayload(constants),
        variant,
        error_method: errorMethod,
        n_replicates: Number(nReplicates) || 2000,
        r2_provenance: r2Provenance,
      };
      if (rexEnabled && rexSource !== 'none') {
        body.rex_source = rexSource;
        if (rexSource === 'multi_field') {
          body.additional_field_sources = extraFields.map((f) => ({
            source_r1_analysis_uuid: f.r1,
            source_r2_analysis_uuid: f.r2,
            source_noe_analysis_uuid: f.noe,
          }));
        }
      }
      const res = await api.post(
        `/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/sdm/run`,
        body,
      );
      setSelected(res.data);
      onUpdate?.();
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : detail?.message || 'Mapping failed');
    } finally {
      setIsRunning(false);
    }
  };

  const results = selected?.results ?? null;
  const isExperimental = Boolean(selected?.experimental);
  const isMultiField =
    (results as unknown as { mode?: string } | null)?.mode === 'multi_field';

  const visibleResidues = useMemo(() => {
    if (!results || isMultiField) return [];
    return sortResidues(filterResidues(results.residues, query, flaggedOnly), sortKey, sortDir);
  }, [results, isMultiField, query, flaggedOnly, sortKey, sortDir]);

  // Plots draw only the included residues, so what is drawn matches the
  // summary above it. The table keeps the excluded rows, greyed out.
  const plottedResidues = useMemo(
    () => (results && !isMultiField ? includedResidues(results.residues) : []),
    [results, isMultiField],
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return (
    <div className="space-y-8">
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-start justify-between text-red-700 dark:text-red-400 text-sm">
          <div className="flex items-start space-x-3 flex-1">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-500" />
            <div className="font-medium leading-relaxed">{error}</div>
          </div>
          <button onClick={() => setError('')} className="p-1 text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ---------------- Setup panel ---------------- */}
      <section className={sectionCls}>
        <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest mb-4">
          Setup
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelCls} htmlFor="sdm-variant">Variant</label>
            <select
              id="sdm-variant"
              className={inputCls}
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
            >
              <option value="farrow1995">farrow1995 — J(0.87 ω_H)</option>
            </select>
          </div>
        </div>

        <div className="mb-4">
          <label className={labelCls} htmlFor="sdm-r2-provenance">R₂ source type</label>
          <select
            id="sdm-r2-provenance"
            className={inputCls}
            value={r2Provenance}
            onChange={(e) => setR2Provenance(e.target.value as R2Provenance)}
          >
            {R2_PROVENANCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">{r2Option.hint}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {([
            ['R1 source', r1Uuid, setR1Uuid, r1Options, 'sdm-r1'],
            [r2Option.sourceType === 'CPMG' ? 'CPMG fit (R₂,₀)' : 'R2 source',
             r2Uuid, setR2Uuid, r2Options, 'sdm-r2'],
            ['hetNOE source', noeUuid, setNoeUuid, noeOptions, 'sdm-noe'],
          ] as const).map(([label, value, setter, options, id]) => (
            <div key={id}>
              <label className={labelCls} htmlFor={id}>{label}</label>
              <select
                id={id}
                className={inputCls}
                value={value}
                onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              >
                <option value="">Select…</option>
                {(options as SourceAnalysisOption[]).map((a) => (
                  <option key={a.analysis_uuid} value={a.analysis_uuid}>
                    {a.name} {a.b0 != null ? `(${a.b0.toFixed(2)} MHz)` : '(no B₀)'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {fieldCheck.message && (
          <div
            role="alert"
            className="mt-4 p-3.5 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-start gap-2.5 text-xs text-red-800 dark:text-red-300"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            <div>
              <span className="font-bold">Static field mismatch: </span>
              {fieldCheck.message}
            </div>
          </div>
        )}
        {fieldCheck.ok && fieldCheck.b0 != null && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            All three sources at <strong>{fieldCheck.b0.toFixed(2)} MHz</strong> (¹H).
          </p>
        )}

        {/* Constants */}
        <div className="mt-6">
          <div className="flex items-center gap-4 mb-3">
            <span className={labelCls.replace('mb-1', 'mb-0')}>Constants</span>
            {(['preset', 'custom'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                <input
                  type="radio"
                  name="constants-mode"
                  checked={constants.mode === mode}
                  onChange={() => setConstants({ ...constants, mode })}
                />
                {mode === 'preset' ? 'Presets' : 'Custom'}
              </label>
            ))}
          </div>

          {constants.mode === 'preset' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelCls} htmlFor="sdm-rnh-preset">r<sub>NH</sub> (Å)</label>
                <select
                  id="sdm-rnh-preset"
                  className={inputCls}
                  value={constants.rNhPreset}
                  onChange={(e) => setConstants({ ...constants, rNhPreset: e.target.value })}
                >
                  {R_NH_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="sdm-csa-preset">Δσ (ppm)</label>
                <select
                  id="sdm-csa-preset"
                  className={inputCls}
                  value={constants.deltaSigmaPreset}
                  onChange={(e) => setConstants({ ...constants, deltaSigmaPreset: e.target.value })}
                >
                  {DELTA_SIGMA_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelCls} htmlFor="sdm-rnh">r<sub>NH</sub> (Å)</label>
                <input
                  id="sdm-rnh"
                  className={inputCls}
                  value={constants.rNhAngstrom}
                  onChange={(e) => setConstants({ ...constants, rNhAngstrom: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="sdm-csa">Δσ (ppm)</label>
                <input
                  id="sdm-csa"
                  className={inputCls}
                  value={constants.deltaSigmaPpm}
                  onChange={(e) => setConstants({ ...constants, deltaSigmaPpm: e.target.value })}
                />
              </div>
            </div>
          )}

          {constantIssues.length > 0 && (
            <ul role="alert" className="mt-3 space-y-1">
              {constantIssues.map((issue) => (
                <li key={issue.field} className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Error method */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelCls} htmlFor="sdm-error-method">Error method</label>
            <select
              id="sdm-error-method"
              className={inputCls}
              value={errorMethod}
              onChange={(e) => setErrorMethod(e.target.value as 'analytic' | 'monte_carlo')}
            >
              <option value="analytic">Analytic (exact for Gaussian inputs)</option>
              <option value="monte_carlo">Monte Carlo (cross-check)</option>
            </select>
          </div>
          {errorMethod === 'monte_carlo' && (
            <div>
              <label className={labelCls} htmlFor="sdm-replicates">Replicates</label>
              <input
                id="sdm-replicates"
                className={inputCls}
                value={nReplicates}
                onChange={(e) => setNReplicates(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Rex controls: hidden entirely unless the server enables the flag. */}
        {rexEnabled && (
          <div className="mt-6 p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
            <div className="flex items-center gap-3 mb-3">
              <label className={labelCls.replace('mb-1', 'mb-0')} htmlFor="sdm-rex">
                R<sub>ex</sub> correction
              </label>
              <ExperimentalBadge />
            </div>
            <select
              id="sdm-rex"
              className={inputCls}
              value={rexSource}
              onChange={(e) => setRexSource(e.target.value as typeof rexSource)}
            >
              <option value="none">None (production)</option>
              <option value="cpmg_analysis">Subtract R_ex from a CPMG run</option>
              <option value="multi_field">Multi-field consistency</option>
            </select>
            <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
              Enabled by <code>{rexFlagName}</code>. Results are marked experimental
              everywhere they appear, including exports and reports.
            </p>

            {rexSource === 'multi_field' && (
              <div className="mt-4 space-y-3">
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  The three sources above are the first field. Add at least one more
                  at a <strong>different</strong> static field — the surplus degree of
                  freedom is what the χ² test uses. Three or more fields are needed
                  before a scaling exponent α can be reported at all.
                </p>
                {extraFields.map((entry, index) => (
                  <div key={index} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                    {(['r1', 'r2', 'noe'] as const).map((role) => {
                      const options = role === 'r1' ? r1Options
                        : role === 'r2' ? eligibleSources(analyses, 'R2') : noeOptions;
                      return (
                        <div key={role}>
                          <label className={labelCls} htmlFor={`extra-${index}-${role}`}>
                            {role === 'noe' ? 'hetNOE' : role.toUpperCase()} (field {index + 2})
                          </label>
                          <select
                            id={`extra-${index}-${role}`}
                            className={inputCls}
                            value={entry[role]}
                            onChange={(e) => {
                              const next = [...extraFields];
                              next[index] = { ...next[index], [role]: e.target.value };
                              setExtraFields(next);
                            }}
                          >
                            <option value="">Select…</option>
                            {options.map((a) => (
                              <option key={a.analysis_uuid} value={a.analysis_uuid}>
                                {a.name} {a.b0 != null ? `(${a.b0.toFixed(2)} MHz)` : '(no B₀)'}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => setExtraFields(extraFields.filter((_, i) => i !== index))}
                      className="px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setExtraFields([...extraFields, { r1: '', r2: '', noe: '' }])}
                  className="px-3 py-1.5 text-xs font-bold text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30"
                >
                  + Add a field
                </button>
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleRun}
          disabled={!canRun}
          className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl border transition-all shadow-sm active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 border-indigo-200 dark:border-indigo-800"
        >
          <Play className="w-4 h-4" />
          {isRunning ? 'Mapping…' : 'Run mapping'}
        </button>
      </section>

      {/* ---------------- Results ---------------- */}
      {results && (
        <>
          {isExperimental && (
            <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 flex items-start gap-3">
              <FlaskConical className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
              <div className="text-sm text-amber-900 dark:text-amber-200">
                <strong>Experimental analysis.</strong> {results.experimental_notice}
              </div>
            </div>
          )}

          {isMultiField ? (
            <MultiFieldResults results={results as unknown as MultiFieldResultsShape} />
          ) : (
            <>
              <SummaryCard results={results} experimental={isExperimental} />

          <section className={sectionCls}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
                Spectral densities
              </h3>
              {isExperimental && <ExperimentalBadge />}
            </div>
            <ProfilePlots residues={plottedResidues} />
          </section>

          <section className={sectionCls}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
                J(0) vs J(ω<sub>N</sub>)
              </h3>
              {isExperimental && <ExperimentalBadge />}
            </div>
            {/* The caveat sits next to the plot, not only in the docs: J(0) is
                where exchange lands and what users over-interpret. */}
            <div className="mb-4 p-3.5 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-start gap-2.5">
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-500" />
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {results.j0_caveat}
              </p>
            </div>
            <CorrelationPlot
              residues={plottedResidues}
              omegaN={Number(results.physics_snapshot?.omega_n_rad_s ?? 0)}
            />
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              Ellipses are 1σ contours from the full covariance, not independent error
              bars — J(0) and J(ω<sub>N</sub>) are correlated by construction.
            </p>
          </section>

              <ResidueTable
                residues={visibleResidues}
                total={results.residues.length}
                excluded={results.excluded_residues}
                flagDescriptions={results.summary.flag_descriptions}
                query={query}
                onQuery={setQuery}
                flaggedOnly={flaggedOnly}
                onFlaggedOnly={setFlaggedOnly}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={toggleSort}
                experimental={isExperimental}
                projectUuid={projectUuid}
                analysisUuid={analysis.analysis_uuid}
                excludedResidues={excludedResidues}
                onToggleExclusion={handleToggleResidueExclusion}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};

interface MultiFieldResultsShape {
  fields_mhz: number[];
  multifield_caveat: string;
  experimental_notice: string | null;
  summary: {
    n_fields: number;
    dof: number;
    n_residues: number;
    n_exchange_flagged: number;
    median_chi2: number | null;
    median_alpha: number | null;
    scaling_available: boolean;
    scaling_unavailable_reason: string | null;
    n_excluded: number;
  };
  residues: Array<{
    assignment: string;
    res_num: number | null;
    j0: number;
    j0_err: number;
    chi2: number;
    p_value: number;
    scaling_exponent: { alpha: number; alpha_err: number | null } | null;
    per_field: Array<{ b0_h_mhz: number; r2: number; r2_residual: number }>;
  }>;
  excluded_residues: Array<{ residue: string; reason: string }>;
}

/**
 * Multi-field consistency results.
 *
 * A different shape from a single-field run -- per-field blocks and a
 * chi-square rather than one J triple with a covariance -- so it gets its own
 * view rather than being forced through the single-field one.
 */
const MultiFieldResults: React.FC<{ results: MultiFieldResultsShape }> = ({ results }) => {
  const s = results.summary;
  const flagged = results.residues.filter((r) => r.p_value < 0.05);

  return (
    <>
      <section className={sectionCls}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
            Exchange test
          </h3>
          <ExperimentalBadge />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Fields" value={results.fields_mhz.map((f) => f.toFixed(1)).join(' / ')} hint="MHz (¹H)" />
          <Stat label="Deg. of freedom" value={String(s.dof)} hint="n_fields − 1" />
          <Stat label="p < 0.05" value={`${s.n_exchange_flagged} / ${s.n_residues}`} hint="exchange implicated" />
          <Stat
            label="Median χ²"
            value={s.median_chi2 != null ? s.median_chi2.toFixed(2) : '—'}
          />
        </div>

        <div className="mt-5 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700">
          <p className="text-xs font-bold text-amber-900 dark:text-amber-300 uppercase tracking-wider mb-1">
            What this test cannot see
          </p>
          <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
            {results.multifield_caveat}
          </p>
        </div>

        <div className="mt-4 p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          {s.scaling_available ? (
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              <strong>Scaling exponent.</strong> Median α ={' '}
              {s.median_alpha != null ? s.median_alpha.toFixed(2) : '—'}. α is fitted
              freely in [0, 2] and reported, never fixed at 2 — R<sub>ex</sub> ∝ B₀²
              holds only in the fast-exchange limit, and α is itself the diagnostic
              of the exchange time scale.
            </p>
          ) : (
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              <strong>No scaling exponent.</strong> {s.scaling_unavailable_reason}
            </p>
          )}
        </div>
      </section>

      <section className={sectionCls}>
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
            Per-residue
          </h3>
          <ExperimentalBadge />
          <span className="text-xs text-slate-400">{flagged.length} flagged</span>
        </div>
        <div className="max-h-[520px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <table className="w-full text-left text-sm border-collapse">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
              <tr>
                {['Residue', 'J(0)', 'χ²', 'p', 'α'].map((h) => (
                  <th key={h} className="px-4 py-3 font-black uppercase tracking-tighter text-[10px] text-slate-400">
                    {h}
                  </th>
                ))}
                {results.fields_mhz.map((f) => (
                  <th key={f} className="px-4 py-3 font-black uppercase tracking-tighter text-[10px] text-slate-400">
                    R₂ resid. @{f.toFixed(0)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {results.residues.map((r) => (
                <tr
                  key={r.assignment}
                  className={r.p_value < 0.05 ? 'bg-amber-50/60 dark:bg-amber-900/10' : ''}
                >
                  <td className="px-4 py-2.5 font-bold text-slate-900 dark:text-slate-200">{r.assignment}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.j0.toFixed(3)} ± {r.j0_err.toFixed(3)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.chi2.toFixed(2)}</td>
                  <td className={`px-4 py-2.5 font-mono text-xs ${r.p_value < 0.05 ? 'font-bold text-amber-700 dark:text-amber-400' : ''}`}>
                    {r.p_value.toFixed(4)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {r.scaling_exponent ? r.scaling_exponent.alpha.toFixed(2) : '—'}
                  </td>
                  {r.per_field.map((entry) => (
                    <td key={entry.b0_h_mhz} className="px-4 py-2.5 font-mono text-xs">
                      {entry.r2_residual.toFixed(3)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          J(0) in ns rad⁻¹. R₂ residuals are determined only up to a field-independent
          constant that J(0) has absorbed — differences between fields are meaningful,
          absolute values are not.
        </p>

        {results.excluded_residues.length > 0 && (
          <div className="mt-5">
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
              Excluded residues ({results.excluded_residues.length})
            </p>
            <ul className="space-y-1">
              {results.excluded_residues.map((item) => (
                <li key={item.residue} className="text-xs text-slate-600 dark:text-slate-400">
                  <strong>{item.residue}</strong> — {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
};


const SummaryCard: React.FC<{ results: SdmResults; experimental: boolean }> = ({
  results,
  experimental,
}) => {
  const s = results.summary;
  const band = s.systematic_band;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <section className={sectionCls}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
          Summary
        </h3>
        {experimental && <ExperimentalBadge />}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat
          label="τc estimate"
          value={s.tau_c_estimate_ns != null ? `${s.tau_c_estimate_ns.toFixed(2)} ns` : '—'}
          hint="from ⟨J(0)⟩/⟨J(ωN)⟩, trimmed"
        />
        <Stat label="Residues mapped" value={String(s.n_residues)} />
        <Stat label="Flagged" value={String(s.n_flagged)} hint="advisory, not dropped" />
        <Stat label="Excluded" value={String(s.n_excluded)} hint="not in all three sources" />
      </div>

      <div className="mt-5 p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1">
          Systematic band from the constants choice
        </p>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          J(0) ±{pct(band.j0_fractional)}, J(ω<sub>N</sub>) ±{pct(band.j_wn_fractional)},
          J(0.87ω<sub>H</sub>) ±{pct(band.j_h_fractional)} &nbsp;({band.description}).
          This shifts every residue coherently in the same direction and is
          <strong> not</strong> included in the per-residue error bars, which carry
          statistical uncertainty only.
        </p>
      </div>

      <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
        {results.b0_h_mhz.toFixed(2)} MHz (¹H) · variant <code>{results.variant}</code> ·
        r<sub>NH</sub> {String(results.constants_snapshot.r_nh_angstrom)} Å ·
        Δσ {String(results.constants_snapshot.delta_sigma_ppm)} ppm ·
        errors <code>{results.error_method}</code>
      </p>
    </section>
  );
};

const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none">
      {label}
    </p>
    <p className="text-lg font-mono font-bold text-slate-900 dark:text-white mt-1.5">{value}</p>
    {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
  </div>
);

const NoResiduesNotice: React.FC = () => (
  <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
    Every residue is excluded — nothing to plot. Re-include one from the table
    below.
  </div>
);

const ProfilePlots: React.FC<{ residues: SdmResidue[] }> = ({ residues }) => {
  if (residues.length === 0) return <NoResiduesNotice />;
  const x = residues.map((r) => r.res_num ?? 0);
  const panels: Array<[string, number[], number[], string]> = [
    ['J(0)', residues.map((r) => r.j0), residues.map((r) => r.j0_err), PLOT_COLORS.primary],
    ['J(ω_N)', residues.map((r) => r.j_wn), residues.map((r) => r.j_wn_err), PLOT_COLORS.success],
    ['J(0.87ω_H)', residues.map((r) => r.j_h), residues.map((r) => r.j_h_err), PLOT_COLORS.warning],
  ];
  return (
    <div className="space-y-4">
      {panels.map(([label, y, err, color]) => (
        <div key={label} className="h-[220px]">
          <Plot
            data={[
              {
                x,
                y,
                error_y: { type: 'data', array: err, visible: true, thickness: 1, width: 2 },
                type: 'scatter',
                mode: 'markers+lines',
                marker: { color, size: 6 },
                line: { color, width: 1 },
                name: label,
              },
            ]}
            layout={{
              margin: { l: 70, r: 20, b: 40, t: 24 },
              xaxis: { title: { text: 'Residue number' } },
              yaxis: { title: { text: `${label} (ns rad⁻¹)` } },
              showlegend: false,
            }}
          />
        </div>
      ))}
    </div>
  );
};

const CorrelationPlot: React.FC<{ residues: SdmResidue[]; omegaN: number }> = ({
  residues,
  omegaN,
}) => {
  // Math.min of an empty list is Infinity, which would poison the axis
  // bounds and the rigid-rotor curve.
  if (residues.length === 0) return <NoResiduesNotice />;
  const j0 = residues.map((r) => r.j0);
  const jwn = residues.map((r) => r.j_wn);
  const lo = Math.min(...j0) * 0.5;
  const hi = Math.max(...j0) * 1.25;
  const curve = rigidRotorCurve(omegaN, lo, hi);

  // Covariance rows/columns are ordered [J(0), J(wN), J_h]; the plot puts
  // J(wN) on x and J(0) on y, so the block is picked out accordingly.
  const ellipses = residues.map((r) => {
    const c = r.covariance ?? [];
    const cJ0 = c?.[0]?.[0] ?? 0;
    const cJwn = c?.[1]?.[1] ?? 0;
    const cCross = c?.[0]?.[1] ?? 0;
    return errorEllipse(r.j_wn, r.j0, cJwn, cJ0, cCross, 1, 40);
  });

  return (
    <div className="h-[440px]">
      <Plot
        data={[
          ...ellipses.map((e) => ({
            x: e.x,
            y: e.y,
            type: 'scatter' as const,
            mode: 'lines' as const,
            line: { color: PLOT_COLORS.primary, width: 1 },
            opacity: 0.35,
            hoverinfo: 'skip' as const,
            showlegend: false,
          })),
          {
            x: curve.jwn,
            y: curve.j0,
            type: 'scatter',
            mode: 'lines',
            line: { color: PLOT_COLORS.neutral, width: 2, dash: 'dash' },
            name: 'Rigid isotropic rotor',
          },
          {
            x: jwn,
            y: j0,
            type: 'scatter',
            mode: 'markers',
            marker: { color: PLOT_COLORS.primary, size: 7 },
            text: residues.map((r) => r.assignment),
            hovertemplate: '%{text}<br>J(ωN)=%{x:.4f}<br>J(0)=%{y:.3f}<extra></extra>',
            name: 'Residues',
          },
        ]}
        layout={{
          margin: { l: 70, r: 20, b: 50, t: 24 },
          xaxis: { title: { text: 'J(ω_N) (ns rad⁻¹)' } },
          yaxis: { title: { text: 'J(0) (ns rad⁻¹)' } },
          legend: { orientation: 'h', y: -0.2 },
        }}
      />
    </div>
  );
};

interface ResidueTableProps {
  residues: SdmResidue[];
  total: number;
  excluded: Array<{ residue: string; res_num: number | null; reason: string }>;
  flagDescriptions: Record<string, string>;
  query: string;
  onQuery: (v: string) => void;
  flaggedOnly: boolean;
  onFlaggedOnly: (v: boolean) => void;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  experimental: boolean;
  projectUuid: string;
  analysisUuid: string;
  excludedResidues: string[];
  onToggleExclusion: (assignment: string) => void;
}

const COLUMNS: Array<[SortKey, string]> = [
  ['res_num', 'Res #'],
  ['assignment', 'Assignment'],
  ['j0', 'J(0)'],
  ['j_wn', 'J(ωN)'],
  ['j_h', 'J(0.87ωH)'],
  ['r1', 'R₁'],
  ['r2', 'R₂'],
  ['noe', 'NOE'],
  ['tau_c', 'τc (ns)'],
];

const ResidueTable: React.FC<ResidueTableProps> = ({
  residues, total, excluded, flagDescriptions, query, onQuery,
  flaggedOnly, onFlaggedOnly, sortKey, sortDir, onSort, experimental,
  projectUuid, analysisUuid, excludedResidues, onToggleExclusion,
}) => (
  <section className={sectionCls}>
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
          Residues
        </h3>
        {experimental && <ExperimentalBadge />}
        <span className="text-xs text-slate-400">{residues.length} of {total}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          className={`${inputCls} w-48`}
          placeholder="Filter residues…"
          aria-label="Filter residues"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => onFlaggedOnly(e.target.checked)}
          />
          Flagged only
        </label>
        <a
          href={`/api/projects/${projectUuid}/spectral-density/${analysisUuid}/export.csv`}
          className="flex items-center px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-[10px] font-black uppercase tracking-widest"
        >
          <Database className="w-3 h-3 mr-2" />
          CSV
        </a>
        <a
          href={`/api/projects/${projectUuid}/spectral-density/${analysisUuid}/report`}
          className="flex items-center px-4 py-2 bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-lg text-[10px] font-black uppercase tracking-widest"
        >
          <FileText className="w-3 h-3 mr-2" />
          Report
        </a>
      </div>
    </div>

    <div className="max-h-[520px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <table className="w-full text-left text-sm border-collapse">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
          <tr>
            <th className="px-4 py-3 w-12" />
            {COLUMNS.map(([key, label]) => (
              <th key={key} className="px-4 py-3">
                <button
                  onClick={() => onSort(key)}
                  className="font-black uppercase tracking-tighter text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
            <th className="px-4 py-3 font-black uppercase tracking-tighter text-[10px] text-slate-400">
              Flags
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {residues.map((r) => {
            const isExcluded = excludedResidues.includes(r.assignment);
            return (
            <tr
              key={r.assignment}
              className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${isExcluded ? 'opacity-40' : ''}`}
            >
              <td className="px-4 py-2.5">
                <button
                  onClick={() => onToggleExclusion(r.assignment)}
                  aria-label={`${isExcluded ? 'Include' : 'Exclude'} ${r.assignment}`}
                  title={isExcluded
                    ? 'Excluded — omitted from the summary and the τc estimate'
                    : 'Included'}
                >
                  {isExcluded
                    ? <EyeOff className="w-4 h-4 text-slate-400" />
                    : <Eye className="w-4 h-4 text-emerald-500" />}
                </button>
              </td>
              <td className="px-4 py-2.5 text-slate-500">{r.res_num ?? '—'}</td>
              <td className="px-4 py-2.5 font-bold text-slate-900 dark:text-slate-200">{r.assignment}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.j0.toFixed(3)} ± {r.j0_err.toFixed(3)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.j_wn.toFixed(4)} ± {r.j_wn_err.toFixed(4)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.j_h.toExponential(2)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.r1.toFixed(3)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.r2.toFixed(3)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{r.noe.toFixed(3)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">
                {r.tau_c != null ? (r.tau_c * 1e9).toFixed(2) : '—'}
              </td>
              <td className="px-4 py-2.5 text-[10px] text-amber-700 dark:text-amber-400">
                {(r.flags ?? []).join(', ')}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {Object.keys(flagDescriptions).length > 0 && (
      <div className="mt-4">
        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
          Flag meanings
        </p>
        <ul className="space-y-1.5">
          {Object.entries(flagDescriptions).map(([flag, description]) => (
            <li key={flag} className="text-xs text-slate-600 dark:text-slate-400">
              <code className="text-amber-700 dark:text-amber-400">{flag}</code> — {description}
            </li>
          ))}
        </ul>
      </div>
    )}

    {excluded.length > 0 && (
      <div className="mt-5">
        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
          Excluded residues ({excluded.length})
        </p>
        <ul className="space-y-1">
          {excluded.map((item) => (
            <li key={item.residue} className="text-xs text-slate-600 dark:text-slate-400">
              <strong>{item.residue}</strong> — {item.reason}
            </li>
          ))}
        </ul>
      </div>
    )}
  </section>
);

export default SdmAnalysisManager;
