/**
 * @vitest-environment jsdom
 *
 * Phase A (round 2): severity-coloured issue banner with quick-fixes and dismissal,
 * qualified "accepts" footer, role-dependent setting column, sequence-aware residue search.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import MethodIssueBanner from './MethodIssueBanner';
import MethodTomlPanel from './MethodTomlPanel';
import ParameterTable, { DEFAULT_PARAM_METAS } from './ParameterTable';
import ResidueSelector from './ResidueSelector';
import SequenceImportModal from './SequenceImportModal';
import { validateMethodConfig, type ValidationError } from '../../lib/methodValidation';
import type { MethodConfig, Step } from '../../lib/methodConfig';
import type { ResolvedParameter } from '../../lib/resolvedRoles';

afterEach(cleanup);

const issue = (over: Partial<ValidationError>): ValidationError => ({ stepId: 's', stepName: 'STEP1', message: 'msg', severity: 'info', ...over });

describe('MethodIssueBanner', () => {
  it('takes the colour of the highest severity and counts each level', () => {
    const { container } = render(
      <MethodIssueBanner issues={[issue({ severity: 'info' }), issue({ severity: 'warning', message: 'w' })]} onApplyFix={() => {}} />
    );
    const section = container.querySelector('section')!;
    expect(section.dataset.severity).toBe('warning');
    expect(section.className).toMatch(/amber/);
    expect(screen.getByText('1 warning')).toBeDefined();
    expect(screen.getByText('1 note')).toBeDefined();
    cleanup();
    const err = render(<MethodIssueBanner issues={[issue({ severity: 'error' }), issue({ severity: 'info' })]} onApplyFix={() => {}} />);
    expect(err.container.querySelector('section')!.className).toMatch(/red/);
  });

  it('collapses info notes until expanded', () => {
    render(<MethodIssueBanner issues={[issue({ message: 'an info note' })]} onApplyFix={() => {}} />);
    expect(screen.queryByText('an info note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show 1 note/ }));
    expect(screen.getByText('an info note')).toBeDefined();
  });

  it('applies a quick-fix and restores a dismissed issue', () => {
    const config: MethodConfig = { steps: [{ id: 'a', name: 'STEP1', residueMode: 'all', residues: [], parameters: [{ name: 'PB', mode: 'fit' }] }, { id: 'b', name: 'STEP2', residueMode: 'all', residues: [], parameters: [] }] };
    const issues = validateMethodConfig(config).filter(i => i.code === 'no-fit-action');
    const onApply = vi.fn();
    const onRestore = vi.fn();
    render(
      <MethodIssueBanner
        issues={issues}
        dismissed={[{ ...issue({ stepId: 'b', message: 'old note' }), dismissKey: 'k' }]}
        onApplyFix={onApply}
        onRestore={onRestore}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Show 1 note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Inherit roles from STEP1' }));
    expect(onApply.mock.calls[0][0].apply(config).steps[1].rolesFromStepId).toBe('a');
    fireEvent.click(screen.getByRole('button', { name: /1 dismissed/ }));
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    expect(onRestore).toHaveBeenCalledWith('b', 'k');
  });

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<MethodIssueBanner issues={[]} onApplyFix={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('TOML panel footer', () => {
  const props = { toml: 'FORMAT_VERSION = 2\n', downloadName: 'm.toml', stepCount: 1, lastRunToml: null, lastRunAt: null, chemexVersion: '2026.9.2' };
  it('qualifies the green tick when notes or warnings exist', () => {
    render(<MethodTomlPanel {...props} validation={{ checking: false, known: true, errors: 0, warnings: 0, notes: 1 }} />);
    expect(screen.getByTestId('toml-accepts').textContent).toMatch(/ChemEx accepts this method · 1 note$/);
    cleanup();
    render(<MethodTomlPanel {...props} validation={{ checking: false, known: true, errors: 0, warnings: 2, notes: 3 }} />);
    expect(screen.getByTestId('toml-accepts').textContent).toMatch(/· 2 warnings · 3 notes$/);
  });
});

describe('ParameterTable setting column by role', () => {
  const row = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('tr') as HTMLElement;
  const rp = (over: Partial<ResolvedParameter>): ResolvedParameter => ({
    id: `__${over.name}`, name: 'PB', spin: '', conditions: {}, scope: 'global', role: 'fit', expression: '', decided_by: 'baseline', rule: null, protected: false, value: null, ...over,
  });
  const step: Step = {
    id: 's', name: 'STEP1', residueMode: 'all', residues: [],
    parameters: [{ name: 'PB', mode: 'fit' }, { name: 'KEX_AB', mode: 'fix' }],
    search: { mode: 'grid', axes: [{ id: 'ax1', param: 'PB', fn: 'log', low: 0.001, high: 0.03, count: 10 }] },
  };

  it('shows one compact resolved indicator, the grid axis instead of a starting value, fixed values and derived expressions', () => {
    render(
      <ParameterTable
        step={step}
        onChange={() => {}}
        availableParams={DEFAULT_PARAM_METAS}
        startingValues={{ PB: 0.05 }}
        stepIndex={0}
        resolvedCounts={{ PB: { fit: 1, fix: 0, constrained: 0, derived: 0 }, KEX_AB: { fit: 0, fix: 1, constrained: 0, derived: 0 } }}
        resolvedParams={[
          rp({ name: 'PB', role: 'fit' }),
          rp({ name: 'KEX_AB', role: 'fix', value: 200 }),
          rp({ id: '__R1_B_13N', name: 'R1_B', role: 'derived', spin: '13N', scope: 'residue', expression: '__R1_A_13N' }),
          rp({ id: '__R1_A_13N', name: 'R1_A', role: 'fix', spin: '13N', scope: 'residue', value: 1.5 }),
        ]}
      />
    );
    const pb = row('PB');
    expect(within(pb).getByTestId('resolved-PB').textContent).toBe('→ Fit');
    expect(within(pb).queryByText(/Resolved:/)).toBeNull();
    expect(within(pb).getByText(/Grid axis/).textContent).toBe('Grid axis · log(0.001–0.03, 10 pts)');
    expect(within(pb).queryByText('0.05')).toBeNull();
    expect(within(row('KEX_AB')).getByTestId('setting-fix').textContent).toBe('Fixed at 200 s⁻¹ · parameters file');
    const r1b = within(row('R1_B')).getByTestId('setting-derived');
    expect(r1b.textContent).toMatch(/= \[R1_A\]/);
    expect(r1b.textContent).toMatch(/default constraint/);
  });
});

describe('residue search placeholder', () => {
  const items = [{ id: '14N', number: 14, label: '14N', hasData: true }];
  it('does not suggest residue-type search until types are known, and offers "Import sequence"', () => {
    const onImport = vi.fn();
    render(<ResidueSelector residues={items} mode="include" selectedIds={[]} onModeChange={() => {}} onSelectionChange={() => {}} onImportSequence={onImport} />);
    expect(screen.getByPlaceholderText('Search residues by number (e.g. 14)...')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Import sequence/ }));
    expect(onImport).toHaveBeenCalled();
    cleanup();
    render(<ResidueSelector residues={[{ ...items[0], label: 'G14N' }]} mode="include" selectedIds={[]} onModeChange={() => {}} onSelectionChange={() => {}} residueTypesKnown />);
    expect(screen.getByPlaceholderText('Search residues (e.g. 14, G14, Gly)...')).toBeDefined();
    expect(screen.getByText('G14N')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Import sequence/ })).toBeNull();
  });

  it('sequence import previews numbering with the offset and saves', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<SequenceImportModal sampleResidue={14} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('FASTA or one-letter sequence'), { target: { value: '>x\nAAAG' } });
    fireEvent.change(screen.getByLabelText('Numbering offset'), { target: { value: '10' } });
    expect(screen.getByTestId('sequence-preview').textContent).toBe('4 residues, numbered 11–14 · residue 14 → G14');
    fireEvent.click(screen.getByRole('button', { name: 'Save sequence' }));
    expect(onSave).toHaveBeenCalledWith('AAAG', 10);
  });
});
