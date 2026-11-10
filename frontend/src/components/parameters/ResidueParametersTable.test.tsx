/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ResidueParametersTable } from './ResidueParametersTable';
import type { ParameterConfig } from '../../lib/parameterConfig';

afterEach(cleanup);

function Harness({ initial, onConfig }: { initial: ParameterConfig; onConfig: (c: ParameterConfig) => void }) {
  const [config, setConfig] = useState(initial);
  return (
    <ResidueParametersTable
      config={config}
      onChange={c => {
        setConfig(c);
        onConfig(c);
      }}
      picks={{ '3N': { cs_a: 118.25, cs_b: 121.5 } }}
      profiles={[{ residue: '3N' }, { residue: '4N' }]}
    />
  );
}

describe('ResidueParametersTable inputs', () => {
  it('shows only written values; an un-applied pick is a hint, the placeholder is the ChemEx default', () => {
    render(<Harness initial={{ globals: {}, residues: {} }} onConfig={() => {}} />);
    const csA = screen.getByLabelText('CS_A for 3N') as HTMLInputElement;
    expect(csA.value).toBe('');
    expect(csA.placeholder).toBe('ChemEx 0');
    expect(screen.getAllByText(/118\.250 · not applied/).length).toBe(1);
    expect((screen.getByLabelText('CS_B for 3N') as HTMLInputElement).disabled).toBe(true);
  });

  it('commits on blur; clearing a cell unsets it instead of writing 0; negative DW accepted', () => {
    let latest: ParameterConfig = { globals: {}, residues: {} };
    const initial: ParameterConfig = {
      globals: {},
      residues: { '4N': { cs_a: { value: 120, source: { kind: 'manual' } }, dw_ab: { value: 2, source: { kind: 'manual' } } } },
    };
    render(<Harness initial={initial} onConfig={c => (latest = c)} />);
    const dw = screen.getByLabelText('DW_AB for 4N') as HTMLInputElement;
    fireEvent.focus(dw);
    fireEvent.change(dw, { target: { value: '-7.25' } });
    expect(latest.residues['4N']).toBeUndefined(); // nothing committed while typing
    fireEvent.blur(dw);
    expect(latest.residues['4N'].dw_ab?.value).toBe(-7.25);

    fireEvent.focus(dw);
    fireEvent.change(dw, { target: { value: '' } });
    fireEvent.blur(dw);
    expect(latest.residues['4N'].dw_ab).toBeUndefined();
    expect(latest.residues['4N'].cs_a?.value).toBe(120);
  });
});
