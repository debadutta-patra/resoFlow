/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ExchangeAnalysisManager } from './ExchangeAnalysisManager';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: { status: 'success' } }),
    put: vi.fn().mockResolvedValue({ data: { status: 'success' } }),
  },
}));

vi.mock('../context/RunsContext', () => ({
  useOptionalUserRuns: () => ({ refreshRuns: vi.fn() }),
}));

vi.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('./Plot', () => ({
  default: ({ onClick, layout }: any) => (
    <div
      data-testid="mock-plot"
      data-xaxis-title={layout?.xaxis?.title}
      data-xaxis-autorange={String(layout?.xaxis?.autorange)}
      onClick={() => onClick && onClick({ points: [{ x: 120.5 }] })}
    />
  ),
  PLOT_COLORS: { primary: '#2563eb', secondary: '#9333ea' },
}));

describe('ExchangeAnalysisManager', () => {
  beforeEach(() => {
    window.alert = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const baseAnalysis = {
    id: 1,
    analysis_uuid: 'test-uuid-123',
    name: 'test_combined',
    analysis_type: 'EXCHANGE',
    status: 'SETUP',
    parameters: null,
  };

  it('detects CPMG and CEST spectra and allows toggling selection', () => {
    const spectra = [
      { id: 1, name: 'cpmg_rd_spec.ft2', experiment_type: 'CPMG-RD', b0: 600, b1: null, temperature: 298 },
      { id: 2, name: 'cpmg_plain.ft2', experiment_type: 'CPMG', b0: 800, b1: null, temperature: 298 },
      { id: 3, name: 'cest_spec.ft2', experiment_type: 'CEST', b0: 600, b1: 30, temperature: 298 },
    ];

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={spectra}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText('cpmg_rd_spec.ft2')).toBeDefined();
    expect(screen.getByText('cpmg_plain.ft2')).toBeDefined();
    expect(screen.getByText('cest_spec.ft2')).toBeDefined();

    // Checkboxes exist for the spectra
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(3);

    fireEvent.click(checkboxes[0]);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it('handles empty or missing spectra gracefully', () => {
    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText('No CPMG spectra in this project.')).toBeDefined();
    expect(screen.getByText('No CEST spectra in this project.')).toBeDefined();
  });

  it('calls exchange/generate endpoint when Generate Experiment Files is clicked', async () => {
    const api = (await import('../services/api')).default;
    (api.post as any).mockResolvedValueOnce({
      data: {
        status: 'success',
        experiments: [{ filename: 'cest_600MHz_30hz.toml', path: '/tmp/cest.toml', type: 'CEST', residue_count: 5 }],
        cest_profiles: [],
        cpmg_profiles: [],
      },
    });

    const spectra = [
      { id: 10, name: 'cest_sample.ft2', experiment_type: 'CEST', b0: 600, b1: 30, temperature: 298 },
    ];

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={spectra}
        onUpdate={vi.fn()}
      />
    );

    // Select spectrum
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    // Click Generate Experiment Files
    const genBtn = screen.getByText('Generate Experiment Files');
    fireEvent.click(genBtn);

    expect(api.post).toHaveBeenCalledWith(
      '/api/projects/proj-123/analysis/test-uuid-123/exchange/generate',
      expect.objectContaining({
        spectrum_ids: [10],
        model: '2st',
        cest_module_name: 'cest_15n',
        cpmg_module_name: 'cpmg_15n_ip',
      })
    );
  });

  it('navigates between all tabs: experiments, pick_cest, dispersion, parameters, methods, logs', () => {
    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    // Click Pick CEST tab
    const pickCestBtn = screen.getByRole('button', { name: /Pick CEST/i });
    fireEvent.click(pickCestBtn);
    expect(screen.getByText(/No CEST Profiles Available/i)).toBeDefined();

    // Click Inspect Dispersion tab
    const dispersionBtn = screen.getByRole('button', { name: /Inspect Dispersion/i });
    fireEvent.click(dispersionBtn);
    expect(screen.getByText(/No CPMG Dispersion Profiles Available/i)).toBeDefined();

    // Click Parameters tab
    const paramsBtn = screen.getByRole('button', { name: /^Parameters/i });
    fireEvent.click(paramsBtn);
    expect(screen.getByText(/ChemEx Parameters Configuration/i)).toBeDefined();
    expect(screen.getByText(/Inherit from run/i)).toBeDefined();
    expect(screen.getByText(/Re-sync from Picks/i)).toBeDefined();
    expect(screen.getByText(/Generated parameters\.toml Preview/i)).toBeDefined();

    // Click Methods tab
    const methodsBtn = screen.getByRole('button', { name: /^Methods/i });
    fireEvent.click(methodsBtn);
    expect(screen.getByText(/ChemEx Method Configuration/i)).toBeDefined();
    expect(screen.getByText(/Templates/i)).toBeDefined();
    expect(screen.getByText(/Generated method\.toml Preview/i)).toBeDefined();

    // Click Logs tab
    const logsBtn = screen.getByRole('button', { name: /^Logs/i });
    fireEvent.click(logsBtn);
    expect(screen.getByText(/Waiting for ChemEx logs/i)).toBeDefined();
  });

  it('calls exchange/run endpoint when Run ChemEx is clicked', async () => {
    const api = (await import('../services/api')).default;
    (api.get as any).mockResolvedValueOnce({
      data: {
        generatedExperiments: [{ filename: 'exp1.toml', path: '/work/exp1.toml' }],
        spectrum_ids: [1],
      },
    });

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[{ id: 1, name: 'spec1.ft2', experiment_type: 'CPMG', b0: 600 }]}
        onUpdate={vi.fn()}
      />
    );

    // Wait for config load
    await waitFor(() => {
      const runBtns = screen.getAllByText(/Run ChemEx/i);
      expect(runBtns.length).toBeGreaterThan(0);
    });

    const runBtn = screen.getAllByText(/Run ChemEx/i)[0];
    fireEvent.click(runBtn);

    expect(api.post).toHaveBeenCalledWith(
      '/api/projects/proj-123/analysis/test-uuid-123/exchange/run',
      expect.objectContaining({
        model: '2st',
      })
    );
  });

  it('calls exchange/cancel endpoint when Stop Run is clicked during RUNNING status', async () => {
    const api = (await import('../services/api')).default;
    const runningAnalysis = {
      ...baseAnalysis,
      status: 'RUNNING',
    };

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={runningAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    const stopBtn = screen.getByRole('button', { name: /Stop Run/i });
    fireEvent.click(stopBtn);

    expect(api.post).toHaveBeenCalledWith(
      '/api/projects/proj-123/analysis/test-uuid-123/exchange/cancel'
    );
  });

  it('calls exchange/config endpoint when Save Config is clicked', async () => {
    const api = (await import('../services/api')).default;
    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    const saveBtn = screen.getByRole('button', { name: /Save Config/i });
    fireEvent.click(saveBtn);

    expect(api.put).toHaveBeenCalledWith(
      '/api/projects/proj-123/analysis/test-uuid-123/exchange/config',
      expect.objectContaining({
        model: '2st',
        cest_module_name: 'cest_15n',
        cpmg_module_name: 'cpmg_15n_ip',
      })
    );
  });

  it('handles Pick CEST mode cycling and accept & next navigation', async () => {
    const api = (await import('../services/api')).default;
    const mockProfiles = [
      {
        residue: '15N',
        full_residue: 'ALA-15N',
        experiments: [
          {
            b1: '30',
            b1_actual: 30,
            b0: 600,
            carrier: 117.0,
            offsets: [0, 50, 100],
            intensities: [1.0, 0.8, 0.5],
            uncertainties: [0.02, 0.02, 0.02],
            filepath: '/tmp/test.toml',
          },
        ],
      },
      {
        residue: '16N',
        full_residue: 'VAL-16N',
        experiments: [
          {
            b1: '30',
            b1_actual: 30,
            b0: 600,
            carrier: 117.0,
            offsets: [0, 50, 100],
            intensities: [1.0, 0.9, 0.6],
            uncertainties: [0.02, 0.02, 0.02],
            filepath: '/tmp/test2.toml',
          },
        ],
      },
    ];

    (api.get as any).mockResolvedValueOnce({
      data: {
        cest_profiles: mockProfiles,
        picks: {},
      },
    });

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    // Switch to Pick CEST tab
    const pickTabBtn = screen.getByRole('button', { name: /Pick CEST/i });
    fireEvent.click(pickTabBtn);

    // Verify initial pick mode pill displays CS_A
    await waitFor(() => {
      expect(screen.getByText(/Click to set: CS_A/i)).toBeDefined();
    });

    // Clicking the pill cycles to CS_B
    const pillBtn = screen.getByTitle(/Click to cycle pick mode/i);
    fireEvent.click(pillBtn);
    expect(screen.getByText(/Click to set: CS_B/i)).toBeDefined();

    // Clicking mock plot picks coordinate and auto-advances back to CS_A (for 2st model)
    const mockPlot = screen.getByTestId('mock-plot');
    fireEvent.click(mockPlot);
    expect(screen.getByText(/Click to set: CS_A/i)).toBeDefined();

    // Clicking Accept & Next advances to next profile
    const acceptBtn = screen.getByRole('button', { name: /Accept & Next/i });
    fireEvent.click(acceptBtn);

    // Selected residue dropdown should now be VAL-16N
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('1');
  });

  it('supports raw TOML editing and preview toggle in Parameters tab', async () => {
    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    const paramsBtn = screen.getByRole('button', { name: /^Parameters/i });
    fireEvent.click(paramsBtn);

    // Toggle Raw TOML
    const rawBtn = screen.getByRole('button', { name: /Edit Raw TOML/i });
    fireEvent.click(rawBtn);
    expect(screen.getByText(/Raw TOML Mode Active/i)).toBeDefined();

    // Toggle Preview
    const previewBtn = screen.getByRole('button', { name: /Generated parameters\.toml Preview/i });
    fireEvent.click(previewBtn);
    expect(screen.getByTitle(/Copy TOML to clipboard/i)).toBeDefined();
    expect(screen.getByTitle(/Download parameters\.toml/i)).toBeDefined();
  });

  it('supports Method Templates modal and raw edit mode in Methods tab', async () => {
    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={baseAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    const methodsBtn = screen.getByRole('button', { name: /^Methods/i });
    fireEvent.click(methodsBtn);

    // Click Templates button
    const templatesBtn = screen.getByRole('button', { name: /Templates/i });
    fireEvent.click(templatesBtn);
    expect(screen.getByText(/Choose a pre-configured fitting protocol preset/i)).toBeDefined();

    // Apply template
    const useTemplateBtns = screen.getAllByRole('button', { name: /Use Template/i });
    expect(useTemplateBtns.length).toBeGreaterThan(0);
    fireEvent.click(useTemplateBtns[0]);

    // Check preview button
    const previewBtn = screen.getByRole('button', { name: /Generated method\.toml Preview/i });
    fireEvent.click(previewBtn);
    expect(screen.getByTitle(/Copy TOML to clipboard/i)).toBeDefined();
    expect(screen.getByTitle(/Download method\.toml/i)).toBeDefined();
  });

  it('renders Results tab with summary cards, separate CEST and CPMG plots, and forward CPMG axis', async () => {
    const api = (await import('../services/api')).default;
    const mockResults = {
      fit_mode: 'global',
      global: {
        kex_ab: 150.5,
        kex_ab_err: 5.2,
        pb: 0.045,
        pb_err: 0.003,
        kab: 6.77,
        kba: 143.73,
        tau_b: 0.00695,
        chi2: 124.5,
        chi2_red: 1.15,
        ndata: 120,
        nvarys: 12,
      },
      residues: {
        '15N': {
          cs_a: { value: 118.5, stderr: 0.02 },
          dw_ab: { value: 2.3, stderr: 0.05 },
          chi2_red: 1.12,
          experiments: [
            {
              experiment_type: 'cest',
              b1_label: 'B1=25Hz',
              exp_name: 'cest_exp1',
              exp_points: { x: [115, 116, 117, 118, 119], y: [0.95, 0.9, 0.5, 0.2, 0.8], y_err: [0.02, 0.02, 0.02, 0.02, 0.02] },
              calc_points: { x: [115, 116, 117, 118, 119], y: [0.94, 0.89, 0.51, 0.21, 0.79] },
            },
            {
              experiment_type: 'cpmg',
              b1_label: '600MHz CPMG',
              exp_name: 'cpmg_exp1',
              nu_cpmg: [50, 100, 200, 400, 800],
              r2eff: [18.5, 16.2, 14.1, 12.8, 12.1],
              r2eff_err: [0.4, 0.3, 0.3, 0.2, 0.2],
              fit_curve: {
                x: [50, 100, 200, 400, 800],
                y: [18.4, 16.1, 14.0, 12.7, 12.0],
              },
            },
          ],
        },
        '16N': {
          cs_a: { value: 122.1, stderr: 0.03 },
          dw_ab: { value: -1.8, stderr: 0.04 },
          chi2_red: 1.35,
          experiments: [
            {
              experiment_type: 'cest',
              b1_label: 'B1=25Hz',
              exp_name: 'cest_exp2',
              exp_points: { x: [120, 121, 122, 123], y: [0.9, 0.7, 0.3, 0.8], y_err: [0.02, 0.02, 0.02, 0.02] },
              calc_points: { x: [120, 121, 122, 123], y: [0.9, 0.7, 0.3, 0.8] },
            },
          ],
        },
      },
      residue_mapping: {
        '15N': 'ALA-15N',
        '16N': 'VAL-16N',
      },
    };

    (api.get as any).mockImplementation((url: string) => {
      if (url.includes('/results')) {
        return Promise.resolve({ data: { results: mockResults } });
      }
      return Promise.resolve({ data: {} });
    });

    const completedAnalysis = {
      ...baseAnalysis,
      status: 'COMPLETED',
    };

    render(
      <ExchangeAnalysisManager
        projectUuid="proj-123"
        analysis={completedAnalysis}
        availableSpectra={[]}
        onUpdate={vi.fn()}
      />
    );

    // Verify Results tab loads
    await waitFor(() => {
      expect(screen.getByText(/Global Analysis Summary/i)).toBeDefined();
    });

    // Verify summary card metric labels
    expect(screen.getByText('k_ex (ab)')).toBeDefined();
    expect(screen.getByText('p_b')).toBeDefined();
    expect(screen.getByText('k_ab (forward)')).toBeDefined();
    expect(screen.getByText('k_ba (backward)')).toBeDefined();
    expect(screen.getByText('τ_B (Lifetime)')).toBeDefined();
    expect(screen.getByText('Reduced χ²')).toBeDefined();
    expect(screen.getByText('Overall χ²')).toBeDefined();

    // Verify PDF report and ZIP export buttons
    expect(screen.getByRole('button', { name: /Report \(PDF\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Download Output \(ZIP\)/i })).toBeDefined();

    // Verify both CEST and CPMG sections appear for residue 15N
    expect(screen.getByText(/CEST Profiles \(I\/I₀ vs Offset\)/i)).toBeDefined();
    expect(screen.getByText(/CPMG Relaxation Dispersion \(R₂,eff vs ν_CPMG\)/i)).toBeDefined();

    // Verify Plot calls: CPMG plot has autorange="true" (forward axis!)
    // CEST plot has autorange="reversed"
    const plots = screen.getAllByTestId('mock-plot');
    const cpmgMainPlot = plots.find(p => p.getAttribute('data-xaxis-title') === 'ν_CPMG (Hz)');
    expect(cpmgMainPlot).toBeDefined();
    expect(cpmgMainPlot?.getAttribute('data-xaxis-autorange')).toBe('true');

    const cestMainPlot = plots.find(p => p.getAttribute('data-xaxis-autorange') === 'reversed');
    expect(cestMainPlot).toBeDefined();

    // Test thumbnail grid toggle
    const thumbnailsBtn = screen.getByRole('button', { name: /Thumbnails/i });
    fireEvent.click(thumbnailsBtn);
    expect(screen.getByText(/All Residues Thumbnail Grid/i)).toBeDefined();

    // Switch back to single view
    const singleBtn = screen.getByRole('button', { name: /Single/i });
    fireEvent.click(singleBtn);
    expect(screen.getByText(/Combined Exchange Curves/i)).toBeDefined();

    // Test filtering residues
    const searchInput = screen.getByPlaceholderText(/Filter residues/i);
    fireEvent.change(searchInput, { target: { value: 'VAL-16N' } });
    expect(screen.getByText(/1 \/ 2/i)).toBeDefined();
  });
});


