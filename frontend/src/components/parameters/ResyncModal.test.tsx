/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ResyncModal } from './ResyncModal';

describe('ResyncModal: extra excited states', () => {
  afterEach(cleanup);

  it('re-syncs DW_AC / DW_AD from CS_C / CS_D picks, and lists nothing for unpicked states', () => {
    const onApply = vi.fn();
    render(
      <ResyncModal
        isOpen
        onClose={() => {}}
        config={{ globals: {}, residues: {} }}
        picks={{ '10N': { cs_a: 118, cs_b: 117, cs_c: 120.5, cs_d: 115.25 } }}
        onApply={onApply}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Apply Selected \(4\)/ }));
    const r = onApply.mock.calls[0][0].residues['10N'];
    expect(r.cs_a.value).toBe(118);
    expect(r.dw_ab.value).toBe(-1);
    expect(r.dw_ac.value).toBe(2.5);
    expect(r.dw_ad.value).toBe(-2.75);
    expect(r.dw_ae).toBeUndefined();
    expect(r.dw_ac.source.kind).toBe('pick');
  });

  it('proposes removing a pick-seeded DW_AC whose CS_C pick was removed', () => {
    const onApply = vi.fn();
    const src = { kind: 'pick' as const, pickSetHash: 'old', at: '' };
    render(
      <ResyncModal
        isOpen
        onClose={() => {}}
        config={{ globals: {}, residues: { '10N': { cs_a: { value: 118, source: src }, dw_ab: { value: -1, source: src }, dw_ac: { value: 2.5, source: src } } } }}
        picks={{ '10N': { cs_a: 118, cs_b: 117 } }}
        onApply={onApply}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Apply Selected \(1\)/ }));
    const r = onApply.mock.calls[0][0].residues['10N'];
    expect(r.dw_ac).toBeUndefined();
    expect(r.dw_ab.value).toBe(-1);
  });
});
