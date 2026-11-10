/** Project-level switches for the scientific soft hints (stored in project settings, shared by every viewer). */

import React, { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { ChemexModalShell, chemexBtnPrimary, chemexBtnSecondary, chemexInputCls } from '../chemex/TomlEditorParts';
import { SCIENCE_CHECKS, checkEnabled, checkThreshold, type ScienceSettings } from '../../lib/scienceChecks';

export const ScienceChecksModal: React.FC<{
  settings: ScienceSettings;
  onClose: () => void;
  onSave: (next: Record<string, { enabled: boolean; threshold?: number | null }>) => Promise<boolean> | boolean;
}> = ({ settings, onClose, onSave }) => {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      SCIENCE_CHECKS.map(c => [c.id, { enabled: checkEnabled(settings, c.id), threshold: c.threshold ? checkThreshold(settings, c.id) : null }])
    ) as Record<string, { enabled: boolean; threshold: number | null }>
  );
  const [saving, setSaving] = useState(false);
  return (
    <ChemexModalShell
      icon={<FlaskConical size={20} />}
      title="Scientific checks"
      subtitle="Soft hints (warnings and notes, never errors). Saved for this project."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            className={chemexBtnPrimary}
            onClick={async () => {
              setSaving(true);
              const ok = await onSave(
                Object.fromEntries(Object.entries(draft).map(([id, v]) => [id, v.threshold === null ? { enabled: v.enabled } : { enabled: v.enabled, threshold: v.threshold }]))
              );
              setSaving(false);
              if (ok) onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <ul className="space-y-3">
        {SCIENCE_CHECKS.map(c => (
          <li key={c.id} className="text-xs">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft[c.id].enabled}
                onChange={e => setDraft(d => ({ ...d, [c.id]: { ...d[c.id], enabled: e.target.checked } }))}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold text-slate-900 dark:text-slate-100">{c.label}</span>
                <span className="block text-slate-900 dark:text-slate-200">{c.description}</span>
              </span>
            </label>
            {c.threshold && (
              <label className="mt-1 ml-6 flex items-center gap-2 text-slate-900 dark:text-slate-200">
                {c.threshold.label}
                <input
                  type="number"
                  min={1}
                  step={1}
                  aria-label={c.threshold.label}
                  value={draft[c.id].threshold ?? ''}
                  disabled={!draft[c.id].enabled}
                  onChange={e => setDraft(d => ({ ...d, [c.id]: { ...d[c.id], threshold: Number(e.target.value) || c.threshold!.value } }))}
                  className={`${chemexInputCls} w-20`}
                />
              </label>
            )}
          </li>
        ))}
      </ul>
    </ChemexModalShell>
  );
};

export default ScienceChecksModal;
