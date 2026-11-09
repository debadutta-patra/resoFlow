/**
 * @vitest-environment jsdom
 *
 * Phase 6: explicit profile-selection modes, copy from previous step, picked-dip
 * filter, and template additions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { act, render, renderHook, screen, cleanup, fireEvent } from '@testing-library/react';
import ResidueSelector, { type SelectionMode } from './ResidueSelector';
import type { ResidueItem } from '../../lib/residueSelection';
import { minorPickFlag } from '../../lib/residueSelection';
import { useMethodEditor } from '../../hooks/useMethodEditor';
import { METHOD_TEMPLATES } from '../../lib/methodTemplates';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: { parameters: [] } }), put: vi.fn() },
}));

afterEach(cleanup);

const items: ResidueItem[] = [
  { id: '13N', number: 13, label: 'G13N', hasData: true, hasMinorPick: true },
  { id: '26N', number: 26, label: 'A26N', hasData: true, hasMinorPick: false },
  { id: '28N', number: 28, label: 'K28N', hasData: true, hasMinorPick: true },
];

function Harness({ onCopy }: { onCopy?: () => void }) {
  const [mode, setMode] = useState<SelectionMode>('all');
  const [sel, setSel] = useState<string[]>([]);
  return (
    <>
      <ResidueSelector residues={items} mode={mode} selectedIds={sel} onModeChange={setMode} onSelectionChange={setSel} onCopyFromPrevious={onCopy} previousStepName="GLOBAL_FIT" />
      <output data-testid="state">{`${mode}:${sel.join(',')}`}</output>
    </>
  );
}

describe('profile selection', () => {
  it('distinguishes "All profiles" from an empty INCLUDE', () => {
    render(<Harness />);
    expect(screen.getByText('All 3 profiles')).toBeDefined();
    expect(screen.queryByRole('button', { name: /G13N/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Include only these/ }));
    expect(screen.getByTestId('state').textContent).toBe('include:');
    expect(screen.getByText(/INCLUDE is empty: no profiles would be fitted/)).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: /All profiles/ }));
    expect(screen.queryByText(/INCLUDE is empty/)).toBeNull();
  });

  it('filters to residues with a picked minor-state dip and adds only those', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: /Include only these/ }));
    fireEvent.click(screen.getByLabelText(/Only residues with a picked minor-state dip/));
    expect(screen.queryByRole('button', { name: /A26N/ })).toBeNull();
    fireEvent.click(screen.getByTitle('Add the residues shown by the filter'));
    expect(screen.getByTestId('state').textContent).toBe('include:13N,28N');
  });

  it('offers "Copy from previous step"', () => {
    const onCopy = vi.fn();
    render(<Harness onCopy={onCopy} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy from previous step \(GLOBAL_FIT\)/ }));
    expect(onCopy).toHaveBeenCalled();
  });

  it('flags picked minor-state shifts only when pick data exists', () => {
    expect(minorPickFlag({}, '13N')).toBeUndefined();
    expect(minorPickFlag({ '13N': { cs_b: 120.1 }, '26N': { cs_b: null } }, '13N')).toBe(true);
    expect(minorPickFlag({ '13N': { cs_b: 120.1 }, '26N': { cs_b: null } }, '26N')).toBe(false);
    expect(minorPickFlag({ '13N': { cs_b: 120.1 } }, '99N')).toBe(false);
  });
});

describe('template additions', () => {
  const hook = () =>
    renderHook(() =>
      useMethodEditor({ projectUuid: 'p', analysisUuid: 'a6', family: 'cest', model: '2st', residueItems: [], isResidueExcluded: () => false, exclusionKey: [] })
    );
  const tmpl = (id: string) => METHOD_TEMPLATES.find(t => t.id === id)!;

  it('ties state-B relaxation on the active step without replacing the method, once', () => {
    const { result } = hook();
    act(() => result.current.applyTemplate(tmpl('two_step_global_local')));
    act(() => result.current.setActiveStepIdx(1));
    act(() => result.current.applyTemplate(tmpl('tie_b_relaxation')));
    act(() => result.current.applyTemplate(tmpl('tie_b_relaxation')));
    expect(result.current.methodConfig.steps.map(s => s.name)).toEqual(['GLOBAL_FIT', 'LOCAL_FITS']);
    expect(result.current.effectiveMethodToml).toContain('{ FIT = ["DW_AB"] },\n  { CONSTRAIN = ["[R2_B] = [R2_A]", "[R1_B] = [R1_A]"] },\n]');
    expect(result.current.effectiveMethodToml.match(/\[R2_B\] = \[R2_A\]/g)).toHaveLength(1);
  });

  it('appends a final MC + BS statistics step that inherits roles and selection', () => {
    const { result } = hook();
    act(() => result.current.applyTemplate(tmpl('grid_and_refine_cest')));
    act(() => result.current.applyTemplate(tmpl('final_statistics')));
    expect(result.current.methodConfig.steps.map(s => s.name)).toEqual(['GRID_SEARCH', 'REFINE', 'FINAL_STATISTICS']);
    expect(result.current.activeStepIdx).toBe(2);
    expect(result.current.effectiveMethodToml).toContain('[FINAL_STATISTICS]\nROLES_FROM = "REFINE"\nSTATISTICS = { MC = 100, BS = 100 }\n');
    expect(result.current.blockingErrors).toEqual([]);
  });
});
