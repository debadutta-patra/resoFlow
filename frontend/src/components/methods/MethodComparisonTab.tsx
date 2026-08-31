import React from 'react';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { parseParameterLabel } from '../../lib/parameterSymbols';

interface MethodComparisonTabProps {
  methods: Record<string, any>;
  onSelectParameter?: (paramName: string) => void;
}

export const MethodComparisonTab: React.FC<MethodComparisonTabProps> = ({
  methods,
  onSelectParameter,
}) => {
  const methodKeys = Object.keys(methods).filter(k => !!methods[k] && !!methods[k].summary);

  if (methodKeys.length === 0) {
    return (
      <div className="p-8 text-center text-slate-400 text-sm">
        No completed sampling methods available for comparison.
      </div>
    );
  }

  // Aggregate all unique parameters across all methods
  const paramSet = new Set<string>();
  methodKeys.forEach(k => {
    const sum = methods[k].summary || {};
    Object.keys(sum).forEach(p => paramSet.add(p));
  });

  const allParams = Array.from(paramSet).sort((a, b) => {
    const labelA = parseParameterLabel(a);
    const labelB = parseParameterLabel(b);
    if (labelA.category === 'global' && labelB.category !== 'global') return -1;
    if (labelA.category !== 'global' && labelB.category === 'global') return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
          Cross-Technique Method Comparison (MC vs Bootstrap vs MCMC)
        </h4>
        <span className="text-xs text-slate-400">
          Comparing {methodKeys.length} techniques across {allParams.length} parameters
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left text-xs border-collapse font-mono">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
              <th className="py-2.5 px-3.5 sticky left-0 bg-slate-50 dark:bg-slate-800/80 z-10">
                Parameter
              </th>
              <th className="py-2.5 px-3">Residue</th>
              {methodKeys.map(k => (
                <th key={k} className="py-2.5 px-3 text-center border-l border-slate-200 dark:border-slate-800">
                  <div className="font-bold text-slate-800 dark:text-slate-200">
                    {methods[k].method_name}
                  </div>
                  <div className="text-[10px] font-normal text-slate-400">
                    N = {methods[k].sample_count || methods[k].retained_samples || '—'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {allParams.map(paramName => {
              const parsed = parseParameterLabel(paramName);
              return (
                <tr
                  key={paramName}
                  onClick={() => onSelectParameter && onSelectParameter(paramName)}
                  className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                >
                  <td className="py-2.5 px-3.5 font-bold text-slate-900 dark:text-white sticky left-0 bg-white dark:bg-slate-900 z-10">
                    <div className="flex items-center gap-1.5">
                      <span>{parsed.displaySymbol}</span>
                      <span className="text-[10px] text-slate-400 font-normal">
                        ({parsed.unit || '—'})
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                    {parsed.residue}
                  </td>
                  {methodKeys.map(k => {
                    const pStat = methods[k].summary?.[paramName];
                    if (!pStat) {
                      return (
                        <td
                          key={k}
                          className="py-2.5 px-3 text-center text-slate-400 border-l border-slate-100 dark:border-slate-800/60"
                        >
                          —
                        </td>
                      );
                    }
                    const median = pStat.median ?? pStat.mean;
                    const sd = pStat.standard_deviation ?? pStat.std_dev ?? pStat.std;
                    const low = pStat.percentile_95_lower ?? pStat.eti_95_lower ?? pStat.interval_95_lower;
                    const high = pStat.percentile_95_upper ?? pStat.eti_95_upper ?? pStat.interval_95_upper;

                    return (
                      <td
                        key={k}
                        className="py-2.5 px-3 text-center border-l border-slate-100 dark:border-slate-800/60"
                      >
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          {formatUncertainty(median, sd).formatted}
                        </div>
                        {low !== undefined && high !== undefined && (
                          <div className="text-[10px] text-indigo-600 dark:text-indigo-400">
                            [{formatUncertainty(low, null).formatted}, {formatUncertainty(high, null).formatted}]
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MethodComparisonTab;
