/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MethodsTab } from './MethodsTab';
import { useMethodEditor } from '../../hooks/useMethodEditor';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: { parameters: [] } }), put: vi.fn() },
}));

afterEach(cleanup);

const residues = [
  { id: '39N', number: 39, label: 'A39N', hasData: true },
  { id: '3N', number: 3, label: 'G3N', hasData: true },
];

function Harness({ locked }: { locked: boolean }) {
  const editor = useMethodEditor({
    projectUuid: 'p',
    analysisUuid: 'a',
    family: 'cest',
    model: '2st',
    residueItems: residues,
    isResidueExcluded: () => false,
    exclusionKey: [],
    locked,
  });
  return (
    <MethodsTab
      editor={editor}
      analysisUuid="a"
      residueItems={residues}
      startingValues={{}}
      onNavigateToParameters={() => {}}
      readOnly={locked}
    />
  );
}

describe('MethodsTab run-state honesty', () => {
  it('locks the editor and explains why while a run is in progress', () => {
    render(<Harness locked />);
    expect(screen.getByText(/Showing the method snapshot used by the running job/)).toBeDefined();
    expect((screen.getByRole('button', { name: /Templates/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Import TOML/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Edit Raw TOML/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Add Step/ })).toBeNull();
    // Selection mode cannot change while locked (chips are hidden in "All profiles").
    const include = screen.getByRole('radio', { name: /Include only these/ }) as HTMLButtonElement;
    expect(include.disabled).toBe(true);
    fireEvent.click(include);
    expect(screen.getByText(/All 2 profiles/)).toBeDefined();
  });

  it('is editable when no run is active, with residue chips in natural order', () => {
    render(<Harness locked={false} />);
    expect(screen.queryByText(/Showing the method snapshot/)).toBeNull();
    expect(screen.getByRole('button', { name: /Add Step/ })).toBeDefined();
    expect(screen.getByText(/All 2 profiles/)).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: /Include only these/ }));
    expect(screen.getByText(/INCLUDE is empty/)).toBeDefined();
    const chips = screen.getAllByRole('button').map(b => b.textContent).filter(t => t === 'G3N' || t === 'A39N');
    expect(chips).toEqual(['G3N', 'A39N']);
    fireEvent.click(screen.getByRole('radio', { name: /Include only these/ }));
    fireEvent.click(screen.getByRole('button', { name: /G3N/ }));
    expect(screen.getByText(/1 of 2 included/)).toBeDefined();
  });
});
