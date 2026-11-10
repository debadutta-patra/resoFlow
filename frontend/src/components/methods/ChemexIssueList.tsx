/** Inline list of ChemEx-reported problems for one part of a step (search, statistics, ROLES_FROM…). */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ValidationError } from '../../lib/methodValidation';
import { chemexLocation } from '../../lib/resolvedRoles';

export const ChemexIssueList: React.FC<{ issues: ValidationError[]; className?: string }> = ({ issues, className = '' }) =>
  issues.length === 0 ? null : (
    <ul className={`space-y-0.5 text-xs ${className}`} aria-label="ChemEx validation errors">
      {issues.map((e, i) => (
        <li key={i} className={`flex items-start gap-1 ${e.severity === 'error' ? 'text-red-700 dark:text-red-600' : e.severity === 'warning' ? 'text-amber-800 dark:text-amber-700' : 'text-blue-800 dark:text-blue-700'}`}>
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            {e.source && <span className="font-mono opacity-80">{chemexLocation({ message: e.message, type: '', source: e.source })}: </span>}
            {e.message}
          </span>
        </li>
      ))}
    </ul>
  );

export default ChemexIssueList;
