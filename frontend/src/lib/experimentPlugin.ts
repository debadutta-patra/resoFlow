/**
 * ChemEx Experiment Plugin Architecture.
 *
 * Defines the contract that every NMR experiment type (CEST, CPMG, Relaxation, etc.)
 * implements to register with the resoFlow core.
 */

import React from "react";
import type { ParameterConfig } from "./parameterConfig";
import type { MethodConfig } from "./methodConfig";

export interface NucleusInfo {
  nucleus: '15N' | '13C' | '1H';
  xiRatio: number;
  unitLabel: string;
  defaultCarrier: number;
  sanityRange: [number, number];
  defaultZoomSpan: number;
  maxDwWarn: number;
}

export const NUCLEUS_INFO: Record<string, NucleusInfo> = {
  '15N': {
    nucleus: '15N',
    xiRatio: 0.101329118,
    unitLabel: 'ppm (¹⁵N)',
    defaultCarrier: 117.0,
    sanityRange: [100.0, 135.0],
    defaultZoomSpan: 20.0,
    maxDwWarn: 6.0,
  },
  '13C': {
    nucleus: '13C',
    xiRatio: 0.25144953,
    unitLabel: 'ppm (¹³C)',
    defaultCarrier: 40.0,
    sanityRange: [0.0, 220.0],
    defaultZoomSpan: 15.0,
    maxDwWarn: 8.0,
  },
  '1HN': {
    nucleus: '1H',
    xiRatio: 1.0,
    unitLabel: 'ppm (¹H)',
    defaultCarrier: 8.5,
    sanityRange: [6.0, 11.5],
    defaultZoomSpan: 2.0,
    maxDwWarn: 1.5,
  },
  '13CH3': {
    nucleus: '1H',
    xiRatio: 1.0,
    unitLabel: 'ppm (¹H)',
    defaultCarrier: 1.0,
    sanityRange: [-0.5, 4.0],
    defaultZoomSpan: 1.5,
    maxDwWarn: 1.5,
  },
};

export function getNucleusInfoForModule(moduleName: string): NucleusInfo {
  if (
    moduleName.startsWith('cest_13c') ||
    moduleName.startsWith('dcest_13c') ||
    moduleName.startsWith('cpmg_13c') ||
    moduleName.startsWith('cpmg_ch3_mq') ||
    moduleName.startsWith('cpmg_ch3_13c')
  ) {
    return NUCLEUS_INFO['13C'];
  }
  if (moduleName.startsWith('cest_ch3_1h') || moduleName.startsWith('cpmg_ch3_1h') || moduleName.startsWith('cpmg_chd2_1h')) {
    return NUCLEUS_INFO['13CH3'];
  }
  if (moduleName.startsWith('cest_1hn') || moduleName.startsWith('cpmg_1hn')) {
    return NUCLEUS_INFO['1HN'];
  }
  return NUCLEUS_INFO['15N'];
}

export interface ExperimentModuleInfo {
  module_name: string;
  display_name: string;
  family: string;
  probe: string;
  observed_nucleus?: string;
  xi_ratio?: number;
  default_carrier?: number;
  unit_label?: string;
  sanity_range?: [number, number];
  default_zoom_span?: number;
  max_dw_warn?: number;
  flags?: string[];
  description: string;
  docs_url: string;
  parent_module?: string;
  variants?: Record<string, any>;
  spin_system_format: {
    format: string;
    description: string;
    example: string;
    nuclei: string[];
    observed_spin: string;
  };
  allowed_data_errors: string[];
  sections: Record<string, any>;
}

export interface ExperimentPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly family: "cest" | "cpmg" | "relaxation" | string;
  readonly defaultModule: string;
  readonly supportedModules: string[];
  readonly hasDataPrepTab: boolean;
  readonly dataPrepTabLabel?: string;

  /**
   * Render custom experiment setup (fields, carriers, acquisitions, etc.)
   */
  renderSetupTab?: (props: {
    analysisId: string;
    projectUuid: string;
    onDirtyChange?: (dirty: boolean) => void;
  }) => React.ReactNode;

  /**
   * Render custom data preparation tab (e.g. Pick CEST dips or CPMG peak matching)
   */
  renderDataPrepTab?: (props: {
    analysisId: string;
    projectUuid: string;
  }) => React.ReactNode;

  /**
   * Render custom visualizer in the Results tab (e.g. CEST profiles or CPMG dispersion curves)
   */
  renderResultsVisualizer?: (props: {
    analysisId: string;
    projectUuid: string;
    fitMode: "global" | "individual";
    selectedResidue: string | null;
    onSelectResidue: (res: string | null) => void;
  }) => React.ReactNode;

  /**
   * Provide default parameter template for this experiment type
   */
  getDefaultParameters?: (moduleName?: string) => ParameterConfig;

  /**
   * Provide default multi-step method template for this experiment type
   */
  getDefaultMethod?: (moduleName?: string) => MethodConfig;
}

// Global in-memory plugin registry
const PLUGIN_REGISTRY = new Map<string, ExperimentPlugin>();

export function registerExperimentPlugin(plugin: ExperimentPlugin): void {
  PLUGIN_REGISTRY.set(plugin.id, plugin);
}

export function getExperimentPlugin(id: string): ExperimentPlugin | undefined {
  return PLUGIN_REGISTRY.get(id);
}

export function getAllExperimentPlugins(): ExperimentPlugin[] {
  return Array.from(PLUGIN_REGISTRY.values());
}

export function getPluginForModule(moduleName: string): ExperimentPlugin | undefined {
  for (const plugin of PLUGIN_REGISTRY.values()) {
    if (plugin.supportedModules.includes(moduleName)) {
      return plugin;
    }
  }
  return undefined;
}
