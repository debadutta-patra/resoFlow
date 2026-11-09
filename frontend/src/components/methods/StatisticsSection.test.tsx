/**
 * @vitest-environment jsdom
 *
 * Phase 4: statistics editor — fields on demand, placeholders, compact vs
 * expanded emission, cost estimate and notes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import StepStatisticsSection from './StepStatisticsSection';
import type { Step } from '../../lib/methodConfig';
import { configToToml } from '../../lib/methodToml';
import { isValidSeed } from '../../lib/seed';

afterEach(cleanup);

const base: Step = { id: 's', name: 'LOCAL', residueMode: 'all', residues: [], parameters: [{ name: 'PB', mode: 'fit' }] };

function Harness({ initial = base }: { initial?: Step }) {
  const [step, setStep] = useState<Step>(initial);
  return (
    <>
      <StepStatisticsSection
        step={step}
        onChange={setStep}
        timings={[{ name: 'LOCAL', seconds: 300, fit_seconds: 6, evaluations: 1, mcmc_seconds: 50, mcmc_steps: 1000 }]}
        workers={4}
      />
      <pre data-testid="toml">{configToToml({ steps: [step] })}</pre>
    </>
  );
}

const toml = () => screen.getByTestId('toml').textContent ?? '';
const open = () => fireEvent.click(screen.getByRole('button', { name: /Statistics \(MC, BS, BSN, MCMC\)/ }));

describe('statistics editor', () => {
  it('shows replicate and seed fields only once a method is ticked, with the documented placeholders', () => {
    render(<Harness />);
    open();
    expect(screen.queryByLabelText('Replicates')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Monte Carlo/ }));
    expect((screen.getByLabelText('Replicates') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText(/Seed/) as HTMLInputElement).placeholder).toBe('ChemEx generates and records one');
    fireEvent.click(screen.getByRole('checkbox', { name: /MCMC posterior/ }));
    expect((screen.getByLabelText(/BURN/) as HTMLInputElement).placeholder).toBe('auto (ceil(2·τ_max))');
    expect(toml()).toContain('STATISTICS = { MC = 100, MCMC = 5000 }');
    expect(screen.getByText('Written as STATISTICS = { MC = 100, MCMC = 5000 }')).toBeDefined();
  });

  it('switches to expanded tables when a BURN or seed is set, and back when cleared', () => {
    render(<Harness />);
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Bootstrap/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /MCMC posterior/ }));
    const burn = screen.getByLabelText(/BURN/);
    fireEvent.change(burn, { target: { value: '400' } });
    expect(toml()).toContain('[LOCAL.STATISTICS.BS]\nREPLICATES = 100\n\n[LOCAL.STATISTICS.MCMC]\nSTEPS = 5000\nBURN = 400\n');
    expect(screen.getByText(/Written as expanded/)).toBeDefined();
    fireEvent.change(burn, { target: { value: '' } });
    expect(toml()).toContain('STATISTICS = { BS = 100, MCMC = 5000 }');

    fireEvent.click(screen.getByRole('button', { name: /Random seed for bs-s-seed/ }));
    const seed = (screen.getAllByLabelText(/Seed/)[0] as HTMLInputElement).value;
    expect(isValidSeed(seed)).toBe(true);
    expect(toml()).toContain(`[LOCAL.STATISTICS.BS]\nREPLICATES = 100\nSEED = ${seed}\n`);

    fireEvent.change(burn, { target: { value: '9000' } });
    expect(screen.getByText('BURN must be a non-negative integer smaller than STEPS.')).toBeDefined();
  });

  it('estimates cost as replicates × fit time ÷ workers, plus MCMC scaled from the last chain', () => {
    render(<Harness />);
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: /Monte Carlo/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Bootstrap/ }));
    // 200 refits × 6 s ÷ 4 workers = 300 s = 5 min.
    expect(screen.getByText(/= 200 full refits/).textContent).toMatch(/≈ 5 min with 4 workers \(last run's LOCAL: 6.00 s per fit\)/);
    fireEvent.click(screen.getByRole('checkbox', { name: /MCMC posterior/ }));
    expect(screen.getByText(/MCMC ≈ 4 min/)).toBeDefined(); // 50 s / 1000 steps × 5000
    expect(screen.getByText(/write their summaries only if every replicate succeeds/)).toBeDefined();
  });

  it('explains GRID-step statistics', () => {
    render(<Harness initial={{ ...base, search: { mode: 'grid', axes: [{ id: 'a', param: 'PB', fn: 'lin', low: 0.01, high: 0.1, count: 3 }] } }} />);
    open();
    expect(screen.getByText(/statistics start from the accepted grid state/)).toBeDefined();
  });
});
