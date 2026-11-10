import React, { useRef, useState } from 'react';
import { numericDraftOf as show, parseNumericDraft } from '../../lib/numericDraft';

export interface NumericFieldProps {
  value: number | undefined | null;
  /** Called on blur / Enter with the parsed value; `undefined` means the field was cleared. */
  onCommit: (value: number | undefined) => void;
  id?: string;
  placeholder?: string;
  title?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Number input that edits a string draft and commits on blur or Enter (Escape reverts).
 * An empty field commits `undefined` ("unset") — never 0. Invalid text is not committed.
 */
export const NumericField: React.FC<NumericFieldProps> = ({
  value,
  onCommit,
  id,
  placeholder,
  title,
  className = '',
  ariaLabel,
  disabled,
}) => {
  const [draft, setDraft] = useState(show(value));
  // type=number reports unparsable text (e.g. "1e") as '' — track it so it is not read as "cleared".
  const [badInput, setBadInput] = useState(false);
  const [focused, setFocused] = useState(false);
  const [syncedValue, setSyncedValue] = useState(value);
  const skipCommit = useRef(false);

  // Follow external value changes while not editing (render-time sync, no effect).
  if (!focused && !Object.is(value, syncedValue)) {
    setSyncedValue(value);
    setDraft(show(value));
  }

  const parsed = parseNumericDraft(draft);
  const invalid = badInput || Number.isNaN(parsed);

  const commit = () => {
    if (invalid) return;
    const current = value === null || value === undefined || Number.isNaN(value) ? undefined : value;
    if (parsed !== current) onCommit(parsed);
  };

  return (
    <input
      id={id}
      type="number"
      step="any"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      title={title}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={e => {
        setDraft(e.target.value);
        setBadInput(!!e.target.validity?.badInput);
      }}
      onBlur={() => {
        setFocused(false);
        if (skipCommit.current) {
          skipCommit.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          commit();
          skipCommit.current = true; // the blur below must not commit a second time
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          skipCommit.current = true;
          setDraft(show(value));
          setBadInput(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={`${className} ${invalid ? 'ring-2 ring-rose-500 border-rose-400' : ''}`}
    />
  );
};
