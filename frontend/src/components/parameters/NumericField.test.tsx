/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NumericField } from './NumericField';
import { parseNumericDraft } from '../../lib/numericDraft';

afterEach(cleanup);

describe('parseNumericDraft', () => {
  it('treats empty as unset, never 0', () => {
    expect(parseNumericDraft('')).toBeUndefined();
    expect(parseNumericDraft('  ')).toBeUndefined();
    expect(parseNumericDraft('-6.5')).toBe(-6.5);
    expect(parseNumericDraft('1e-3')).toBe(0.001);
    expect(Number.isNaN(parseNumericDraft('abc') as number)).toBe(true);
  });
});

describe('NumericField', () => {
  const setup = (value: number | undefined) => {
    const onCommit = vi.fn();
    render(<NumericField value={value} onCommit={onCommit} ariaLabel="field" placeholder="ChemEx default: 0" />);
    return { onCommit, input: screen.getByLabelText('field') as HTMLInputElement };
  };

  it('commits on blur, not on every keystroke', () => {
    const { onCommit, input } = setup(1);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '-2.5' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(-2.5);
  });

  it('commits once on Enter', () => {
    const { onCommit, input } = setup(1);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('clearing commits undefined (unset)', () => {
    const { onCommit, input } = setup(4);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('Escape reverts without committing', () => {
    const { onCommit, input } = setup(4);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
  });

  it('does not commit an unchanged value', () => {
    const { onCommit, input } = setup(4);
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('uses step="any" and shows the placeholder when unset', () => {
    const { input } = setup(undefined);
    expect(input.getAttribute('step')).toBe('any');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('ChemEx default: 0');
  });
});
