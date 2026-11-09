/**
 * @vitest-environment jsdom
 *
 * Phase 1: ordered ROLES editor, selector builder, Mixed / protected table state,
 * and the ChemEx-resolved roles preview.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, render, renderHook, screen, cleanup, fireEvent, within } from '@testing-library/react';
import StepRolesSection from './StepRolesSection';
import SelectorBuilder from './SelectorBuilder';
import ParameterTable, { DEFAULT_PARAM_METAS } from './ParameterTable';
import ResolvedRolesSummary from './ResolvedRolesSummary';
import type { Step } from '../../lib/methodConfig';
import { buildParameterCatalog } from '../../lib/baselineRoles';
import { configToToml } from '../../lib/methodToml';
import type { ResolveReport } from '../../lib/resolvedRoles';

const post = vi.fn();
vi.mock('../../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: {} }), post: (...a: unknown[]) => post(...a), put: vi.fn() } }));

afterEach(cleanup);

const catalog = buildParameterCatalog([
  { id: '__PB', name: 'PB', status: 'fit' },
  { id: '__KAB', name: 'KAB', status: 'constrain', protected: true },
  { id: '__DW_AB_24N', name: 'DW_AB', status: 'fit', spin: 'G24N', conditions: { h_larmor_frq: 800.1 } },
  { id: '__DW_AB_31N', name: 'DW_AB', status: 'fit', spin: 'G31N', conditions: { h_larmor_frq: 800.1 } },
]);
const names = ['PB', 'KAB', 'DW_AB', 'R2_A'];

const baseStep: Step = {
  id: 's',
  name: 'STEP',
  residueMode: 'include',
  residues: [],
  parameters: [{ name: 'DW_AB', mode: 'fix' }],
  roleRules: [
    { id: 'r1', action: 'FIT', entries: ['DW_AB, NUC->G24N'] },
    { id: 'r2', action: 'CONSTRAIN', entries: ['[DW_AB, NUC->G31N] = [DW_AB, NUC->G24N]'] },
  ],
};

function RolesHarness({ onChange, errors = [] }: { onChange?: (s: Step) => void; errors?: never[] }) {
  const [step, setStep] = useState(baseStep);
  return (
    <StepRolesSection
      step={step}
      stepIdx={0}
      steps={[step]}
      onChange={s => {
        setStep(s);
        onChange?.(s);
      }}
      paramNames={names}
      catalog={catalog}
      chemexErrors={errors}
    />
  );
}

describe('ordered ROLES editor', () => {
  it('numbers table actions first, then rules, matching the emitted ROLES order', () => {
    render(<RolesHarness />);
    const list = screen.getByRole('list', { name: 'Ordered ROLES actions' });
    expect(within(list).getByText('From the parameter table (applied first)')).toBeDefined();
    expect(screen.getByLabelText('ROLES entry 2').textContent).toBe('2.');
    expect(screen.getByLabelText('ROLES entry 3').textContent).toBe('3.');
    expect(configToToml({ steps: [baseStep] })).toContain(
      'ROLES = [\n  { FIX = ["DW_AB"] },\n  { FIT = ["DW_AB, NUC->G24N"] },\n  { CONSTRAIN = ["[DW_AB, NUC->G31N] = [DW_AB, NUC->G24N]"] },\n]'
    );
  });

  it('reorders by drag from the grip (and only from the grip) and by keyboard buttons', () => {
    const changes: Step[] = [];
    render(<RolesHarness onChange={s => changes.push(s)} />);
    const [first, second] = ['r1', 'r2'].map(id => document.getElementById(`role-rule-${id}`)!);
    expect(first.getAttribute('draggable')).toBe('false');
    fireEvent.mouseDown(within(first).getByTitle('Drag to change precedence'));
    expect(first.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(first, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(second);
    fireEvent.drop(second);
    expect(changes.at(-1)!.roleRules!.map(r => r.id)).toEqual(['r2', 'r1']);

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 3 up' }));
    expect(changes.at(-1)!.roleRules!.map(r => r.id)).toEqual(['r1', 'r2']);
  });

  it('places ChemEx errors on the exact rule entry', () => {
    const err = { message: 'Duplicate selector qualifier NUC', type: 'MethodFormatError', source: { step: 'STEP', field: 'ROLES[1].FIT[0]', action_index: 1, action: 'FIT', entry_index: 0 } };
    render(<RolesHarness errors={[err as never]} />);
    const rule = document.getElementById('role-rule-r1')!;
    expect(within(rule).getByText('Duplicate selector qualifier NUC')).toBeDefined();
    expect(within(document.getElementById('role-rule-r2')!).queryByText(/Duplicate/)).toBeNull();
  });
});

describe('selector builder', () => {
  function Builder({ purpose = 'FIT' as const, initial = 'DW_AB' }) {
    const [v, setV] = useState(initial);
    return (
      <>
        <SelectorBuilder value={v} onChange={setV} paramNames={names} catalog={catalog} purpose={purpose} />
        <output data-testid="value">{v}</output>
      </>
    );
  }

  it('disables protected parameters for FIT/FIX and fills qualifier values from the data', () => {
    render(<Builder />);
    const opt = screen.getByRole('option', { name: 'KAB (model-derived)' }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Add qualifier'), { target: { value: 'NUC' } });
    expect(screen.getByTestId('value').textContent).toBe('DW_AB, NUC->G24N');
    const datalist = document.querySelector('datalist')!;
    expect([...datalist.querySelectorAll('option')].map(o => o.value)).toEqual(['G24N', 'G31N']);
    fireEvent.change(screen.getByLabelText('NUC qualifier'), { target: { value: 'G31N' } });
    expect(screen.getByTestId('value').textContent).toBe('DW_AB, NUC->G31N');
    fireEvent.click(screen.getByLabelText('Remove NUC'));
    expect(screen.getByTestId('value').textContent).toBe('DW_AB');
  });

  it('falls back to raw text for malformed selectors and shows the grammar error', () => {
    render(<Builder initial="DW_AB, FOO->1" />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('DW_AB, FOO->1');
    expect(screen.getByText(/Unknown or malformed selector qualifier/)).toBeDefined();
  });
});

describe('parameter table quick view', () => {
  const row = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('tr') as HTMLElement;

  it('shows Mixed for rule-targeted parameters, locks protected ones and shows resolved counts', () => {
    const onShowRules = vi.fn();
    render(
      <ParameterTable
        step={baseStep}
        onChange={() => {}}
        availableParams={[...DEFAULT_PARAM_METAS, { name: 'KAB', gloss: 'k AB', scope: 'global', is_primary: true }]}
        baselineRoles={{ loading: false, error: null, roles: null, catalog }}
        resolvedCounts={{ DW_AB: { fit: 1, fix: 0, constrained: 1, derived: 0 } }}
        onShowRules={onShowRules}
      />
    );
    const dw = row('DW_AB');
    // No single treatment is shown for a parameter the rules override.
    expect(within(dw).queryByRole('button', { name: 'Fix' })).toBeNull();
    fireEvent.click(within(dw).getByRole('button', { name: /Mixed · 2 rules/ }));
    expect(onShowRules).toHaveBeenCalledWith('DW_AB');
    fireEvent.click(within(dw).getByRole('button', { name: /table action: Fix \(applied first\)/ }));
    expect(within(dw).getByRole('button', { name: 'Fix' })).toBeDefined();
    expect(within(dw).getByText('Resolved: Fit 1 · Constrained 1')).toBeDefined();

    expect(within(row('KAB')).getByText(/Model-derived · protected/)).toBeDefined();
    expect(within(row('KAB')).queryByRole('button', { name: 'Fit' })).toBeNull();
  });
});

const report: ResolveReport = {
  valid: true,
  format: 'v2',
  errors: [],
  steps: [
    {
      name: 'LOCAL_FITS',
      roles_from: 'GLOBAL_FIT',
      profiles: 3,
      error: null,
      counts: { fit: 3, fix: 1, constrained: 1, derived: 1 },
      parameters: [
        { id: '__PB', name: 'PB', spin: '', conditions: {}, scope: 'global', role: 'fit', expression: '', decided_by: 'baseline', rule: null, protected: false },
        { id: '__KEX_AB', name: 'KEX_AB', spin: '', conditions: {}, scope: 'global', role: 'fit', expression: '', decided_by: 'rule', rule: { step: 'GLOBAL_FIT', action_index: 0, entry_index: 1, action: 'FIT', inherited: true }, protected: false },
        { id: '__DW_AB_24N', name: 'DW_AB', spin: 'G24N', conditions: {}, scope: 'residue', role: 'fit', expression: '', decided_by: 'rule', rule: { step: 'LOCAL_FITS', action_index: 1, entry_index: 0, action: 'FIT', inherited: false }, protected: false },
        { id: '__DW_AB_31N', name: 'DW_AB', spin: 'G31N', conditions: {}, scope: 'residue', role: 'constrained', expression: '[DW_AB, NUC->G24N]', decided_by: 'rule', rule: { step: 'LOCAL_FITS', action_index: 2, entry_index: 0, action: 'CONSTRAIN', inherited: false }, protected: false },
        { id: '__DW_AB_40N', name: 'DW_AB', spin: 'G40N', conditions: {}, scope: 'residue', role: 'fix', expression: '', decided_by: 'rule', rule: { step: 'LOCAL_FITS', action_index: 0, entry_index: 0, action: 'FIX', inherited: false }, protected: false },
        { id: '__KAB', name: 'KAB', spin: '', conditions: {}, scope: 'global', role: 'derived', expression: '', decided_by: 'model', rule: null, protected: true },
      ],
    },
  ],
};

describe('resolved roles preview', () => {
  it('summarises the step and expands to a filterable table with rule attribution', () => {
    render(<ResolvedRolesSummary state={{ report, loading: false, stale: false, error: null }} stepName="local_fits" />);
    expect(screen.getByText('LOCAL_FITS: 2 global FIT · 1 residue FIT · 1 constrained · 1 fixed · 1 derived')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Resolved roles \(ChemEx\)/ }));
    expect(screen.getByText('ROLES #1 FIT of GLOBAL_FIT (ROLES_FROM)')).toBeDefined();
    expect(screen.getByText('kinetic model (protected)')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Filter resolved parameters'), { target: { value: 'g31' } });
    expect(screen.getByText('1 of 6 · 3 profiles')).toBeDefined();
  });

  it('lists ChemEx errors with their location', () => {
    const bad: ResolveReport = { ...report, valid: false, errors: [{ message: 'No parameter matches selector [XX]', type: 'MethodFormatError', source: { step: 'LOCAL_FITS', field: 'ROLES[0].FIX[0]', action_index: 0, action: 'FIX', entry_index: 0 } }] };
    render(<ResolvedRolesSummary state={{ report: bad, loading: false, stale: false, error: null }} stepName="LOCAL_FITS" />);
    expect(screen.getByText('1 ChemEx error')).toBeDefined();
    expect(screen.getByText('[LOCAL_FITS] ROLES #1 FIX, entry 1')).toBeDefined();
  });
});

describe('useResolvedRoles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    post.mockResolvedValue({ data: report });
  });
  afterEach(() => vi.useRealTimers());

  it('debounces requests by ~500 ms and sends the emitted method TOML', async () => {
    const { useResolvedRoles } = await import('../../hooks/useResolvedRoles');
    const { result, rerender } = renderHook(({ toml }) => useResolvedRoles({ projectUuid: 'p', analysisUuid: 'a-debounce', model: '2st', inputsKey: 'x', methodToml: toml }), {
      initialProps: { toml: 'FORMAT_VERSION = 2\n[A]\n' },
    });
    rerender({ toml: 'FORMAT_VERSION = 2\n[AB]\n' });
    rerender({ toml: 'FORMAT_VERSION = 2\n[ABC]\n' });
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/projects/p/analysis/a-debounce/methods/validate');
    expect(post.mock.calls[0][1]).toMatchObject({ model: '2st', method_toml: 'FORMAT_VERSION = 2\n[ABC]\n' });
    expect(result.current.report?.steps[0].name).toBe('LOCAL_FITS');
    expect(result.current.stale).toBe(false);
  });
});
