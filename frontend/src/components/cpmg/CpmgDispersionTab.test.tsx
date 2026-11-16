/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

const plots: any[] = [];
vi.mock('../Plot', () => {
  const P = (props: any) => {
    plots.push(props);
    return <div data-testid="plot" />;
  };
  return { Plot: P, default: P };
});
const post = vi.fn();
vi.mock('../../services/api', () => ({ default: { post: (...a: any[]) => post(...a) } }));
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

import { CpmgDispersionTab, type CpmgProfileItem } from './CpmgDispersionTab';

const exp = (b0: number, base: number) => ({
  b0,
  time_t2: 0.04,
  carrier: 118,
  // Acquisition order is not ν order; ν = 50 is duplicated.
  nu_cpmg: [1000, 50, 500, 50, 100],
  r2eff: [base, base + 10, base + 3, base + 11, base + 8],
  r2eff_err: [0.2, 0.2, 0.2, 0.2, 0.2],
  rex: 0,
  rex_err: 0,
  chi2_red: 1,
  is_flat: false,
});
const PROFILES: CpmgProfileItem[] = [
  { residue: '10N', full_residue: 'G10N', experiments: [exp(600.2649, 10), exp(800, 12)] },
  { residue: '11N', full_residue: 'A11N', experiments: [exp(600.2649, 10)] },
  { residue: '13N', full_residue: 'K13N', experiments: [exp(600.2649, 10)] },
];

const screeningResponse = {
  residues: {
    '10N': {
      rex: 10.5, rex_err: 0.2, rex_b0: 600.2649, max_ratio: 3.5,
      fields: [
        { b0: 600.2649, rex: 10.5, rex_err: 0.2, rex_err_pooled: 0.7, duplicates: { pooled_sd: 0.71, dof: 1, reported_rms: 0.2, ratio: 3.5 } },
        { b0: 800, rex: 9.0, rex_err: 0.2, rex_err_pooled: null, duplicates: { pooled_sd: null, dof: 0, reported_rms: null, ratio: null } },
      ],
    },
    '11N': { rex: 1.0, rex_err: 0.3, rex_b0: 600, max_ratio: 1.0, fields: [] },
    '13N': { rex: 4.0, rex_err: 0.3, rex_b0: 600, max_ratio: null, fields: [] },
  },
};

function renderTab(extra: Record<string, unknown> = {}) {
  const props = {
    profiles: PROFILES,
    parameterConfig: { globals: {}, residues: {}, excludedResidues: [] } as any,
    onToggleExcludeResidue: vi.fn(),
    onBulkSetExcludedResidues: vi.fn(),
    onSeedDeltaOmega: vi.fn(),
    onBulkSeedDeltaOmega: vi.fn(),
    onRexSeed: vi.fn(),
    projectUuid: 'p',
    analysisUuid: 'a',
    ...extra,
  };
  render(<CpmgDispersionTab {...props} />);
  return props;
}
const dispersionPlot = () => plots.filter(p => p.layout?.xaxis?.title?.text === 'ν_CPMG (Hz)').at(-1);

describe('CpmgDispersionTab', () => {
  beforeEach(() => {
    plots.length = 0;
    post.mockReset();
    post.mockResolvedValue({ data: screeningResponse });
    window.history.replaceState(null, '', '/');
  });
  afterEach(cleanup);

  it('draws markers only (no acquisition-order lines), duplicates as diamonds, field labels at 2 decimals', () => {
    renderTab();
    const data = dispersionPlot().data;
    expect(data.every((t: any) => t.mode === 'markers')).toBe(true);
    expect(data.map((t: any) => t.name)).toEqual(['600.26 MHz', '800 MHz']);
    expect(data[0].marker.symbol).toEqual(['circle', 'diamond', 'circle', 'diamond', 'circle']);
  });

  it('optional guide line goes through the mean at each ν in ν order', () => {
    renderTab();
    fireEvent.click(screen.getByLabelText(/Guide line/));
    const guide = dispersionPlot().data.find((t: any) => t.mode === 'lines');
    expect(guide.x).toEqual([50, 100, 500, 1000]);
    expect(guide.y).toEqual([20.5, 18, 13, 10]);
    expect(guide.line.width).toBeLessThan(1);
  });

  it('overlays fitted curves with a residual subplot after a run', () => {
    renderTab({ fitCurves: { '10N': [{ b0: 600.26, label: '600MHz', x: [0, 2000], y: [20, 10] }] } });
    const p = dispersionPlot();
    expect(p.data.find((t: any) => t.mode === 'lines').name).toBe('600.26 MHz fit');
    expect(p.data.find((t: any) => t.yaxis === 'y2').mode).toBe('markers');
    expect(p.layout.yaxis2).toBeDefined();
  });

  it('shows backend Rex ± error, pooled duplicate error next to σ in use, and flags spread', async () => {
    renderTab();
    expect(post).toHaveBeenCalledWith('/api/projects/p/analysis/a/inspection/cpmg/screening', expect.objectContaining({ profiles: expect.any(Array) }));
    await waitFor(() => expect(screen.getAllByTestId('field-chip')[0].textContent).toContain('Rex = 10.5 ± 0.2'));
    const chip = screen.getAllByTestId('field-chip')[0].textContent!;
    expect(chip).toContain('σ in use 0.20');
    expect(chip).toContain('pooled dup 0.71 (3.5×)');
    // Filter: duplicates above 3× → only 10N.
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'dup' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    // Raise the factor to 4: nothing flagged.
    fireEvent.change(screen.getByLabelText('Duplicate factor'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'dup' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(0);
  });

  it('Rex bar chart: draggable cutoff with live count, bar click selects, screening excludes below', async () => {
    const props = renderTab();
    await waitFor(() => expect(screen.getAllByTestId('field-chip')[0].textContent).toContain('10.5'));
    fireEvent.click(screen.getByRole('button', { name: /Screen on Rex Cutoff/ }));
    expect(screen.getByTestId('rex-above-count').textContent).toBe('2 / 3 above cutoff');
    const bars = plots.filter(p => p.data?.[0]?.type === 'bar').at(-1);
    expect(bars.data[0].x).toEqual([10, 11, 13]);
    act(() => bars.onRelayout({ 'shapes[0].y0': 5, 'shapes[0].y1': 5 }));
    expect(screen.getByTestId('rex-above-count').textContent).toBe('1 / 3 above cutoff');
    act(() => plots.filter(p => p.data?.[0]?.type === 'bar').at(-1).onClick({ points: [{ customdata: '13N' }] }));
    expect(new URLSearchParams(window.location.search).get('res')).toBe('13N');
    fireEvent.click(screen.getByRole('button', { name: /Exclude residues below cutoff/ }));
    expect(props.onBulkSetExcludedResidues).toHaveBeenCalledWith(['11N', '13N']);
  });

  it('seed dialog shows assumptions and a range, applies seeds and records the assumptions', async () => {
    const props = renderTab();
    await waitFor(() => expect(screen.getAllByTestId('field-chip')[0].textContent).toContain('10.5'));
    fireEvent.click(screen.getByRole('button', { name: /Seed All/ }));
    const dialog = screen.getByRole('dialog', { name: /Seed/ });
    expect(dialog.textContent).toContain('Rex ≈ pA·pB·Δω²/kex');
    fireEvent.change(screen.getByLabelText('pB'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByLabelText('kex'), { target: { value: '1000' } });
    expect(screen.getByTestId('seed-preview').textContent).toMatch(/\|Δω\| ≈ [\d.]+ ppm \(range [\d.]+ – [\d.]+\)/);
    fireEvent.click(screen.getByRole('button', { name: /Apply central seeds/ }));
    const seeds = (props.onBulkSeedDeltaOmega as any).mock.calls[0][0];
    expect(Object.keys(seeds).sort()).toEqual(['10N', '11N', '13N']);
    const rec = (props.onRexSeed as any).mock.calls[0][0];
    expect(rec).toMatchObject({ pb: 0.1, kex: 1000, residues: 3, relation: 'fast exchange: Rex ≈ pA·pB·Δω²/kex' });
  });

  it('inherits signed Δω from CEST picks and shows consistency', async () => {
    const props = renderTab({ cestPicks: { G10N: { cs_a: 118, cs_b: 116 }, '13N': { cs_a: 120, cs_b: 120.05 } } });
    await waitFor(() => expect(screen.getAllByTestId('field-chip')[0].textContent).toContain('10.5'));
    fireEvent.click(screen.getByRole('button', { name: /Inherit Δω from Pick CEST \(2\)/ }));
    expect(props.onBulkSeedDeltaOmega).toHaveBeenCalledWith({ '10N': -2, '13N': 0.05 });
    const cells = Array.from(document.querySelectorAll('[data-consistency]')).map(e => e.getAttribute('data-consistency'));
    expect(cells).toHaveLength(2);
    expect(cells).toContain('disagree'); // 0.05 ppm vs a Rex of 4 s⁻¹
  });
});
