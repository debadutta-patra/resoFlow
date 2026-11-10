/**
 * @vitest-environment jsdom
 *
 * The Parameters and Methods tabs must render the same layout and actions on every
 * ChemEx page; only plugin-declared capabilities may differ.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ParametersTab } from '../parameters/ParametersTab';
import { MethodsTab } from '../methods/MethodsTab';
import { useParameterEditor } from '../../hooks/useParameterEditor';
import { useMethodEditor } from '../../hooks/useMethodEditor';
import { cestPlugin } from '../../plugins/cestPlugin';
import { cpmgPlugin } from '../../plugins/cpmgPlugin';
import { exchangePlugin } from '../../plugins/exchangePlugin';
import type { ExperimentPlugin } from '../../lib/experimentPlugin';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), put: vi.fn() },
}));

afterEach(cleanup);

const profiles = [{ residue: '3N', full_residue: 'K3N', experiments: [] }];

function ParametersHarness({ plugin }: { plugin: ExperimentPlugin }) {
  const editor = useParameterEditor({
    createDefault: plugin.parameters.createDefaultParameters,
    codec: plugin.parameters.codec,
    profiles,
    picks: {},
  });
  return (
    <ParametersTab
      editor={editor}
      capabilities={plugin.parameters}
      projectUuid="p"
      analysisUuid="a"
      targetAnalysis={{ analysis_type: plugin.id.toUpperCase(), model: '2st', nucleus: '15N', static_field: 600, temperature: 298.15 }}
      picks={{}}
      profiles={profiles}
      methodConfig={{ steps: [] }}
      activeStepIdx={0}
      onNavigateToMethods={() => {}}
      onApplyInherited={() => {}}
    />
  );
}

const renderParameters = (plugin: ExperimentPlugin) => render(<ParametersHarness plugin={plugin} />);

describe.each([cestPlugin, cpmgPlugin, exchangePlugin])('Parameters tab on $id', plugin => {
  it('shows the shared header actions, globals card, residue table and TOML preview', () => {
    renderParameters(plugin);
    expect(screen.getByText('ChemEx Parameters Configuration')).toBeDefined();
    expect(screen.getByRole('button', { name: /Inherit from run/i })).toBeDefined();
    expect(screen.getByRole('button', { name: new RegExp(plugin.parameters.resync.buttonLabel, 'i') })).toBeDefined();
    expect(screen.getByRole('button', { name: /Import TOML/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Edit Raw TOML/i })).toBeDefined();
    expect(screen.getByText('Global Fit Settings')).toBeDefined();
    expect(screen.getByLabelText(/p_b/i)).toBeDefined();
    expect(screen.getByText(plugin.parameters.residueTable.heading)).toBeDefined();
    expect(screen.getByText(/Generated parameters.toml Preview/i)).toBeDefined();
  });
});

describe('Parameters tab capability differences', () => {
  it('offers "Seed CS_A from profiles" on CEST and EXCHANGE only', () => {
    renderParameters(cestPlugin);
    expect(screen.getByRole('button', { name: /Seed CS_A from profiles/i })).toBeDefined();
    cleanup();
    renderParameters(exchangePlugin);
    expect(screen.getByRole('button', { name: /Seed CS_A from profiles/i })).toBeDefined();
    cleanup();
    renderParameters(cpmgPlugin);
    expect(screen.queryByRole('button', { name: /Seed CS_A from profiles/i })).toBeNull();
  });

  it('unset globals show the ChemEx default as placeholder; DW_AB = 0 quick-fix only on dispersion pages', () => {
    renderParameters(cestPlugin);
    expect((screen.getByLabelText(/p_b/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/p_b/i) as HTMLInputElement).placeholder).toBe('ChemEx default: 0.05');
    expect(screen.getByText(/1 of 1/)).toBeDefined(); // residue starts from ChemEx defaults
    expect(screen.queryByRole('button', { name: /Set \[GLOBAL\] DW_AB/i })).toBeNull();
    cleanup();
    renderParameters(cpmgPlugin);
    fireEvent.click(screen.getByRole('button', { name: /Set \[GLOBAL\] DW_AB = 2/i }));
    expect((screen.getByLabelText(/Universal Δω/i) as HTMLInputElement).value).toBe('2');
    expect(screen.queryByRole('button', { name: /Set \[GLOBAL\] DW_AB/i })).toBeNull();
  });

  it('CEST shows the CS_B column; CPMG hides it and adds the universal DW_AB global', () => {
    renderParameters(cestPlugin);
    expect(screen.getByText('CS_B (ppm)')).toBeDefined();
    expect(screen.queryByLabelText(/Universal Δω/i)).toBeNull();
    cleanup();

    renderParameters(cpmgPlugin);
    expect(screen.queryByText('CS_B (ppm)')).toBeNull();
    expect(screen.getByLabelText(/Universal Δω/i)).toBeDefined();
    expect(screen.getByText(/From Peak Fit/)).toBeDefined();
  });

  it.each([cestPlugin, cpmgPlugin, exchangePlugin])('raw mode on $id offers Discard and Parse & Return', plugin => {
    renderParameters(plugin);
    fireEvent.click(screen.getByRole('button', { name: /Edit Raw TOML/i }));
    const textarea = screen.getByPlaceholderText(/parameters.toml/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain('Auto-generated ChemEx parameter file');
    fireEvent.change(textarea, { target: { value: '[GLOBAL]\nPB = 0.2\n' } });
    fireEvent.click(screen.getByRole('button', { name: /Parse & Return/i }));
    expect((screen.getByLabelText(/p_b/i) as HTMLInputElement).value).toBe('0.2');
    fireEvent.click(screen.getByRole('button', { name: /Edit Raw TOML/i }));
    expect(screen.getByRole('button', { name: /Discard Raw Edits/i })).toBeDefined();
  });
});

describe.each([cestPlugin, cpmgPlugin, exchangePlugin])('Methods tab on $id', plugin => {
  it('renders the same actions, dialogs and raw editor', () => {
    const Harness = () => {
      const editor = useMethodEditor({
        projectUuid: 'p',
        analysisUuid: 'a',
        family: plugin.endpointFamily,
        model: '2st',
        residueItems: [],
        isResidueExcluded: () => false,
        exclusionKey: undefined,
      });
      return (
        <MethodsTab
          editor={editor}
          analysisUuid="a"
          residueItems={[]}
          startingValues={{}}
          onNavigateToParameters={() => {}}
        />
      );
    };
    render(<Harness />);
    expect(screen.getByText('ChemEx Method Configuration')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Templates/i }));
    expect(screen.getByText('Method Templates')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    fireEvent.click(screen.getByRole('button', { name: /Edit Raw TOML/i }));
    expect(screen.getByRole('button', { name: /Discard Raw Edits/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Discard Raw Edits/i }));
    expect(screen.getByText(/Parameters for Step/i)).toBeDefined();
  });
});

