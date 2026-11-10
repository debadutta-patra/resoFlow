/**
 * @vitest-environment jsdom
 *
 * Phase E (round 2): undo/redo, per-residue overrides from the table, pipeline strip,
 * templates / load from run / test run dialogs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, renderHook, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useMethodEditor, HISTORY_LIMIT, COALESCE_MS } from '../../hooks/useMethodEditor';
import ParameterTable, { DEFAULT_PARAM_METAS } from './ParameterTable';
import PipelineStrip from './PipelineStrip';
import { LoadFromRunModal, SaveTemplateModal, TestRunModal } from './MethodWorkflowModals';
import type { Step } from '../../lib/methodConfig';
import { configToToml } from '../../lib/methodToml';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../services/api', () => ({
  default: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  vi.useRealTimers();
});

const editorOpts = (locked = false) => ({
  projectUuid: 'p',
  analysisUuid: 'a',
  family: 'cest' as const,
  model: '2st',
  residueItems: [],
  isResidueExcluded: () => false,
  exclusionKey: null,
  locked,
});

describe('undo / redo in useMethodEditor', () => {
  it('undoes and redoes edits, coalesces rapid typing into one entry, and is disabled while locked', () => {
    apiGet.mockResolvedValue({ data: {} });
    apiPost.mockResolvedValue({ data: {} });
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ locked }) => useMethodEditor(editorOpts(locked)), { initialProps: { locked: false } });
    const name0 = result.current.methodConfig.steps[0].name;
    expect(result.current.canUndo).toBe(false);

    // Typing "AB" quickly → one history entry.
    act(() => result.current.handleStepChange({ ...result.current.activeStep, name: 'A' }));
    act(() => result.current.handleStepChange({ ...result.current.activeStep, name: 'AB' }));
    act(() => vi.advanceTimersByTime(COALESCE_MS + 50));
    act(() => result.current.stepHandlers.onAddStep());
    expect(result.current.methodConfig.steps).toHaveLength(2);

    act(() => result.current.undo());
    expect(result.current.methodConfig.steps).toHaveLength(1);
    expect(result.current.methodConfig.steps[0].name).toBe('AB');
    act(() => result.current.undo());
    expect(result.current.methodConfig.steps[0].name).toBe(name0);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.methodToml).toBe(configToToml(result.current.methodConfig));

    act(() => result.current.redo());
    expect(result.current.methodConfig.steps[0].name).toBe('AB');
    expect(result.current.canRedo).toBe(true);

    // A new edit clears the redo stack.
    act(() => vi.advanceTimersByTime(COALESCE_MS + 50));
    act(() => result.current.handleStepChange({ ...result.current.activeStep, name: 'X' }));
    expect(result.current.canRedo).toBe(false);

    // Locked (run in progress): nothing to undo.
    expect(result.current.methodConfig.steps[0].name).toBe('X');
    rerender({ locked: true });
    expect(result.current.methodConfig.steps[0].name).toBe('X');
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.methodConfig.steps[0].name).toBe('X');
  });

  it('keeps a bounded history of at least 50 states', () => {
    apiGet.mockResolvedValue({ data: {} });
    apiPost.mockResolvedValue({ data: {} });
    vi.useFakeTimers();
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(50);
    const { result } = renderHook(() => useMethodEditor(editorOpts()));
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      act(() => vi.advanceTimersByTime(COALESCE_MS + 10));
      act(() => result.current.handleStepChange({ ...result.current.activeStep, name: `S${i}` }));
    }
    let undos = 0;
    while (result.current.canUndo) {
      act(() => result.current.undo());
      undos++;
    }
    expect(undos).toBe(HISTORY_LIMIT);
    expect(result.current.methodConfig.steps[0].name).toBe('S19');
  });

  it('restore() starts a fresh history (loading a saved config is not an undoable edit)', () => {
    apiGet.mockResolvedValue({ data: {} });
    apiPost.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useMethodEditor(editorOpts()));
    act(() => result.current.stepHandlers.onAddStep());
    expect(result.current.canUndo).toBe(true);
    act(() => {
      result.current.restore({ method_config: { steps: [{ id: 'x', name: 'SAVED', parameters: [], residueMode: 'all', residues: [] }] } });
    });
    expect(result.current.canUndo).toBe(false);
  });
});

describe('per-residue overrides from the table', () => {
  function Harness() {
    const [step, setStep] = useState<Step>({ id: 's', name: 'STEP1', residueMode: 'all', residues: [], parameters: [], roleRules: [] });
    return (
      <>
        <ParameterTable step={step} onChange={setStep} availableParams={DEFAULT_PARAM_METAS} stepResidueIds={['14N', '23N']} />
        <output data-testid="rules">{JSON.stringify((step.roleRules ?? []).map(r => [r.action, r.entries]))}</output>
      </>
    );
  }
  const row = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('tr') as HTMLElement;

  it('writes, updates and removes a selector rule per residue', () => {
    render(<Harness />);
    expect(within(row('PB')).queryByRole('button', { name: /per residue/ })).toBeNull(); // global parameter
    fireEvent.click(within(row('DW_AB')).getByRole('button', { name: /per residue/ }));
    const cell = screen.getByTestId('override-DW_AB-23N');
    fireEvent.click(within(cell).getByRole('button', { name: 'Fix' }));
    expect(screen.getByTestId('rules').textContent).toBe('[["FIX",["DW_AB, NUC->23N"]]]');
    expect(within(row('DW_AB')).getByRole('button', { name: /per residue · 1 override/ })).toBeDefined();
    fireEvent.click(within(screen.getByTestId('override-DW_AB-23N')).getByRole('button', { name: 'Constrain' }));
    expect(screen.getByTestId('rules').textContent).toBe('[["CONSTRAIN",["[DW_AB, NUC->23N] = [DW_AB, NUC->14N]"]]]');
    fireEvent.click(within(screen.getByTestId('override-DW_AB-23N')).getByRole('button', { name: 'Default' }));
    expect(screen.getByTestId('rules').textContent).toBe('[]');
  });
});

describe('pipeline strip', () => {
  it('draws values arrows between steps, a dashed roles arc for ROLES_FROM, and selects on click', () => {
    const steps: Step[] = [
      { id: 'a', name: 'GRID', residueMode: 'all', residues: [], parameters: [], search: { mode: 'grid', axes: [{ id: 'x', param: 'PB', fn: 'lin', low: 0, high: 1, count: 3 }] } },
      { id: 'b', name: 'REFINE', residueMode: 'all', residues: [], parameters: [] },
      { id: 'c', name: 'SAMPLE', residueMode: 'include', residues: ['1N'], parameters: [], rolesFromStepId: 'a', rolesFrom: 'GRID', statistics: { mcmc: { enabled: true, steps: 10, burn: 'auto' } } },
    ];
    const onSelect = vi.fn();
    render(<PipelineStrip steps={steps} activeIdx={0} onSelect={onSelect} info={[{ residues: 3, runtime: '≈ 2 min' }, { residues: 3, runtime: null }, { residues: 1, runtime: null }]} totalRuntime="≈ 5 min+" />);
    expect(screen.getAllByTestId('values-arrow')).toHaveLength(2);
    expect(screen.getByTestId('roles-arc-0-2')).toBeDefined();
    expect(screen.getByText('Total ≈ 5 min+')).toBeDefined();
    expect(screen.getByRole('button', { name: /GRID/ }).textContent).toContain('3 res · ≈ 2 min');
    expect(screen.getByRole('button', { name: /SAMPLE/ }).textContent).toContain('MCMC');
    fireEvent.click(screen.getByRole('button', { name: /REFINE/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

describe('workflow dialogs', () => {
  it('saves a template with name, description and scope', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<SaveTemplateModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Grid then MCMC' } });
    fireEvent.change(screen.getByLabelText('Template description'), { target: { value: 'my default' } });
    fireEvent.click(screen.getByRole('radio', { name: /My templates/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Grid then MCMC', description: 'my default', scope: 'user' }));
  });

  it('lists completed runs and loads a method only after showing the diff', async () => {
    apiGet.mockResolvedValue({
      data: {
        runs: [
          { analysis_uuid: 'a', analysis_name: 'This', source: 'current', completed_at: '2026-11-10T10:00:00Z', redchi: 0.91, steps: ['STEP1', 'STEP2'], method_toml: 'FORMAT_VERSION = 2\n\n[STEP1]\n\n[STEP2]\n' },
          { analysis_uuid: 'b', analysis_name: 'Other', source: 'backup', completed_at: null, redchi: null, steps: ['S'], method_toml: 'FORMAT_VERSION = 2\n\n[S]\n' },
        ],
      },
    });
    const onLoad = vi.fn();
    render(<LoadFromRunModal projectUuid="p" family="cest" currentToml={'FORMAT_VERSION = 2\n\n[STEP1]\n'} currentAnalysisUuid="a" onClose={() => {}} onLoad={onLoad} />);
    expect(apiGet).toHaveBeenCalledWith('/api/projects/p/chemex/method-history', { params: { family: 'cest' } });
    const table = await screen.findByRole('table', { name: 'Completed runs' });
    expect(within(table).getByText('This analysis')).toBeDefined();
    expect(within(table).getByText('Other · previous run')).toBeDefined();
    fireEvent.click(within(table).getByText('This analysis'));
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByTestId('diff-stats').textContent).toMatch(/\+2 \/ −0/);
    fireEvent.click(screen.getByRole('button', { name: 'Load this method' }));
    expect(onLoad).toHaveBeenCalledWith('FORMAT_VERSION = 2\n\n[STEP1]\n\n[STEP2]\n', 'This analysis');
  });

  it('starts a test run on the chosen residue, polls until done and refreshes estimates', async () => {
    apiPost.mockResolvedValue({ data: { test_id: 't1', state: 'queued', residue: '23N', steps: [] } });
    apiGet.mockResolvedValue({ data: { test_id: 't1', state: 'done', residue: '23N', seconds: 12, steps: [{ name: 'STEP1', seconds: 9, evaluations: 9 }] } });
    const onFinished = vi.fn();
    render(<TestRunModal projectUuid="p" analysisUuid="a" methodToml="M" model="2st" residues={['14N', '23N']} onClose={() => {}} onFinished={onFinished} pollMs={10} />);
    fireEvent.change(screen.getByLabelText('Test residue'), { target: { value: '23N' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start test' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/projects/p/analysis/a/chemex/test-run', { method_toml: 'M', parameter_toml: undefined, model: '2st', residue: '23N' }));
    await waitFor(() => expect(screen.getByTestId('test-status').textContent).toContain('TEST RUN · 23N · done · 12 s'));
    expect(screen.getByTestId('test-status').textContent).toContain('STEP1: 9 s (9 fits)');
    expect(onFinished).toHaveBeenCalled();
  });
});
