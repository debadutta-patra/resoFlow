/** Import the protein sequence (FASTA or one-letter string + numbering offset) so residue chips read "G14". */

import React, { useMemo, useState } from 'react';
import { Dna } from 'lucide-react';
import { ChemexModalShell, chemexBtnPrimary, chemexBtnSecondary, chemexInputCls } from '../chemex/TomlEditorParts';
import { parseSequenceInput, residueTypeAt, sequenceRange } from '../../lib/sequence';

export const SequenceImportModal: React.FC<{
  initialSequence?: string;
  initialOffset?: number;
  /** A residue number present in the data, used for the live preview. */
  sampleResidue?: number;
  onClose: () => void;
  onSave: (sequence: string, offset: number) => Promise<boolean> | boolean;
}> = ({ initialSequence = '', initialOffset = 0, sampleResidue, onClose, onSave }) => {
  const [text, setText] = useState(initialSequence);
  const [offset, setOffset] = useState(initialOffset);
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseSequenceInput(text) : null), [text]);
  const range = parsed?.sequence ? sequenceRange(parsed.sequence, offset) : null;
  const sampleType = parsed?.sequence && sampleResidue ? residueTypeAt(parsed.sequence, offset, sampleResidue) : null;

  return (
    <ChemexModalShell
      icon={<Dna size={20} />}
      title="Import sequence"
      subtitle="Stored on the project. Used only for residue labels and search; never written to ChemEx files."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!parsed?.sequence || saving}
            className={chemexBtnPrimary}
            onClick={async () => {
              if (!parsed?.sequence) return;
              setSaving(true);
              const ok = await onSave(parsed.sequence, offset);
              setSaving(false);
              if (ok) onClose();
            }}
          >
            Save sequence
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <label className="block font-bold text-slate-900 dark:text-slate-200" htmlFor="seq-input">
          FASTA or one-letter sequence
        </label>
        <textarea
          id="seq-input"
          rows={6}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'>my_protein\nMKVLAAGIVG...'}
          className={`${chemexInputCls} font-mono text-xs`}
        />
        <label className="flex items-center gap-2 text-slate-900 dark:text-slate-200">
          Numbering offset
          <input
            type="number"
            value={offset}
            onChange={e => setOffset(parseInt(e.target.value, 10) || 0)}
            className={`${chemexInputCls} w-24`}
            aria-label="Numbering offset"
          />
          <span className="text-slate-900 dark:text-slate-200">first letter = residue {1 + offset}</span>
        </label>
        {parsed?.error && <p className="text-red-700 dark:text-red-600">{parsed.error}</p>}
        {range && (
          <p className="text-slate-900 dark:text-slate-200" data-testid="sequence-preview">
            {parsed?.sequence.length} residues, numbered {range[0]}–{range[1]}
            {sampleResidue ? ` · residue ${sampleResidue} → ${sampleType ? `${sampleType}${sampleResidue}` : 'outside the sequence'}` : ''}
          </p>
        )}
      </div>
    </ChemexModalShell>
  );
};

export default SequenceImportModal;
