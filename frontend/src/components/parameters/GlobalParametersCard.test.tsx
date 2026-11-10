/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { GlobalParametersCard } from './GlobalParametersCard';
import { addableGlobals } from '../../lib/globalParams';
import type { ParameterConfig } from '../../lib/parameterConfig';
import type { AvailableParamMeta } from '../methods/ParameterTable';
import { configToToml, tomlToConfig } from '../../lib/parameterToml';

afterEach(cleanup);

const row = (name: string, scope: 'global' | 'residue', extra: Partial<AvailableParamMeta> = {}): AvailableParamMeta => ({
  name,
  gloss: name,
  scope,
  ...extra,
});
const CATALOG: AvailableParamMeta[] = [
  row('PB', 'global', { default_value: 0.05, lower: 0, upper: 1 }),
  row('KEX_AB', 'global', { default_value: 200 }),
  row('CS_A', 'residue'),
  row('DW_AB', 'residue', { default_value: 0 }),
  row('R1_A', 'residue'),
  row('R2_A', 'residue', { default_value: 10 }),
  row('R2_B', 'residue', { derived: true, default_expression: '[R2_A]' }),
  row('TAUC_A', 'global'),
  row('TREF', 'global', { protected: true }),
];

describe('addableGlobals', () => {
  it('offers catalogue rows not shown yet, skipping protected and model-derived rows', () => {
    const names = addableGlobals([...CATALOG, row('PA', 'global', { derived: true })], ['pb', 'kex_ab', 'tauc_a']).map(r => r.name);
    expect(names).toEqual(['CS_A', 'DW_AB', 'R1_A', 'R2_A', 'R2_B']);
  });
});

function Harness({ onConfig }: { onConfig: (c: ParameterConfig) => void }) {
  const [config, setConfig] = useState<ParameterConfig>({ globals: {}, residues: {} });
  return (
    <GlobalParametersCard
      config={config}
      onChange={c => {
        setConfig(c);
        onConfig(c);
      }}
      catalogGlobals={['PB', 'KEX_AB', 'TAUC_A']}
      catalog={CATALOG}
    />
  );
}

describe('+ Add global parameter', () => {
  it('adds a blanket R2_A to [GLOBAL], explains precedence, and removes it again', () => {
    let latest: ParameterConfig = { globals: {}, residues: {} };
    render(<Harness onConfig={c => (latest = c)} />);
    fireEvent.change(screen.getByLabelText('Add global parameter'), { target: { value: 'r2_a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    const input = document.getElementById('global-r2_a') as HTMLInputElement;
    expect(input.placeholder).toBe('ChemEx default: 10');
    expect(screen.getByText(/per-residue \[R2_A\] entries override it/)).toBeDefined();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.blur(input);
    expect(latest.globals.r2_a?.value).toBe(15);
    expect(configToToml(latest)).toContain('[GLOBAL]\nR2_A = 15');

    fireEvent.click(screen.getByRole('button', { name: /Remove R2_A from \[GLOBAL\]/ }));
    expect(latest.globals.r2_a).toBeUndefined();
    expect(document.getElementById('global-r2_a')).toBeNull();
  });

  it('warns that a global R2_B breaks the default R2_B = [R2_A] link', () => {
    render(<Harness onConfig={() => {}} />);
    fireEvent.change(screen.getByLabelText('Add global parameter'), { target: { value: 'r2_b' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(screen.getByText(/replaces ChemEx's default link \(R2_B = \[R2_A\]\)/)).toBeDefined();
  });
});

describe('import section order', () => {
  it('warns when [GLOBAL] comes after a per-residue section for the same parameter', () => {
    const { warnings } = tomlToConfig('[R2_A]\n3N = 7\n\n[GLOBAL]\nR2_A = 20\nPB = 0.1\n');
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain('[GLOBAL] R2_A comes after [R2_A]');
    expect(tomlToConfig('[GLOBAL]\nR2_A = 20\n\n[R2_A]\n3N = 7\n').warnings).toBeUndefined();
  });
});
