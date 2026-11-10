/**
 * @vitest-environment jsdom
 *
 * Phase D (round 2): informative chips, gaps, named selections (project-level persistence).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, renderHook, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import ResidueSelector, { type ResidueItem } from './ResidueSelector';
import { fitForProfile } from './ResiduePreview';
import { useProjectSettings } from '../../hooks/useProjectSettings';

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../services/api', () => ({
  default: { get: (...a: unknown[]) => apiGet(...a), patch: (...a: unknown[]) => apiPatch(...a), put: vi.fn(), post: vi.fn() },
}));

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPatch.mockReset();
  vi.useRealTimers();
});

const items: ResidueItem[] = [
  { id: '3N', number: 3, label: '3N', hasData: true },
  { id: '5N', number: 5, label: '5N', hasData: true },
  { id: '6N', number: 6, label: '6N', hasData: true },
];

function Harness(props: Partial<React.ComponentProps<typeof ResidueSelector>>) {
  const [sel, setSel] = useState<string[]>(['3N', '5N']);
  return (
    <>
      <ResidueSelector residues={items} mode="include" selectedIds={sel} onModeChange={() => {}} onSelectionChange={setSel} {...props} />
      <output data-testid="sel">{sel.join(',')}</output>
    </>
  );
}

describe('residue chips', () => {
  it('shows gaps as faint non-clickable placeholders in sequence order, and can hide them', () => {
    const { container } = render(<Harness gaps={[4]} />);
    const grid = container.querySelector('.max-h-72')!;
    const order = Array.from(grid.querySelectorAll('button, [data-testid="gap-chip"]')).map(el => el.textContent?.trim());
    expect(order).toEqual(['3N', '4', '5N', '6N']);
    expect(screen.getByTestId('gap-chip').tagName).toBe('SPAN');
    fireEvent.click(screen.getByRole('checkbox', { name: /Show gaps \(1\)/ }));
    expect(screen.queryByTestId('gap-chip')).toBeNull();
  });

  it('shades chips by the chosen metric with a legend', () => {
    const onChange = vi.fn();
    render(<Harness metric={{ options: ['dip', 'redchi'], active: 'dip', values: { '3N': 0.05, '6N': 0.25 }, onChange }} />);
    expect(screen.getByRole('button', { name: /^6N/ }).dataset.shade).toBe('1.00');
    expect(screen.getByRole('button', { name: /3N/ }).dataset.shade).toBe('0.00');
    expect(screen.getByRole('button', { name: /^5N/ }).dataset.shade).toBeUndefined();
    const legend = screen.getByLabelText('Chip shading legend');
    expect(within(legend).getByText('0.050')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Shade chips by'), { target: { value: 'redchi' } });
    expect(onChange).toHaveBeenCalledWith('redchi');
  });

  it('previews a residue only after a debounced hover', () => {
    vi.useFakeTimers();
    const renderPreview = vi.fn((it: ResidueItem) => <span>preview {it.id}</span>);
    render(<Harness renderPreview={renderPreview} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^6N/ }));
    expect(screen.queryByTestId('residue-preview')).toBeNull();
    fireEvent.mouseLeave(screen.getByRole('button', { name: /^6N/ }));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByTestId('residue-preview')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^5N/ }));
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByTestId('residue-preview').textContent).toContain('preview 5N');
    expect(renderPreview).toHaveBeenCalledTimes(1);
  });

  it('saves the current selection under a name and applies saved ones (only residues with data)', () => {
    const onSave = vi.fn();
    render(<Harness namedSelections={[{ id: 'a', name: 'core helix', residues: ['5N', '6N', '99N'] }]} onSaveSelection={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Selections \(1\)/ }));
    fireEvent.change(screen.getByLabelText('Selection name'), { target: { value: 'dip residues' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('dip residues', ['3N', '5N']);
    fireEvent.click(screen.getByRole('menuitem', { name: /core helix 2\/3 res/ }));
    expect(screen.getByTestId('sel').textContent).toBe('5N,6N');
  });
});

describe('named selection persistence', () => {
  it('stores selections in project settings (shared across analyses), not localStorage', async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith('/settings') ? { sequence_offset: 0, scientific_checks: {}, named_selections: [], method_templates: [] } : { protein_sequence: 'MK' } })
    );
    const sel = { id: 's1', name: 'dip residues', residues: ['14N'] };
    apiPatch.mockResolvedValue({ data: { sequence_offset: 0, scientific_checks: {}, named_selections: [sel], method_templates: [] } });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useProjectSettings('p1'));
    await vi.waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.update({ named_selections: [sel] });
    });
    expect(apiPatch).toHaveBeenCalledWith('/api/projects/p1/settings', { named_selections: [sel] });
    expect(result.current.settings.named_selections).toEqual([sel]);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('fit overlay', () => {
  it('picks the fitted rows of the thumbnail experiment by B1 label', () => {
    const rows = [
      { step: 'S', experiment: '26hz', x: 0, y_calc: 9 },
      { step: 'S', experiment: '13hz', x: 10, y_calc: 2 },
      { step: 'S', experiment: '13hz', x: -10, y_calc: 1 },
    ];
    const profile = { residue: '14N', experiments: [{ b1: '13Hz', b1_actual: 13, b0: 500, carrier: 118, offsets: [0], intensities: [1] }] };
    expect(fitForProfile(rows, profile)).toEqual({ offsets: [-10, 10], calc: [1, 2] });
    expect(fitForProfile([], profile)).toBeNull();
  });
});
