/**
 * @vitest-environment jsdom
 *
 * Phase B (round 2): last committed values, χ² landscape, step-tab results, Starting values menu.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import ParameterTable, { DEFAULT_PARAM_METAS } from './ParameterTable';
import StepTabs from './StepTabs';
import GridLandscape from './GridLandscape';
import StartingValuesMenu from '../chemex/StartingValuesMenu';
import type { OverviewStep, RunOverview } from '../../lib/runOverview';
import type { Step } from '../../lib/methodConfig';

const plotProps = vi.fn();
vi.mock('../Plot', () => ({
  default: (props: { data: unknown[]; layout: unknown }) => {
    plotProps(props);
    return <div data-testid="plot" />;
  },
}));

afterEach(() => {
  cleanup();
  plotProps.mockClear();
});

const committed: OverviewStep = {
  name: 'STEP2',
  status: 'complete',
  redchi: 0.91,
  chisqr: 1,
  ndata: 10,
  nvarys: 2,
  values: {
    PB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 0.012, stderr: 0.002 }] },
    DW_AB: {
      scope: 'residue',
      roles: ['fit'],
      copies: [
        { residue: '28N', qualifier: '', role: 'fit', value: 3, stderr: 0.1 },
        { residue: '13N', qualifier: '', role: 'fit', value: 1, stderr: 0.1 },
      ],
    },
  },
  residue_redchi: {},
  grid: null,
  mcmc: null,
  correlations: [],
};

const step: Step = { id: 's2', name: 'STEP2', residueMode: 'all', residues: [], parameters: [{ name: 'PB', mode: 'fit' }] };
const row = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('tr') as HTMLElement;

describe('Last committed column', () => {
  it('is hidden without a completed run', () => {
    render(<ParameterTable step={step} onChange={() => {}} availableParams={DEFAULT_PARAM_METAS} />);
    expect(screen.queryByText('Last committed')).toBeNull();
  });

  it('shows value ± error, a residue median with a per-residue popover, and flags a previous method', () => {
    render(<ParameterTable step={step} onChange={() => {}} availableParams={DEFAULT_PARAM_METAS} committedStep={committed} committedFromPreviousMethod />);
    expect(screen.getByText('Last committed')).toBeDefined();
    const pb = within(row('PB')).getByTestId('committed-PB');
    expect(pb.textContent).toBe('0.012 ± 0.002STEP2 (previous method)');
    const dw = within(row('DW_AB')).getByTestId('committed-DW_AB');
    expect(within(dw).getByText('median 2 (1–3) · 2 res')).toBeDefined();
    fireEvent.click(within(dw).getByRole('button', { name: /per residue/ }));
    const pop = within(dw).getByRole('dialog');
    expect(Array.from(pop.querySelectorAll('td:first-child')).map(td => td.textContent)).toEqual(['13N', '28N']);
    expect(within(row('KEX_AB')).getByText('—')).toBeDefined();
  });
});

describe('step tab results', () => {
  const steps: Step[] = [
    { id: 'a', name: 'STEP1', residueMode: 'all', residues: [], parameters: [] },
    { id: 'b', name: 'STEP2', residueMode: 'all', residues: [], parameters: [] },
    { id: 'c', name: 'STEP3', residueMode: 'all', residues: [], parameters: [] },
  ];
  const handlers = { onSelectStep: vi.fn(), onAddStep: vi.fn(), onDuplicateStep: vi.fn(), onDeleteStep: vi.fn(), onRenameStep: vi.fn(), onReorderSteps: vi.fn() };

  it('shows a status dot and red-χ², and MCMC τ / ESS withheld / tentative burn that opens diagnostics', () => {
    const onOpenMcmc = vi.fn();
    render(
      <StepTabs
        steps={steps}
        activeStepIdx={0}
        {...handlers}
        results={{
          a: { state: 'ok', redchi: 1.84, mcmc: null },
          b: { state: 'ok', redchi: 0.91, mcmc: { tauMax: 5.2, essMin: null, tentative: true, withheld: false, essWithheld: true } },
          c: { state: 'failed', redchi: null, mcmc: null },
        }}
        onOpenMcmc={onOpenMcmc}
      />
    );
    const rows = screen.getAllByTestId('step-result');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('χ²ᵣ 1.84');
    expect(within(rows[0]).getByLabelText('Completed in the last run')).toBeDefined();
    expect(within(rows[2]).getByLabelText('Failed or did not commit in the last run')).toBeDefined();
    const badge = within(rows[1]).getByRole('button');
    expect(badge.textContent).toBe('τmax 5.2 · ESS withheld · tentative burn');
    fireEvent.click(badge);
    expect(onOpenMcmc).toHaveBeenCalledWith(1);
    expect(handlers.onSelectStep).not.toHaveBeenCalled();
  });
});

describe('χ² landscape', () => {
  it('loads the surface, marks the minimum and overlays the configured ranges', async () => {
    const loadSurface = vi.fn().mockResolvedValue({
      x_param: 'PB', y_param: 'KEX_AB', x: [0.01, 0.0316, 0.1], y: [20, 63, 200],
      z_chisqr: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], z_delta: [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
      min_point: { x: 0.01, y: 200, chisqr: 639 },
    });
    render(
      <GridLandscape
        stepName="STEP1"
        grid={{
          chisqr: 639, best: { PB: 0.01, KEX_AB: 200 }, pairs: [['PB', 'KEX_AB']], profiles_1d: {},
          axes: [
            { param: 'PB', fn: 'log', qualifier: '', values: [0.01, 0.0316, 0.1], low: 0.01, high: 0.1, count: 3, best: 0.01, edge: 'low' },
            { param: 'KEX_AB', fn: 'log', qualifier: '', values: [20, 63, 200], low: 20, high: 200, count: 3, best: 200, edge: 'high' },
          ],
        }}
        axes={[
          { id: '1', param: 'PB', fn: 'log', low: 0.001, high: 0.1, count: 5 },
          { id: '2', param: 'KEX_AB', fn: 'log', low: 20, high: 2000, count: 5 },
        ]}
        loadSurface={loadSurface}
      />
    );
    await waitFor(() => expect(screen.getByTestId('plot')).toBeDefined());
    expect(loadSurface).toHaveBeenCalledWith('STEP1', 'PB', 'KEX_AB');
    const props = plotProps.mock.calls.at(-1)![0] as { data: Array<{ type: string; x?: number[] }>; layout: { shapes: Array<Record<string, number>>; xaxis: { type: string } } };
    expect(props.data.map(d => d.type)).toEqual(['heatmap', 'scatter']);
    expect(props.data[1].x).toEqual([0.01]);
    expect(props.layout.shapes[0]).toMatchObject({ x0: 0.001, x1: 0.1, y0: 20, y1: 2000 });
    expect(props.layout.xaxis.type).toBe('log');
  });
});

describe('Starting values menu', () => {
  const overview: RunOverview = {
    schema: 1,
    state: 'complete',
    method_toml: null,
    step_order: ['STEP2'],
    steps: [committed],
  };
  it('previews the parameters-file diff before applying', () => {
    const onApply = vi.fn();
    const onContinue = vi.fn();
    render(
      <StartingValuesMenu
        overview={overview}
        parameterConfig={{ globals: { pb: { value: 0.05, source: { kind: 'default' } } }, residues: {} }}
        onApply={onApply}
        onContinueFromRun={onContinue}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Starting values/ }));
    expect(screen.getAllByRole('menuitem').map(m => m.textContent?.trim())).toEqual([
      'Write STEP2 fitted values → parameters',
      'New analysis with STEP2 state → parametersContinue from Run (restart.toml)',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Write STEP2 fitted values → parameters' }));
    expect(onApply).not.toHaveBeenCalled();
    const table = screen.getByRole('table', { name: 'Starting value changes' });
    const rows = Array.from(table.querySelectorAll('tbody tr')).map(r => Array.from(r.querySelectorAll('td')).map(td => td.textContent));
    expect(rows).toEqual([
      ['PB', '0.05', '0.012'],
      ['DW_AB · 28N', 'unset', '3'],
      ['DW_AB · 13N', 'unset', '1'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    expect(onApply.mock.calls[0][0].globals.pb.value).toBe(0.012);
    expect(onApply.mock.calls[0][0].residues['13N'].dw_ab.value).toBe(1);
  });
});
