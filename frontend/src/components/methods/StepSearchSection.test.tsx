/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import StepSearchSection from './StepSearchSection';
import { createDefaultStep, type Step } from '../../lib/methodConfig';
import { configToToml } from '../../lib/methodToml';
import { DEFAULT_PARAM_METAS } from './ParameterTable';
import { isValidSeed } from '../../lib/seed';

afterEach(cleanup);

let latest: Step | undefined;
function Harness({ family }: { family: string }) {
  const [step, setStep] = useState<Step>(createDefaultStep);
  const onChange = (next: Step) => {
    latest = next;
    setStep(next);
  };
  return <StepSearchSection step={step} onChange={onChange} family={family} availableParams={DEFAULT_PARAM_METAS} />;
}

describe('StepSearchSection', () => {
  it('fills physically relevant CPMG grid defaults and emits SEARCH.GRID', () => {
    render(<Harness family="cpmg" />);
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(latest?.search?.mode).toBe('grid');
    expect(latest?.search?.axes.map(a => [a.param, a.fn, a.low, a.high, a.count])).toEqual([
      ['PB', 'log', 0.005, 0.2, 10],
      ['KEX_AB', 'log', 100, 10000, 12],
    ]);
    const toml = configToToml({ steps: [latest!] });
    expect(toml).toContain('[STEP1.SEARCH.GRID]');
    expect(toml).toContain('"[KEX_AB] = log(100, 10000, 12)"');
  });

  it('switching to DE generates a seed and drops point counts', () => {
    render(<Harness family="cest" />);
    fireEvent.click(screen.getByRole('button', { name: 'Differential evolution' }));
    expect(latest?.search?.mode).toBe('de');
    expect(isValidSeed(latest?.search?.seed)).toBe(true);
    const toml = configToToml({ steps: [latest!] });
    expect(toml).toMatch(/\[STEP1\.SEARCH\.DE\]\nSEED = \d+\nCOORDINATES = \[\n {2}"\[PB\] = log\(0\.001, 0\.3\)",/);
  });
});
