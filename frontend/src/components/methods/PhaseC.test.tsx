/**
 * @vitest-environment jsdom
 *
 * Phase C (round 2): project-level switches for the scientific checks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ScienceChecksModal from './ScienceChecksModal';

afterEach(cleanup);

describe('Scientific checks dialog', () => {
  it('lists every check with its current state and saves toggles and the data-ratio threshold', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<ScienceChecksModal settings={{ 'b1-fields': { enabled: false } }} onClose={onClose} onSave={onSave} />);
    const b1 = screen.getByRole('checkbox', { name: /Global exchange from one B1 field/ }) as HTMLInputElement;
    expect(b1.checked).toBe(false);
    const ratio = screen.getByRole('checkbox', { name: /Data points per fitted coordinate/ }) as HTMLInputElement;
    expect(ratio.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Minimum points per local coordinate'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Strong correlations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      'data-ratio': { enabled: true, threshold: 15 },
      'b1-fields': { enabled: false },
      'r2b-per-residue': { enabled: true },
      'kex-cest-window': { enabled: true },
      'strong-correlation': { enabled: false },
    });
  });
});
