/**
 * @vitest-environment jsdom
 *
 * Phase 3: deterministic search — per-axis ChemEx resolution, Add FIT rule,
 * evaluation count and runtime estimate, notes, refine step.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, renderHook, act, screen, cleanup, fireEvent } from '@testing-library/react';
import StepSearchSection from './StepSearchSection';
import { DEFAULT_PARAM_METAS } from './ParameterTable';
import type { Step } from '../../lib/methodConfig';
import type { ResolvedSearch } from '../../lib/resolvedRoles';
import { configToToml } from '../../lib/methodToml';
import { isValidSeed } from '../../lib/seed';
import { useMethodEditor } from '../../hooks/useMethodEditor';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: { parameters: [] } }), put: vi.fn() },
}));

afterEach(cleanup);

const gridStep: Step = {
  id: 'g',
  name: 'GRID',
  residueMode: 'include',
  residues: ['13', '26'],
  parameters: [
    { name: 'PB', mode: 'fit' },
    { name: 'DW_AB', mode: 'fix' },
  ],
  search: {
    mode: 'grid',
    axes: [
      { id: 'a', param: 'PB', fn: 'values', low: 0, high: 0, count: 0, values: [0.01, 0.02] },
      { id: 'b', param: 'DW_AB', fn: 'lin', low: -5, high: 5, count: 3 },
      { id: 'c', param: 'DW_AB', qualifier: 'NUC->26N', fn: 'values', low: 0, high: 0, count: 0, values: [1, 2] },
    ],
  },
};

const resolvedGrid: ResolvedSearch = {
  kind: 'grid',
  axes: [
    { index: 0, selector: 'PB', coordinates: ['__PB'], points: 2, owned: 1, error: null },
    { index: 1, selector: 'DW_AB', coordinates: [], points: 3, owned: 0, error: { message: 'GRID selector has no active final independent FIT coordinate; active non-FIT matches: __DW_AB_13N', type: 'MethodFormatError', source: {} } },
    { index: 2, selector: 'DW_AB, NUC->26N', coordinates: ['__DW_AB_26N'], points: 2, owned: 1, error: null },
  ],
  global_points: 2,
  local_points: { '13N': 3, '26N': 2 },
  evaluations: 10,
};

function Harness(props: { resolved?: ResolvedSearch | null; stale?: boolean; onRefine?: () => void; initial?: Step }) {
  const [step, setStep] = useState<Step>(props.initial ?? gridStep);
  return (
    <>
      <StepSearchSection
        step={step}
        onChange={setStep}
        family="cest"
        availableParams={DEFAULT_PARAM_METAS}
        resolvedSearch={props.resolved}
        resolvedStale={props.stale}
        timings={[{ name: 'GRID', seconds: 40, evaluations: 20 }]}
        onAddRefineStep={props.onRefine}
      />
      <pre data-testid="toml">{configToToml({ steps: [step] })}</pre>
    </>
  );
}

describe('GRID search section', () => {
  it('shows what each axis resolves to and fixes a non-FIT target with one click', () => {
    render(<Harness resolved={resolvedGrid} />);
    expect(screen.getAllByText('→ 1 FIT coordinate')).toHaveLength(2);
    expect(screen.getByText(/no active final independent FIT coordinate/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Add FIT rule/ }));
    // The rule is appended after the table's FIX (later actions win), so DW_AB becomes FIT.
    expect(screen.getByTestId('toml').textContent).toContain('ROLES = [\n  { FIX = ["DW_AB"] },\n  { FIT = ["PB"] },\n  { FIT = ["DW_AB"] },\n]');
  });

  it('reports factorised evaluations and a runtime estimate from the last run', () => {
    render(<Harness resolved={resolvedGrid} />);
    expect(screen.getByText(/GRID · 10 profiled evaluations/)).toBeDefined();
    expect(screen.getByText(/≈ 20 s — last run's GRID took 2.00 s per fit/)).toBeDefined();
    expect(screen.getByText(/later, more specific axis/)).toBeDefined();
  });

  it('marks broad axes overridden by later specific ones', () => {
    const replaced: ResolvedSearch = {
      ...resolvedGrid,
      axes: [resolvedGrid.axes[0], { ...resolvedGrid.axes[1], coordinates: ['__DW_AB_13N', '__DW_AB_26N'], owned: 1, error: null }, resolvedGrid.axes[2]],
    };
    render(<Harness resolved={replaced} />);
    expect(screen.getByText(/1 replaced by a later axis/)).toBeDefined();
  });

  it('ignores a stale resolution and explains GRID limits with a refine-step shortcut', () => {
    const onRefine = vi.fn();
    render(<Harness resolved={resolvedGrid} stale onRefine={onRefine} />);
    expect(screen.queryByText(/no active final independent/)).toBeNull();
    expect(screen.getByText(/withholds covariance errors/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Add TRF refine step after/ }));
    expect(onRefine).toHaveBeenCalled();
  });
});

describe('DE search section', () => {
  it('pre-fills a full-range seed, re-rolls it and states the no-fallback rule', () => {
    render(<Harness initial={{ ...gridStep, search: undefined }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Differential evolution' }));
    const seed = screen.getByLabelText('SEED (required):') as HTMLInputElement;
    expect(isValidSeed(seed.value)).toBe(true);
    const before = seed.value;
    fireEvent.click(screen.getByRole('button', { name: /Re-roll/ }));
    expect(seed.value).not.toBe(before);
    expect(screen.getByText(/does/).textContent).toMatch(/not fall back to a plain TRF fit/);
    expect(screen.queryByRole('option', { name: 'values' })).toBeNull();
  });
});

describe('Add TRF refine step after', () => {
  it('inserts a step with ROLES_FROM = the grid step and the same selection', async () => {
    const { result } = renderHook(() =>
      useMethodEditor({ projectUuid: 'p', analysisUuid: 'a', family: 'cest', model: '2st', residueItems: [], isResidueExcluded: () => false, exclusionKey: [] })
    );
    act(() => result.current.setMethodConfig({ steps: [gridStep] }));
    act(() => result.current.stepHandlers.onAddRefineStep(0));
    const [, refine] = result.current.methodConfig.steps;
    expect(refine.name).toBe('GRID_REFINE');
    expect(refine.rolesFromStepId).toBe('g');
    expect(refine.residues).toEqual(['13', '26']);
    expect(result.current.activeStepIdx).toBe(1);
    expect(result.current.effectiveMethodToml).toContain('[GRID_REFINE]\nINCLUDE = [13, 26]\nROLES_FROM = "GRID"\n');
  });
});

describe('restoring a config saved before search targets stopped being auto-fitted', () => {
  it('makes the old implicit FIT explicit so the roles do not change', () => {
    const { result } = renderHook(() =>
      useMethodEditor({ projectUuid: 'p', analysisUuid: 'a', family: 'cest', model: '2st', residueItems: [], isResidueExcluded: () => false, exclusionKey: [] })
    );
    const saved: Step = {
      id: 's',
      name: 'OLD',
      residueMode: 'include',
      residues: [],
      parameters: [{ name: 'DW_AB', mode: 'fit' }],
      search: { mode: 'grid', axes: [{ id: 'a', param: 'KEX_AB', fn: 'log', low: 20, high: 2000, count: 5 }, { id: 'b', param: 'R2_A', qualifier: 'NUC->3N', fn: 'lin', low: 1, high: 9, count: 3 }] },
    };
    act(() => {
      result.current.restore({ method_config: { steps: [saved] } });
    });
    // Same ROLES the old emitter produced (it injected these silently).
    expect(result.current.effectiveMethodToml).toContain('ROLES = [\n  { FIT = ["DW_AB", "KEX_AB"] },\n  { FIT = ["R2_A, NUC->3N"] },\n]');
  });
});
