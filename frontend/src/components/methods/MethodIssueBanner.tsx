/**
 * Method checks banner: every issue carries a severity (error blocks Run, warning,
 * info). The banner takes the colour of the highest severity, counts each level,
 * collapses info notes, and offers each issue's quick-fixes and per-step dismissal.
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, RotateCcw, XCircle } from 'lucide-react';
import type { IssueSeverity, ValidationError } from '../../lib/methodValidation';
import { highestSeverity, severityCounts } from '../../lib/methodValidation';
import type { QuickFix } from '../../lib/methodQuickFixes';
import { chemexLocation } from '../../lib/resolvedRoles';

// This theme remaps colours in dark mode (index.css): shades 50–300 become dark tints and
// 700 is the lightest, so text uses -700 in dark mode and backgrounds use the remapped tints.
export const SEVERITY_STYLE: Record<IssueSeverity, { box: string; text: string; icon: string; chip: string }> = {
  error: {
    box: 'bg-red-50 border-red-200 dark:border-red-300',
    text: 'text-red-800 dark:text-red-700',
    icon: 'text-red-600 dark:text-red-500',
    chip: 'bg-red-100 text-red-800 dark:bg-red-200 dark:text-red-700',
  },
  warning: {
    box: 'bg-amber-50 border-amber-200 dark:border-amber-300',
    text: 'text-amber-900 dark:text-amber-700',
    icon: 'text-amber-700 dark:text-amber-500',
    chip: 'bg-amber-100 text-amber-900 dark:bg-amber-200 dark:text-amber-700',
  },
  info: {
    box: 'bg-blue-50 border-blue-200 dark:border-blue-300',
    text: 'text-blue-900 dark:text-blue-700',
    icon: 'text-blue-700 dark:text-blue-500',
    chip: 'bg-blue-100 text-blue-900 dark:bg-blue-200 dark:text-blue-700',
  },
};

const NOUN: Record<IssueSeverity, [string, string]> = {
  error: ['error', 'errors'],
  warning: ['warning', 'warnings'],
  info: ['note', 'notes'],
};

export const severityCountText = (n: number, sev: IssueSeverity) => `${n} ${NOUN[sev][n === 1 ? 0 : 1]}`;

export const SeverityIcon: React.FC<{ severity: IssueSeverity; className?: string }> = ({ severity, className = 'w-3.5 h-3.5' }) => {
  const cls = `${className} ${SEVERITY_STYLE[severity].icon} flex-shrink-0`;
  if (severity === 'error') return <XCircle className={cls} aria-label="error" />;
  if (severity === 'warning') return <AlertTriangle className={cls} aria-label="warning" />;
  return <Info className={cls} aria-label="note" />;
};

export const QuickFixButtons: React.FC<{ actions?: QuickFix[]; onApply: (fix: QuickFix) => void; disabled?: boolean }> = ({
  actions,
  onApply,
  disabled,
}) =>
  !actions || actions.length === 0 ? null : (
    <span className="inline-flex flex-wrap gap-1.5">
      {actions.map(fix => (
        <button
          key={fix.id}
          type="button"
          disabled={disabled}
          title={fix.title}
          onClick={() => onApply(fix)}
          className="px-2 py-0.5 rounded-md text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {fix.label}
        </button>
      ))}
    </span>
  );

const IssueRow: React.FC<{ issue: ValidationError; onApply: (fix: QuickFix) => void; readOnly?: boolean }> = ({ issue, onApply, readOnly }) => {
  const style = SEVERITY_STYLE[issue.severity];
  return (
    <li className={`flex items-start gap-2 text-xs ${style.text}`} data-severity={issue.severity}>
      <SeverityIcon severity={issue.severity} className="w-3.5 h-3.5 mt-0.5" />
      <div className="min-w-0 space-y-1">
        <p>
          <strong>[{issue.stepName}]</strong>{' '}
          {issue.origin === 'chemex' && issue.source && (
            <span className="font-mono opacity-90">
              ChemEx · {chemexLocation({ message: issue.message, type: '', source: issue.source }).replace(/^\[[^\]]*\]\s*/, '') || 'step'}:{' '}
            </span>
          )}
          {issue.message}
        </p>
        {issue.detail && <p className="opacity-90">{issue.detail}</p>}
        <QuickFixButtons actions={issue.actions} onApply={onApply} disabled={readOnly} />
      </div>
    </li>
  );
};

export interface MethodIssueBannerProps {
  issues: ValidationError[];
  dismissed?: Array<ValidationError & { dismissKey: string }>;
  onApplyFix: (fix: QuickFix) => void;
  onRestore?: (stepId: string, key: string) => void;
  readOnly?: boolean;
}

export const MethodIssueBanner: React.FC<MethodIssueBannerProps> = ({ issues, dismissed = [], onApplyFix, onRestore, readOnly }) => {
  const [showInfo, setShowInfo] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const top = highestSeverity(issues);
  if (!top && dismissed.length === 0) return null;
  const counts = severityCounts(issues);
  const style = SEVERITY_STYLE[top ?? 'info'];
  const main = issues.filter(i => i.severity !== 'info');
  const notes = issues.filter(i => i.severity === 'info');

  return (
    <section
      aria-label="Method checks"
      data-severity={top ?? 'none'}
      className={`p-4 rounded-xl border space-y-2 ${top ? style.box : 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700'}`}
    >
      <div className={`flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider ${top ? style.text : 'text-slate-600 dark:text-slate-300'}`}>
        {top && <SeverityIcon severity={top} className="w-4 h-4" />}
        <span>Method checks</span>
        {(['error', 'warning', 'info'] as IssueSeverity[])
          .filter(s => counts[s] > 0)
          .map(s => (
            <span key={s} className={`px-2 py-0.5 rounded-full normal-case tracking-normal font-semibold ${SEVERITY_STYLE[s].chip}`}>
              {severityCountText(counts[s], s)}
            </span>
          ))}
      </div>

      {main.length > 0 && (
        <ul className="space-y-2 pl-1">
          {main.map((issue, i) => (
            <IssueRow key={`${issue.stepId}-${issue.code ?? ''}-${i}`} issue={issue} onApply={onApplyFix} readOnly={readOnly} />
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showInfo}
            onClick={() => setShowInfo(v => !v)}
            className={`flex items-center gap-1 text-xs font-semibold ${SEVERITY_STYLE.info.text} hover:underline`}
          >
            {showInfo ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {showInfo ? 'Hide' : 'Show'} {severityCountText(notes.length, 'info')}
          </button>
          {showInfo && (
            <ul className="mt-2 space-y-2 pl-1">
              {notes.map((issue, i) => (
                <IssueRow key={`${issue.stepId}-${issue.code ?? ''}-${i}`} issue={issue} onApply={onApplyFix} readOnly={readOnly} />
              ))}
            </ul>
          )}
        </div>
      )}

      {dismissed.length > 0 && (
        <div className="pt-1 border-t border-black/5 dark:border-white/10">
          <button
            type="button"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed(v => !v)}
            className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:underline"
          >
            {showDismissed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {dismissed.length} dismissed
          </button>
          {showDismissed && (
            <ul className="mt-1.5 space-y-1">
              {dismissed.map(d => (
                <li key={`${d.stepId}-${d.dismissKey}`} className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    <strong>[{d.stepName}]</strong> {d.message}
                  </span>
                  {onRestore && (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => onRestore(d.stepId, d.dismissKey)}
                      className="inline-flex items-center gap-1 font-semibold text-blue-700 dark:text-blue-700 hover:underline disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default MethodIssueBanner;
