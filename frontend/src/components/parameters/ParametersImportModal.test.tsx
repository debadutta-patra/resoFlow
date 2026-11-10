/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ParametersImportModal } from './ParametersImportModal';

afterEach(cleanup);

const LEGACY = '[GLOBAL]\nTREF = 20.0\n\n[DWP_AB]\n3N = 2.0\n\n[DWM_AB]\n3N = 0.01\n';

describe('ParametersImportModal obsolete DWP/DWM', () => {
  const open = () => {
    const onImport = vi.fn();
    render(<ParametersImportModal isOpen onClose={() => {}} onImport={onImport} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: LEGACY } });
    return onImport;
  };

  it('shows a conversion preview and requires an explicit choice', () => {
    const onImport = open();
    expect(screen.getByLabelText('DWP/DWM conversion preview').textContent).toContain('2.2');
    const importBtn = screen.getByRole('button', { name: /Parse & Import/ }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Convert to DW0/DW1' }));
    fireEvent.click(importBtn);
    const config = onImport.mock.calls[0][0];
    expect(config.residues['3N'].dw0_ab.value).toBeCloseTo(2.2);
    expect(config.residues['3N'].dwp_ab).toBeUndefined();
  });

  it('keeps the file unchanged on request', () => {
    const onImport = open();
    fireEvent.click(screen.getByRole('button', { name: 'Keep as is' }));
    fireEvent.click(screen.getByRole('button', { name: /Parse & Import/ }));
    expect(onImport.mock.calls[0][0].residues['3N'].dwp_ab.value).toBe(2);
  });
});
