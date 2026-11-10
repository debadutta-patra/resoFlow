/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useMethodEditor } from './useMethodEditor';
import { useParameterEditor } from './useParameterEditor';
import { createDefaultMethodConfig } from '../lib/methodConfig';
import { createDefaultParameterConfig, LEGACY_PEAK_FIT_HASH } from '../lib/parameterConfig';
import { CPMG_PARAMETER_CAPABILITIES } from '../plugins/cpmgPlugin';
import { CEST_PARAMETER_CAPABILITIES } from '../plugins/cestPlugin';

vi.mock('../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), put: vi.fn() },
}));

afterEach(cleanup);

const methodOpts = (overrides: Partial<Parameters<typeof useMethodEditor>[0]> = {}) => ({
  projectUuid: 'p',
  analysisUuid: 'a',
  family: 'cest' as const,
  model: '2st',
  residueItems: [],
  isResidueExcluded: () => false,
  exclusionKey: undefined,
  ...overrides,
});

describe('useMethodEditor', () => {
  it('restores a saved raw override into raw mode instead of freezing the structured form', () => {
    const { result } = renderHook(() => useMethodEditor(methodOpts()));
    const raw = '[STEP1]\nFIT = ["PB"]\n';
    act(() => {
      result.current.restore({ method_config: { ...createDefaultMethodConfig(), rawOverride: raw } });
    });
    expect(result.current.isRawEditMode).toBe(true);
    expect(result.current.methodToml).toBe(raw);
    expect(result.current.effectiveMethodToml).toBe(raw);
    expect(result.current.methodConfig.rawOverride).toBeUndefined();
    expect(result.current.methodConfigForSave.rawOverride).toBe(raw);

    act(() => result.current.applyRawToml());
    expect(result.current.isRawEditMode).toBe(false);
    expect(result.current.methodConfig.steps[0].parameters.find(p => p.name === 'PB')?.mode).toBe('fit');
  });

  it('discards raw edits back to the structured TOML', () => {
    const { result } = renderHook(() => useMethodEditor(methodOpts()));
    act(() => result.current.enterRawMode());
    act(() => result.current.setMethodToml('garbage'));
    act(() => result.current.discardRawToml());
    expect(result.current.isRawEditMode).toBe(false);
    expect(result.current.effectiveMethodToml).toContain('[STEP1]');
  });

  it('prunes excluded residues from step selections when exclusions change', () => {
    let excluded = new Set<string>();
    const { result, rerender } = renderHook(({ key }) =>
      useMethodEditor(methodOpts({ isResidueExcluded: r => excluded.has(r), exclusionKey: key })),
      { initialProps: { key: 0 } }
    );
    act(() => result.current.handleStepChange({ ...result.current.activeStep, residues: ['3N', '4N'] }));
    excluded = new Set(['4N']);
    rerender({ key: 1 });
    expect(result.current.methodConfig.steps[0].residues).toEqual(['3N']);
    expect(result.current.effectiveMethodToml).not.toContain('4N');
  });

  it('adds, duplicates, reorders and deletes steps', () => {
    const { result } = renderHook(() => useMethodEditor(methodOpts()));
    act(() => result.current.stepHandlers.onAddStep());
    expect(result.current.methodConfig.steps.map(s => s.name)).toEqual(['STEP1', 'STEP2']);
    expect(result.current.activeStepIdx).toBe(1);
    act(() => result.current.stepHandlers.onDuplicateStep(0));
    expect(result.current.methodConfig.steps.map(s => s.name)).toEqual(['STEP1', 'STEP1_COPY', 'STEP2']);
    act(() => result.current.stepHandlers.onReorderSteps(2, 0));
    expect(result.current.methodConfig.steps[0].name).toBe('STEP2');
    act(() => result.current.stepHandlers.onDeleteStep(0));
    expect(result.current.methodConfig.steps).toHaveLength(2);
  });
});

describe('useParameterEditor', () => {
  it('restores legacy CPMG configs through the plugin codec', () => {
    const { result } = renderHook(() =>
      useParameterEditor({
        createDefault: CPMG_PARAMETER_CAPABILITIES.createDefaultParameters,
        codec: CPMG_PARAMETER_CAPABILITIES.codec,
        profiles: [],
        picks: {},
      })
    );
    act(() => {
      result.current.restore({
        parameter_config: {
          globals: { pb: { value: 0.1, source: { kind: 'manual' } } },
          residues: { '3LYS': { cs_a: { value: 120, source: { kind: 'pick', pickSetHash: LEGACY_PEAK_FIT_HASH, at: 't' } } } },
        } as any,
      });
    });
    const cfg = result.current.parameterConfig;
    expect(cfg.residues['3N'].cs_a?.value).toBe(120);
    expect(cfg.globals.dw_ab).toBeUndefined(); // nothing pre-filled: ChemEx's default applies
    expect(result.current.staleResidues).toEqual([]);
    expect(result.current.effectiveParameterToml).toContain('3N = 120.000');
  });

  it('drops never-edited legacy resoFlow defaults on restore, once, with a notice', () => {
    const { result } = renderHook(() =>
      useParameterEditor({ createDefault: createDefaultParameterConfig, profiles: [], picks: {} })
    );
    act(() => {
      result.current.restore({
        parameter_config: {
          globals: {
            pb: { value: 0.05, source: { kind: 'default' } },
            kex_ab: { value: 750, source: { kind: 'manual' } },
          },
          residues: {},
        } as any,
      });
    });
    expect(result.current.parameterConfig.globals.pb).toBeUndefined();
    expect(result.current.parameterConfig.globals.kex_ab.value).toBe(750);
    expect(result.current.notices).toHaveLength(1);
    expect(result.current.notices[0]).toContain('PB');
    act(() => result.current.dismissNotices());
    expect(result.current.notices).toEqual([]);
  });

  it('restores a saved legacy parameters.toml with commented residues as exclusions, once', () => {
    const { result } = renderHook(() =>
      useParameterEditor({ createDefault: createDefaultParameterConfig, profiles: [], picks: {} })
    );
    act(() => {
      result.current.restore({
        parameter_toml: '# Auto-generated ChemEx parameter file\n\n[CS_A]\n# 13N = 118.500\n14N = 120.100\n',
      });
    });
    expect(result.current.parameterConfig.excludedResidues).toEqual(['13N']);
    expect(result.current.notices[0]).toContain('Converted 1 commented residue');
    expect(result.current.effectiveParameterToml).toContain('\n13N = 118.500');
    expect(result.current.effectiveParameterToml).not.toContain('# 13N');
  });

  it('persists and restores raw parameters.toml edits', () => {
    const { result } = renderHook(() =>
      useParameterEditor({ createDefault: createDefaultParameterConfig, profiles: [], picks: {} })
    );
    act(() => result.current.enterRawMode());
    act(() => result.current.setRawParamToml('[GLOBAL]\nPB = 0.2\n# custom\n'));
    const saved = result.current.parameterConfigForSave;
    expect(saved.rawOverride).toContain('# custom');

    const { result: reloaded } = renderHook(() =>
      useParameterEditor({ createDefault: createDefaultParameterConfig, profiles: [], picks: {} })
    );
    act(() => {
      reloaded.current.restore({ parameter_config: saved });
    });
    expect(reloaded.current.isRawParamEditMode).toBe(true);
    expect(reloaded.current.effectiveParameterToml).toContain('# custom');
  });

  it('exposes ChemEx defaults (and every set global) as Methods starting values', () => {
    const { result } = renderHook(() =>
      useParameterEditor({
        createDefault: CPMG_PARAMETER_CAPABILITIES.createDefaultParameters,
        profiles: [],
        picks: {},
      })
    );
    expect(result.current.startingValues).toMatchObject({ PB: 0.05, KEX_AB: 200, TAUC_A: 4 });
    expect(result.current.startingValues.DW_AB).toBeUndefined();
  });

  it('uses the same exclusion rule on every page', () => {
    const { result } = renderHook(() =>
      useParameterEditor({
        createDefault: CEST_PARAMETER_CAPABILITIES.createDefaultParameters,
        profiles: [{ residue: '3N', full_residue: 'K3N' }],
        picks: {},
      })
    );
    act(() => result.current.toggleExclude('K3N'));
    expect(result.current.isExcluded('3N')).toBe(true);
    act(() => result.current.toggleExclude('3N'));
    expect(result.current.isExcluded('3N')).toBe(false);
  });
});
