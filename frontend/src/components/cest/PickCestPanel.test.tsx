/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

const plots: any[] = [];
vi.mock('../Plot', () => ({
  default: (props: any) => {
    plots.push(props);
    return <div data-testid="plot" />;
  },
  PLOT_COLORS: { primary: '#2563eb' },
}));

const post = vi.fn();
vi.mock('../../services/api', () => ({ default: { post: (...a: any[]) => post(...a) } }));
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

import { PickCestPanel, type CestMasks, type CestPickSet, type PickKey } from './PickCestPanel';
import { EMPTY_REVIEW, type ReviewState } from '../../lib/residueReview';

const XI = 0.101329118;
const HZ = 600 * XI;
function profile(residue: string, cs: number, hsqc?: number) {
  const offsets = [-100000];
  const intensities = [1];
  for (let i = 0; i < 41; i++) {
    const ppm = 116 + i * 0.1;
    offsets.push((ppm - 118) * HZ);
    intensities.push(1 - 0.6 / (1 + ((ppm - cs) / 0.2) ** 2));
  }
  return {
    residue,
    cs_hsqc: hsqc,
    experiments: [
      { b1: '600MHz_67hz', b0: 600, carrier: 118, offsets, intensities, uncertainties: intensities.map(() => 0.01) },
      { b1: '600MHz_25hz', b1_actual: 25, b0: 600, carrier: 118, offsets, intensities: intensities.map(v => v * 0.98), uncertainties: [] },
    ],
  };
}

function Harness(props: { fittedShifts?: any; initialPicks?: Record<string, CestPickSet> }) {
  const [picks, setPicks] = useState<Record<string, CestPickSet>>(props.initialPicks ?? {});
  const [mode, setMode] = useState<PickKey>('cs_a');
  const [masks, setMasks] = useState<CestMasks>({});
  const [review, setReview] = useState<ReviewState>(EMPTY_REVIEW);
  return (
    <>
      <PickCestPanel
        profiles={[profile('10N', 117.73, 117.9), profile('11N', 118.5)]}
        picks={picks}
        onPick={(res, key, v) => {
          const before = picks[res];
          setPicks(p => ({ ...p, [res]: { ...p[res], [key]: v } }));
          return () => setPicks(p => ({ ...p, [res]: before ?? {} }));
        }}
        pickMode={mode}
        setPickMode={setMode}
        model="2st"
        xiRatio={XI}
        unitLabel="ppm"
        masks={masks}
        setMasks={u => setMasks(u)}
        isExcluded={() => false}
        toggleExclude={() => {}}
        review={review}
        setReview={u => setReview(u)}
        fittedShifts={props.fittedShifts}
        projectUuid="p"
        analysisUuid="a"
      />
      <pre data-testid="state">{JSON.stringify({ picks, masks, mode })}</pre>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent || '{}');
const mainPlot = () => plots.filter(p => p.layout?.yaxis?.title === 'I/I0').at(-1);
const dataTraces = () => mainPlot().data.filter((t: any) => t.meta?.kind === 'data');
const click = (ev: any) => act(() => mainPlot().onClick(ev));

describe('PickCestPanel', () => {
  beforeEach(() => {
    plots.length = 0;
    post.mockReset();
    post.mockResolvedValue({ data: { fits: {}, r2_stats: { flagged: [], median: null, threshold: null } } });
    window.history.replaceState(null, '', '/');
  });
  afterEach(cleanup);

  it('labels axes and fields correctly and draws raw data as markers only', () => {
    render(<Harness />);
    const p = mainPlot();
    expect(p.layout.xaxis.title).toBe('15N offset (ppm)');
    expect(p.layout.yaxis.title).toBe('I/I0');
    expect(dataTraces().map((t: any) => t.name)).toEqual(['600 MHz, B1 = 67 Hz', '600 MHz, B1 = 25 Hz']);
    for (const t of dataTraces()) expect(t.mode).toBe('markers');
    // Error bars only where uncertainties exist.
    expect(dataTraces()[0].error_y?.visible).toBe(true);
    expect(dataTraces()[1].error_y).toBeUndefined();
  });

  it('click snaps to the dip minimum; Alt-click does not', () => {
    render(<Harness />);
    click({ points: [{ x: 117.5 }] });
    expect(state().picks['10N'].cs_a).toBeCloseTo(117.73, 1);
    expect(state().mode).toBe('cs_b');
    click({ points: [{ x: 119.31 }], event: { altKey: true } });
    expect(state().picks['10N'].cs_b).toBe(119.31);
  });

  it('shows signed Δϖ in ppm and Hz', () => {
    render(<Harness initialPicks={{ '10N': { cs_a: 118, cs_b: 117 } }} />);
    expect(screen.getByTestId('delta-varpi').textContent).toBe(`Δϖ −1.000 ppm (−${(HZ).toFixed(1)} Hz)`);
  });

  it('shift-click masks an offset (hollow marker), shift-click again unmasks', () => {
    render(<Harness />);
    const t = dataTraces()[0];
    const pt = { x: t.x[5], customdata: t.customdata[5], data: t };
    click({ points: [pt], event: { shiftKey: true } });
    expect(state().masks).toEqual({ '600MHz_67hz': [6] });
    expect(dataTraces()[0].marker.symbol[5]).toBe('circle-open');
    expect(state().picks).toEqual({}); // masking does not pick
    click({ points: [{ ...pt, data: dataTraces()[0] }], event: { shiftKey: true } });
    expect(state().masks).toEqual({});
  });

  it('dragging a pick line moves the pick', () => {
    render(<Harness initialPicks={{ '10N': { cs_a: 118, cs_b: 119 } }} />);
    act(() => mainPlot().onRelayout({ 'shapes[1].x0': 119.4, 'shapes[1].x1': 119.4 }));
    expect(state().picks['10N'].cs_b).toBe(119.4);
  });

  it('suggests CS_A from the previous run, else HSQC; Accept commits it', () => {
    render(<Harness fittedShifts={{ '11N': { cs_a: 118.45 } }} />);
    expect(screen.getByText(/suggested CS_A 117.900 \(HSQC peak\)/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Accept & Next/ }));
    expect(state().picks['10N'].cs_a).toBe(117.9);
    expect(screen.getByText(/suggested CS_A 118.450 \(previous run\)/)).toBeDefined();
  });

  it('No excited state is distinct from unreviewed in the table', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'No excited state' }));
    expect(document.querySelector('[data-status="no_excited_state"]')).not.toBeNull();
    expect(document.querySelector('[data-status="unreviewed"]')).not.toBeNull();
  });

  it('overlays the one-state fit and residual subplot, and marks high R2', async () => {
    const fitExp = (label: string) => ({ label, x_ppm: [117, 118], planes: [1, 2], residuals: [0.01, -0.02], used: [true, false], curve: { x_ppm: [117, 118], y: [0.9, 0.5] } });
    post.mockResolvedValue({
      data: {
        fits: { '10N': { cs_a: 117.7, r2: 31.2, r2_err: 0.4, r1: 1.5, redchi: 1.1, experiments: [fitExp('600MHz_67hz')] } },
        r2_stats: { flagged: ['10N'], median: 10.1, threshold: 14 },
      },
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('one-state-r2').textContent).toContain('31.2'));
    expect(post).toHaveBeenCalledWith('/api/projects/p/analysis/a/inspection/cest/one-state', { masks: {}, xi: XI });
    expect(screen.getByTestId('one-state-r2').className).toContain('amber');
    const p = mainPlot();
    const fitLine = p.data.find((t: any) => t.mode === 'lines');
    expect(fitLine.name).toContain('one-state fit');
    expect(p.data.find((t: any) => t.yaxis === 'y2').mode).toBe('markers');
    expect(p.layout.yaxis2).toBeDefined();
    expect(p.layout.xaxis.anchor).toBe('y2');
  });

  it('difference trace toggle adds low − high B1 markers on a secondary axis', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Difference trace' }));
    const d = mainPlot().data.find((t: any) => t.yaxis === 'y3');
    expect(d.mode).toBe('markers');
    expect(d.name).toBe('Difference: 600 MHz, B1 = 25 Hz − 600 MHz, B1 = 67 Hz');
  });

  it('heatmap row click selects that residue', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Overview heatmap/ }));
    const heat = plots.filter(p => p.data?.[0]?.type === 'heatmap');
    expect(heat).toHaveLength(2);
    act(() => heat.at(-1).onClick({ points: [{ customdata: '11N' }] }));
    expect(new URLSearchParams(window.location.search).get('res')).toBe('11N');
  });
});
