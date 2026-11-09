/**
 * @vitest-environment jsdom
 *
 * Phase 2: step identity — rename validation, id-based ROLES_FROM through
 * reorder / delete (visible errors, never silent fixes), duplicate naming, badges.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MethodsTab } from './MethodsTab';
import StepTabs from './StepTabs';
import { useMethodEditor, type MethodEditor } from '../../hooks/useMethodEditor';
import { setRolesFrom } from '../../lib/methodSteps';
import type { Step } from '../../lib/methodConfig';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: { parameters: [] } }), put: vi.fn() },
}));

afterEach(cleanup);

const mk = (id: string, name: string): Step => ({ id, name, parameters: [{ name: 'PB', mode: 'fit' }], residueMode: 'include', residues: [] });

let editorRef: MethodEditor | null = null;
function Harness({ committed }: { committed?: Record<string, Record<string, number>> }) {
  const editor = useMethodEditor({
    projectUuid: 'p',
    analysisUuid: 'a',
    family: 'cest',
    model: '2st',
    residueItems: [],
    isResidueExcluded: () => false,
    exclusionKey: [],
  });
  useEffect(() => {
    editorRef = editor;
  });
  const { setMethodConfig } = editor;
  useEffect(() => {
    const g = mk('g', 'GLOBAL_FIT');
    setMethodConfig({ steps: [g, setRolesFrom(mk('l', 'LOCAL_FITS'), g, 0), mk('x', 'EXTRA')] });
  }, [setMethodConfig]);
  return <MethodsTab editor={editor} analysisUuid="a" residueItems={[]} startingValues={{}} onNavigateToParameters={() => {}} committedByStep={committed} />;
}

const tab = (name: string) => screen.getAllByRole('tab').find(t => within(t).queryByText(name)) as HTMLElement;
const names = () => editorRef!.methodConfig.steps.map(s => s.name);

describe('step tabs', () => {
  it('validates renames before committing and keeps ROLES_FROM pointing at the renamed step', () => {
    render(<Harness committed={{ GLOBAL_FIT: { PB: 0.05 } }} />);
    fireEvent.click(within(tab('GLOBAL_FIT')).getByRole('button', { name: 'Rename GLOBAL_FIT' }));
    const input = screen.getByLabelText('Step name');
    expect(screen.getByText(/results for this step stay under/)).toBeDefined();

    fireEvent.change(input, { target: { value: 'local_fits' } });
    expect(screen.getByText(/Another step is already named "LOCAL_FITS"/)).toBeDefined();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names()[0]).toBe('GLOBAL_FIT'); // not committed

    fireEvent.change(input, { target: { value: 'Grid' } });
    expect(screen.getByText(/reserved/)).toBeDefined();

    fireEvent.change(input, { target: { value: 'Coarse_Fit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names()).toEqual(['Coarse_Fit', 'LOCAL_FITS', 'EXTRA']); // case preserved
    expect(editorRef!.effectiveMethodToml).toContain('[LOCAL_FITS]\nROLES_FROM = "Coarse_Fit"');
  });

  it('reordering that creates a forward ROLES_FROM shows an error instead of fixing it', () => {
    render(<Harness />);
    fireEvent.click(within(tab('GLOBAL_FIT')).getByRole('button', { name: 'Move GLOBAL_FIT later' }));
    expect(names()).toEqual(['LOCAL_FITS', 'GLOBAL_FIT', 'EXTRA']);
    expect(editorRef!.methodConfig.steps[0].rolesFromStepId).toBe('g'); // untouched
    expect(editorRef!.blockingErrors.some(e => e.message.includes('after this one'))).toBe(true);
    expect(within(tab('LOCAL_FITS')).getByTitle(/1 blocking error/)).toBeDefined();
  });

  it('deleting the ROLES_FROM target leaves a visible dangling reference', () => {
    render(<Harness />);
    const del = within(tab('GLOBAL_FIT')).getByRole('button', { name: 'Delete GLOBAL_FIT' });
    expect(del.getAttribute('title')).toMatch(/LOCAL_FITS takes ROLES_FROM from it/);
    fireEvent.click(del);
    expect(names()).toEqual(['LOCAL_FITS', 'EXTRA']);
    expect(editorRef!.blockingErrors.some(e => e.message.includes('no longer exists ("GLOBAL_FIT")'))).toBe(true);
    // The roles editor keeps the broken reference selected and explains it.
    fireEvent.click(tab('LOCAL_FITS'));
    expect(screen.getByRole('option', { name: /⚠ GLOBAL_FIT \(deleted step\)/ })).toBeDefined();
  });

  it('duplicates with a unique name; ROLES_FROM lists only earlier steps', () => {
    render(<Harness />);
    fireEvent.click(within(tab('GLOBAL_FIT')).getByRole('button', { name: 'Duplicate GLOBAL_FIT' }));
    fireEvent.click(within(tab('GLOBAL_FIT')).getByRole('button', { name: 'Duplicate GLOBAL_FIT' }));
    expect(names()).toEqual(['GLOBAL_FIT', 'GLOBAL_FIT_COPY_2', 'GLOBAL_FIT_COPY', 'LOCAL_FITS', 'EXTRA']);
    fireEvent.click(tab('LOCAL_FITS'));
    const select = screen.getByLabelText('Start roles from:') as HTMLSelectElement;
    expect([...select.options].map(o => o.textContent)).toEqual(['Baseline model roles', '1. GLOBAL_FIT', '2. GLOBAL_FIT_COPY_2', '3. GLOBAL_FIT_COPY']);
    expect(screen.getByText(/Copies only roles and constraints/)).toBeDefined();
  });
});

describe('step tab badges', () => {
  it('shows resolved counts, search and statistics', () => {
    const steps: Step[] = [{ ...mk('a', 'A'), search: { mode: 'de', seed: '1', axes: [] }, statistics: { mc: { enabled: true, replicates: 10 } } }];
    render(
      <StepTabs
        steps={steps}
        activeStepIdx={0}
        onSelectStep={() => {}}
        onAddStep={() => {}}
        onDuplicateStep={() => {}}
        onDeleteStep={() => {}}
        onRenameStep={() => {}}
        onReorderSteps={() => {}}
        badges={{ a: { coords: 4, residues: 2, search: 'grid', statistics: ['MC', 'BS'] } }}
      />
    );
    expect(screen.getByText('4 coords · 2 res')).toBeDefined();
    expect(screen.getByTitle('SEARCH.GRID')).toBeDefined();
    expect(screen.getByTitle('Statistics: MC, BS')).toBeDefined();
  });
});
