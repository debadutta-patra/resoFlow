/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useResidueBrowser } from '../../hooks/useResidueBrowser';
import { ResidueNavBar, ResidueNotePanel, ResidueTable } from './ResidueBrowser';
import { EMPTY_REVIEW, buildBrowserRows, type ReviewState } from '../../lib/residueReview';

const RESIDUES = [{ id: '1N' }, { id: '2N' }, { id: '4N' }];

function Harness({ arm }: { arm?: (m: string) => void }) {
  const [review, setReview] = useState<ReviewState>(EMPTY_REVIEW);
  const [excluded, setExcluded] = useState<string[]>([]);
  const rows = React.useMemo(() => buildBrowserRows(RESIDUES), []);
  const browser = useResidueBrowser({
    rows,
    review,
    setReview: u => setReview(u),
    isExcluded: id => excluded.includes(id),
    toggleExclude: id => setExcluded(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])),
    active: true,
    onArm: arm,
  });
  return (
    <div>
      <ResidueNavBar browser={browser} buildExport={() => ({ baseName: 'x', columns: [], rows: [] })} />
      <ResidueNotePanel browser={browser} />
      <ResidueTable browser={browser} />
      <div data-testid="selected">{browser.selectedId}</div>
    </div>
  );
}

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => act(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
});

describe('ResidueBrowser', () => {
  beforeEach(() => window.history.replaceState(null, '', '/analysis'));
  afterEach(cleanup);

  it('opens the residue named in ?res= and writes the selection back to the URL', () => {
    window.history.replaceState(null, '', '/analysis?res=2N');
    render(<Harness />);
    expect(screen.getByTestId('selected').textContent).toBe('2N');
    key('ArrowRight');
    expect(screen.getByTestId('selected').textContent).toBe('4N');
    expect(new URLSearchParams(window.location.search).get('res')).toBe('4N');
  });

  it('shows a greyed gap row for missing residue numbers', () => {
    render(<Harness />);
    const gap = document.querySelector('tr[data-gap="true"]');
    expect(gap?.textContent).toContain('3');
    expect(gap?.textContent).toContain('no data');
  });

  it('Enter accepts and advances, N marks no excited state, X excludes, Ctrl+Z undoes', () => {
    render(<Harness />);
    expect(screen.getByTestId('review-progress').textContent).toBe('0 / 3 reviewed');
    key('Enter');
    expect(screen.getByTestId('selected').textContent).toBe('2N');
    expect(screen.getByTestId('review-progress').textContent).toBe('1 / 3 reviewed');
    key('n');
    expect(screen.getByTestId('selected').textContent).toBe('4N');
    key('x');
    expect(screen.getByTestId('review-progress').textContent).toBe('3 / 3 reviewed');
    expect(document.querySelector('[data-status="excluded"]')).not.toBeNull();

    key('z', { ctrlKey: true }); // undo exclusion
    expect(screen.getByTestId('review-progress').textContent).toBe('2 / 3 reviewed');
    key('z', { ctrlKey: true }); // undo "no excited state" (and its advance)
    expect(screen.getByTestId('selected').textContent).toBe('2N');
    expect(screen.getByTestId('review-progress').textContent).toBe('1 / 3 reviewed');
  });

  it('ignores shortcuts while typing a note', () => {
    render(<Harness />);
    const note = screen.getByLabelText('Residue note');
    fireEvent.change(note, { target: { value: 'x marks' } });
    act(() => {
      note.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    expect(screen.getByTestId('review-progress').textContent).toBe('0 / 3 reviewed');
    expect((note as HTMLTextAreaElement).value).toBe('x marks');
  });

  it('A / B arm picking when the page supports it', () => {
    const armed: string[] = [];
    render(<Harness arm={m => armed.push(m)} />);
    key('a');
    key('b');
    expect(armed).toEqual(['cs_a', 'cs_b']);
  });

  it('lists the shortcuts in the "?" popover', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.textContent).toContain('Ctrl+Z');
    expect(dialog.textContent).toContain('Accept and go to next');
  });

  it('flag toggle and status filter', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'flagged' } });
    const rows = document.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('1N');
  });

  it('status menu sets and resets a status; U resets; flag can be removed', () => {
    render(<Harness />);
    const status = () => screen.getAllByRole('button', { name: 'Status of 1N' })[0];
    fireEvent.click(status());
    fireEvent.click(screen.getByRole('menuitem', { name: 'No excited state' }));
    expect(status().textContent).toContain('No excited state');
    key('u');
    expect(status().textContent).toContain('Unreviewed');
    key('z', { ctrlKey: true });
    expect(status().textContent).toContain('No excited state');

    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove flag' }));
    expect(screen.getByRole('button', { name: 'Flag' }).getAttribute('aria-pressed')).toBe('false');
  });
});
