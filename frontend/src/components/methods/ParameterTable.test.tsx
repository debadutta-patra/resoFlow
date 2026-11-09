/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import ParameterTable, { DEFAULT_PARAM_METAS } from './ParameterTable';
import type { Step } from '../../lib/methodConfig';

afterEach(cleanup);

const step: Step = {
  id: 's2',
  name: 'LOCAL_FITS',
  residueMode: 'all',
  residues: [],
  parameters: [
    { name: 'PB', mode: 'fit' },
    { name: 'DW_AB', mode: 'fit' },
    { name: 'KEX_AB', mode: 'fix' },
  ],
};

const row = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('tr') as HTMLElement;

describe('ParameterTable starting-value provenance', () => {
  it('first step shows the parameter-file value, its source and the Params link', () => {
    render(
      <ParameterTable
        step={{ ...step, name: 'STEP1' }}
        onChange={() => {}}
        availableParams={DEFAULT_PARAM_METAS}
        startingValues={{ PB: 0.05 }}
        startingProvenance={{ PB: { value: 0.05, source: 'default' }, DW_AB: { source: 'Per residue · Pick CEST' } }}
        stepIndex={0}
        onNavigateToParameters={() => {}}
      />
    );
    expect(within(row('PB')).getByText('0.05')).toBeDefined();
    expect(within(row('PB')).getByText(/· default/)).toBeDefined();
    expect(within(row('PB')).getByRole('button', { name: /Params/ })).toBeDefined();
    expect(within(row('DW_AB')).getByText('Auto')).toBeDefined();
    expect(within(row('DW_AB')).getByText(/Per residue · Pick CEST/)).toBeDefined();
  });

  it('later steps start from the previous committed result, not parameters.toml', () => {
    render(
      <ParameterTable
        step={step}
        onChange={() => {}}
        availableParams={DEFAULT_PARAM_METAS}
        startingValues={{ PB: 0.05 }}
        stepIndex={1}
        previousStepName="GLOBAL_FIT"
        committedByStep={{ GLOBAL_FIT: { PB: 0.0523 } }}
        onNavigateToParameters={() => {}}
      />
    );
    const pb = row('PB');
    expect(within(pb).getByText('From previous step result')).toBeDefined();
    expect(within(pb).getByText('(last run, GLOBAL_FIT: 0.0523)')).toBeDefined();
    expect(within(pb).queryByText('0.05')).toBeNull();
    expect(within(pb).queryByRole('button', { name: /Params/ })).toBeNull();
    // FIX rows say the same: values continue from the committed fit.
    expect(within(row('KEX_AB')).getByText('From previous step result')).toBeDefined();
  });
});

describe('ParameterTable resolved Default', () => {
  it('shows the ChemEx baseline role for parameters left at Default', () => {
    render(
      <ParameterTable
        step={{ ...step, parameters: [] }}
        onChange={() => {}}
        availableParams={DEFAULT_PARAM_METAS}
        baselineRoles={{ loading: false, error: null, catalog: null, roles: { CS_A: { fit: 0, fix: 16, derived: 0 }, R2_B: { fit: 16, fix: 0, derived: 0 } } }}
      />
    );
    expect(within(row('CS_A')).getByText('Default → Fixed')).toBeDefined();
    expect(within(row('R2_B')).getByText('Default → Fit')).toBeDefined();
    expect(within(row('PB')).getByText('Default → unresolved')).toBeDefined();
  });

  it('is fully disabled when read-only', () => {
    render(<ParameterTable step={step} onChange={() => {}} availableParams={DEFAULT_PARAM_METAS} readOnly />);
    const buttons = within(row('PB')).getAllByRole('button').filter(b => ['Default', 'Fit', 'Fix', 'Constrain'].includes(b.textContent || ''));
    expect(buttons.length).toBe(4);
    expect(buttons.every(b => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
