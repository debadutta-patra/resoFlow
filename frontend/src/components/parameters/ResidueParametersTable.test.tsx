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

describe('ResidueParametersTable table tools', () => {
  const initial: ParameterConfig = {
    globals: {},
    residues: {
      '3N': { cs_a: { value: 118, source: { kind: 'manual' } }, dw_ab: { value: 2, source: { kind: 'manual' } } },
      '4N': { cs_a: { value: 120, source: { kind: 'manual' } } },
    },
  };

  it('counts ChemEx-default residues and filters them; Stale chip is always shown', () => {
    render(<Harness initial={initial} onConfig={() => {}} />);
    // 3N has CS_A and DW_AB; 4N lacks DW_AB → 1 residue starts from a ChemEx default.
    fireEvent.click(screen.getByRole('button', { name: /ChemEx default \(1\)/ }));
    expect(screen.queryByLabelText('CS_A for 3N')).toBeNull();
    expect(screen.getByLabelText('CS_A for 4N')).toBeDefined();
    expect(screen.getByRole('button', { name: /Pick Moved \(0\)/ })).toBeDefined();
  });

  it('bulk-sets and bulk-clears a parameter on selected rows', () => {
    let latest: ParameterConfig = initial;
    render(<Harness initial={initial} onConfig={c => (latest = c)} />);
    fireEvent.click(screen.getByLabelText('Select all visible residues'));
    expect(screen.getByText('2 selected')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Bulk parameter'), { target: { value: 'r2_a' } });
    const v = screen.getByLabelText('Bulk value');
    fireEvent.focus(v);
    fireEvent.change(v, { target: { value: '14' } });
    fireEvent.blur(v);
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(latest.residues['3N'].r2_a?.value).toBe(14);
    expect(latest.residues['4N'].r2_a?.value).toBe(14);
    fireEvent.change(screen.getByLabelText('Bulk parameter'), { target: { value: 'cs_a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(latest.residues['3N'].cs_a).toBeUndefined();
    expect(latest.residues['4N'].r2_a?.value).toBe(14);
  });

  it('shows R1_A/R2_A columns behind a toggle', () => {
    render(<Harness initial={initial} onConfig={() => {}} />);
    expect(screen.queryByLabelText('R2_A column for 3N')).toBeNull();
    fireEvent.click(screen.getByLabelText('R1_A/R2_A columns'));
    expect(screen.getByLabelText('R2_A column for 3N')).toBeDefined();
  });
});

describe('ResidueParametersTable issues', () => {
  it('badges rows with issues and focuses a row on request (switching page)', () => {
    const profiles = Array.from({ length: 60 }, (_, i) => ({ residue: `${i + 1}N` }));
    const issue = { id: 'x', scope: 'residue' as const, residue: '55N', severity: 'warning' as const, message: 'bad' };
    const { rerender } = render(
      <ResidueParametersTable
        config={{ globals: {}, residues: {} }}
        onChange={() => {}}
        picks={{}}
        profiles={profiles}
        issuesByResidue={{ '55N': [issue] }}
      />
    );
    expect(screen.queryByLabelText('CS_A for 55N')).toBeNull(); // page 2
    rerender(
      <ResidueParametersTable
        config={{ globals: {}, residues: {} }}
        onChange={() => {}}
        picks={{}}
        profiles={profiles}
        issuesByResidue={{ '55N': [issue] }}
        focus={{ resKey: '55N', nonce: 1 }}
      />
    );
    expect(screen.getByLabelText('CS_A for 55N')).toBeDefined();
    expect(document.getElementById('param-row-55N')?.className).toContain('ring-amber-400');
    expect(screen.getByLabelText('1 validation issue')).toBeDefined();
  });
});
