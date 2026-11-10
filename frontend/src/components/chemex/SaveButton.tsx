/** Save button with an unsaved-changes dot; disabled (with a tooltip) when there is nothing to save. */

import React from 'react';

export const SaveButton: React.FC<{ dirty: boolean; onSave: () => void; className: string; disabled?: boolean }> = ({ dirty, onSave, className, disabled }) => (
  <span title={dirty ? 'Save the unsaved changes' : 'No unsaved changes'} className="inline-flex">
    <button type="button" onClick={onSave} disabled={disabled || !dirty} className={`${className} relative disabled:opacity-60 disabled:cursor-not-allowed`} aria-label={dirty ? 'Save (unsaved changes)' : 'Save'}>
      Save
      {dirty && <span data-testid="unsaved-dot" className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900" />}
    </button>
  </span>
);

export default SaveButton;
