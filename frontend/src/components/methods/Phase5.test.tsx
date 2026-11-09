/**
 * @vitest-environment jsdom
 *
 * Phase 5: ChemEx validation as the single source of blocking errors, TOML side
 * panel (diff vs last run, version), import preview with v1 migration summary.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, renderHook, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MethodImportModal } from './MethodsTab';
import MethodTomlPanel from './MethodTomlPanel';
import StepSearchSection from './StepSearchSection';
import StepStatisticsSection from './StepStatisticsSection';
import { DEFAULT_PARAM_METAS } from './ParameterTable';
import { useMethodEditor } from '../../hooks/useMethodEditor';
import { chemexIssues, type ResolveReport } from '../../lib/resolvedRoles';
import { tomlToConfig } from '../../lib/methodToml';
import type { Step } from '../../lib/methodConfig';
import type { ValidationError } from '../../lib/methodValidation';

const post = vi.fn();
vi.mock('../../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: {} }), post: (...a: unknown[]) => post(...a), put: vi.fn() } }));

afterEach(cleanup);

const steps: Step[] = [
  { id: 'a', name: 'GRID', residueMode: 'include', residues: [], parameters: [] },
  { id: 'b', name: 'REFINE', residueMode: 'include', residues: [], parameters: [] },
];

const report: ResolveReport = {
  valid: false,
  format: 'v2',
  chemex_version: '2026.9.2',
  errors: [
    { message: 'Duplicate selector qualifier NUC', type: 'MethodFormatError', source: { step: 'REFINE', field: 'ROLES[0].FIT[0]', action_index: 0, action: 'FIT', entry_index: 0 } },
    { message: 'Experiments are not generated', type: 'MissingInputs', source: {} },
  ],
  steps: [
    {
      name: 'GRID', roles_from: null, profiles: 2, parameters: [], counts: { fit: 0, fix: 0, constrained: 0, derived: 0 }, error: null,
      search: { kind: 'grid', axes: [{ index: 1, selector: 'DW_AB', coordinates: [], error: { message: 'GRID selector has no active final independent FIT coordinate', type: 'MethodFormatError', source: {} } }] },
    },
    { name: 'REFINE', roles_from: 'GRID', profiles: 0, parameters: [], counts: { fit: 0, fix: 0, constrained: 0, derived: 0 }, error: { message: 'No profiles selected for this step; ChemEx skips it.', type: 'NoData', source: {} } },
  ],
};

describe('ChemEx issues', () => {
  it('maps every problem to its step, with every per-axis error and without "inputs missing"', () => {
    const issues = chemexIssues(report, steps);
    expect(issues.map(i => [i.stepId, i.severity, i.message])).toEqual([
      ['b', 'error', 'Duplicate selector qualifier NUC'],
      ['a', 'error', 'GRID selector has no active final independent FIT coordinate'],
      ['b', 'warning', 'No profiles selected for this step; ChemEx skips it.'],
    ]);
    expect(issues[1].source).toMatchObject({ step: 'GRID', field: 'SEARCH.GRID.AXES', index: 1 });
  });
});

describe('editor: ChemEx errors block Run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('adds current ChemEx errors to blockingErrors and ignores a stale report', async () => {
    post.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith('/methods/validate') ? report : { parameters: [] } })
    );
    const { result } = renderHook(() =>
      useMethodEditor({ projectUuid: 'p', analysisUuid: 'a-phase5', family: 'cest', model: '2st', residueItems: [], isResidueExcluded: () => false, exclusionKey: [] })
    );
    act(() => result.current.setMethodConfig({ steps }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const chemex = result.current.blockingErrors.filter(e => e.origin === 'chemex');
    expect(chemex.map(e => e.message)).toEqual(['Duplicate selector qualifier NUC', 'GRID selector has no active final independent FIT coordinate']);
    expect(result.current.validationErrors.some(e => e.severity === 'warning' && e.message.startsWith('No profiles selected'))).toBe(true);

    // Editing makes the report stale: its errors no longer block (the run pre-flight re-checks).
    act(() => result.current.handleStepChange({ ...result.current.methodConfig.steps[0], name: 'GRID2' }));
    expect(result.current.blockingErrors.filter(e => e.origin === 'chemex')).toEqual([]);
  });
});

describe('TOML side panel', () => {
  const props = { toml: 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["PB", "KEX_AB"] }]\n', downloadName: 'm.toml', stepCount: 1 };

  it('diffs against the last completed run and shows the ChemEx version and verdict', () => {
    render(
      <MethodTomlPanel
        {...props}
        lastRunToml={'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["PB"] }]\n'}
        chemexVersion="2026.9.2"
        validation={{ checking: false, known: true, errors: 2 }}
      />
    );
    expect(screen.getByText('ChemEx 2026.9.2 · FORMAT_VERSION = 2')).toBeDefined();
    expect(screen.getByText(/2 errors — Run is blocked/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Diff vs last run/ }));
    const diff = screen.getByTestId('toml-diff');
    expect(within(diff).getByText('ROLES = [{ FIT = ["PB"] }]')).toBeDefined();
    expect(screen.getByText('+1')).toBeDefined();
    expect(screen.getByText('−1')).toBeDefined();
  });

  it('disables the diff without a completed run and reports acceptance', () => {
    render(<MethodTomlPanel {...props} validation={{ checking: false, known: true, errors: 0 }} />);
    expect((screen.getByRole('button', { name: /Diff vs last run/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('ChemEx accepts this method')).toBeDefined();
  });
});

describe('import preview', () => {
  const v1 = `[STEP1]
FIT = ["PB", "KEX_AB"]
FIX = ["DW_AB"]
CONSTRAINTS = ["[R2_B] = [R2_A]", "[PB] < 0.5"]
INCLUDE = ["13N", "14N"]
GRID = ["[PB] = (0.01, 0.05, 0.10)"]
FITMETHOD = "least_squares"

[STEP2]
FIT = ["DW_AB"]
STATISTICS = { MCMC = { STEPS = 5000, BURN = "AUTO", THIN = 10 } }
`;

  it('lists what the v1 → v2 migration changes and what is not imported, before applying', () => {
    const onImport = vi.fn().mockReturnValue(null);
    render(<MethodImportModal onClose={() => {}} onImport={onImport} />);
    fireEvent.change(screen.getByLabelText('Method TOML'), { target: { value: v1 } });
    const summary = screen.getByRole('list', { name: 'Migration summary' });
    const text = summary.textContent ?? '';
    expect(text).toContain('[STEP1] CONSTRAINTS / FIX / FIT buckets → ordered ROLES');
    expect(text).toContain('bare GRID tuple "[PB] = (0.01, 0.05, 0.10)" → values(…)');
    expect(text).toContain('FITMETHOD = "least_squares" removed');
    expect(text).toContain('[STEP2] implicit role carry-over → ROLES_FROM = "STEP1"');
    expect(text).toContain('[STEP2] implicit selection carry-over → INCLUDE repeated from STEP1');
    expect(text).toContain('MCMC BURN = "AUTO" → BURN omitted');
    expect(text).toContain('MCMC THIN dropped');
    expect(within(screen.getByRole('list', { name: 'Not imported' })).getByText(/\[PB\] < 0\.5/)).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply migrated v2 method' }));
    expect(onImport).toHaveBeenCalledWith(v1);
  });

  it('shows a v2 file plainly and reports parse errors', () => {
    render(<MethodImportModal onClose={() => {}} onImport={() => null} />);
    fireEvent.change(screen.getByLabelText('Method TOML'), { target: { value: 'FORMAT_VERSION = 2\n\n[A]\n\n[B]\nROLES_FROM = "A"\n' } });
    expect(screen.getByText('VERSION 2')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Migration summary' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Method TOML'), { target: { value: '[A\nROLES = [' } });
    expect(screen.getByText(/Cannot parse/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Apply method' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('parse result carries format and migration notes', () => {
    expect(tomlToConfig('FORMAT_VERSION = 2\n[A]\n')).toMatchObject({ format: 'v2', migration: [] });
    expect(tomlToConfig('[A]\nFIT = ["PB"]\n').format).toBe('v1');
  });
});

describe('ChemEx errors inline per section', () => {
  const issue = (field: string, message: string, index?: number): ValidationError => ({
    stepId: 's', stepName: 'S', message, severity: 'error', origin: 'chemex', source: { step: 'S', field, index },
  });
  const step: Step = {
    id: 's', name: 'S', residueMode: 'include', residues: [], parameters: [],
    search: { mode: 'grid', axes: [{ id: 'x', param: 'PB', fn: 'lin', low: 0.1, high: 0.2, count: 3 }] },
    statistics: { mc: { enabled: true, replicates: 0 } },
  };

  it('puts search syntax errors on their axis and statistics errors in the statistics section', () => {
    render(
      <>
        <StepSearchSection step={step} onChange={() => {}} family="cest" availableParams={DEFAULT_PARAM_METAS} chemexIssues={[issue('SEARCH.GRID.AXES', 'GRID count must be at least 2', 0)]} />
        <StepStatisticsSection step={step} onChange={() => {}} chemexIssues={[issue('STATISTICS.MC', 'REPLICATES must be a positive integer')]} />
      </>
    );
    expect(screen.getByText('GRID count must be at least 2')).toBeDefined();
    expect(screen.getAllByText('1 ChemEx error', { selector: 'span' })).toHaveLength(2); // search + statistics headers
    expect(screen.getByText('REPLICATES must be a positive integer')).toBeDefined();
  });
});
