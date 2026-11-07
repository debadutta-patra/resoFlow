/**
 * CEST Experiment Plugin.
 *
 * Implements the ExperimentPlugin interface for Chemical Exchange Saturation
 * Transfer (CEST) experiments in resoFlow.
 */

import { registerExperimentPlugin, type ExperimentPlugin, type ParameterTabCapabilities } from "../lib/experimentPlugin";
import { createDefaultParameterConfig } from "../lib/parameterConfig";
import { createDefaultMethodConfig } from "../lib/methodConfig";

/** Parameters-tab capabilities for CEST picks (also reused by the combined EXCHANGE page). */
export const CEST_PARAMETER_CAPABILITIES: ParameterTabCapabilities = {
  description: "Configure global kinetic settings, per-residue shifts & rates with full provenance and stale detection.",
  createDefaultParameters: createDefaultParameterConfig,
  resync: {
    buttonLabel: "Re-sync from Picks",
    buttonTitle: "Non-destructively re-sync parameters from current CEST picks",
    staleBanner: (n) => `${n} residue${n === 1 ? "" : "s"} have updated peak positions in the Pick CEST tab.`,
    successMessage: "Re-synced parameters from picks successfully",
  },
  residueTable: {
    heading: "Per-Residue Chemical Shifts & Relaxation Rates",
    expectsBPicks: true,
    profileTitle: "CEST Profile",
    pickNoun: "peak pick",
    pickedLabel: "Picked",
    staleLabel: "Pick Moved",
  },
};

export const cestPlugin: ExperimentPlugin = {
  id: "cest",
  displayName: "Chemical Exchange Saturation Transfer (CEST)",
  family: "cest",
  defaultModule: "cest_15n",
  supportedModules: [
    "cest_15n",
    "cest_15n_cw",
    "cest_15n_tr",
    "cest_1hn_ap",
    "cest_1hn_ip_ap",
    "cest_13c",
    "cest_ch3_1h_ip_ap",
    "dcest_15n",
    "dcest_13c",
  ],
  hasDataPrepTab: true,
  dataPrepTabLabel: "Pick CEST",
  endpointFamily: "cest",
  parameters: CEST_PARAMETER_CAPABILITIES,

  getDefaultParameters: () => createDefaultParameterConfig(),

  getDefaultMethod: () => createDefaultMethodConfig(),
};

// Auto-register CEST plugin on import
registerExperimentPlugin(cestPlugin);

export default cestPlugin;
