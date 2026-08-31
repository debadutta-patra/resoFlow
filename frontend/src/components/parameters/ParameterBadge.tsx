import {
  CheckCircle2,
  Edit3,
  AlertTriangle,
  HelpCircle,
  FileText,
  Sparkles,
  MinusCircle,
  GitFork,
} from 'lucide-react';
import type { Source } from '../../lib/parameterConfig';

export type DisplayBadgeState =
  | 'excluded'
  | 'picked'
  | 'manual'
  | 'stale'
  | 'no_b'
  | 'default'
  | 'imported'
  | 'inherited';

interface ParameterBadgeProps {
  source?: Source;
  isStale?: boolean;
  hasNoBPick?: boolean;
  isExcluded?: boolean;
  compact?: boolean;
  className?: string;
}

export const ParameterBadge: React.FC<ParameterBadgeProps> = ({
  source,
  isStale = false,
  hasNoBPick = false,
  isExcluded = false,
  compact = false,
  className = '',
}) => {
  let state: DisplayBadgeState = 'default';

  if (isExcluded) {
    state = 'excluded';
  } else if (isStale) {
    state = 'stale';
  } else if (hasNoBPick) {
    state = 'no_b';
  } else if (source?.kind === 'manual') {
    state = 'manual';
  } else if (source?.kind === 'inherited') {
    state = 'inherited';
  } else if (source?.kind === 'pick') {
    state = 'picked';
  } else if (source?.kind === 'imported') {
    state = 'imported';
  } else {
    state = 'default';
  }

  const timestamp = source && 'at' in source ? source.at : undefined;
  const timeFormatted = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined;

  const BADGE_CONFIG: Record<
    DisplayBadgeState,
    {
      label: string;
      title: string;
      classes: string;
      Icon: React.ElementType;
      iconColor: string;
    }
  > = {
    excluded: {
      label: 'Excluded',
      title: 'Residue is commented out in parameters.toml and excluded from ChemEx',
      classes: 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-700 font-semibold',
      Icon: MinusCircle,
      iconColor: 'text-rose-600 dark:text-rose-400',
    },
    picked: {
      label: 'Picked',
      title: 'Derived from CEST peak pick' + (timeFormatted ? ` at ${timeFormatted}` : ''),
      classes: 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700',
      Icon: CheckCircle2,
      iconColor: 'text-emerald-600 dark:text-emerald-400',
    },
    manual: {
      label: 'Edited',
      title: 'Manually edited' + (timeFormatted ? ` at ${timeFormatted}` : ''),
      classes: 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700',
      Icon: Edit3,
      iconColor: 'text-blue-600 dark:text-blue-400',
    },
    stale: {
      label: 'Pick Moved',
      title: 'Pick was moved in Pick CEST tab since last sync',
      classes: 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-700 font-semibold',
      Icon: AlertTriangle,
      iconColor: 'text-amber-600 dark:text-amber-400',
    },
    no_b: {
      label: 'No B-Pick',
      title: 'No excited B-state peak picked (Δω initial guess is 0.0)',
      classes: 'bg-purple-50 text-purple-700 border-purple-300 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-700',
      Icon: HelpCircle,
      iconColor: 'text-purple-600 dark:text-purple-400',
    },
    imported: {
      label: 'Imported',
      title: 'Imported from existing parameter TOML file',
      classes: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600',
      Icon: FileText,
      iconColor: 'text-slate-500 dark:text-slate-400',
    },
    inherited: {
      label: 'Inherited',
      title: 'Inherited from completed run' + (source?.kind === 'inherited' ? ` (${source.sourceRunLabel})` : '') + (timeFormatted ? ` at ${timeFormatted}` : ''),
      classes: 'bg-indigo-50 text-indigo-700 border-indigo-300 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-700 font-semibold',
      Icon: GitFork,
      iconColor: 'text-indigo-600 dark:text-indigo-400',
    },
    default: {
      label: 'Default',
      title: 'Initial default parameter value',
      classes: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700',
      Icon: Sparkles,
      iconColor: 'text-slate-400 dark:text-slate-500',
    },
  };

  const current = BADGE_CONFIG[state];
  const IconComponent = current.Icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] border shadow-2xs select-none transition-all ${current.classes} ${className}`}
      title={current.title}
    >
      <IconComponent className={`w-3 h-3 shrink-0 ${current.iconColor}`} />
      {!compact && <span>{current.label}</span>}
    </span>
  );
};
