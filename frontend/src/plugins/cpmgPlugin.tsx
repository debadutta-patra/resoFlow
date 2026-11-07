/**
 * CPMG Experiment Plugin.
 *
 * Implements the ExperimentPlugin interface for CPMG Relaxation Dispersion
 * experiments in resoFlow.
 */

import { registerExperimentPlugin, type ExperimentPlugin, type ParameterTabCapabilities } from "../lib/experimentPlugin";
import {
  configToCpmgToml,
  cpmgTomlToConfig,
  createDefaultCpmgParameterConfig,
  migrateLegacyCpmgParameterConfig,
} from "../lib/cpmgConfig";
import { createDefaultMethodConfig } from "../lib/methodConfig";
import { DispersionThumbnail } from "../components/cpmg/DispersionThumbnail";
import type { CpmgProfileItem } from "../components/cpmg/CpmgDispersionTab";

export const CPMG_PARAMETER_CAPABILITIES: ParameterTabCapabilities = {
  description:
    "Configure global exchange parameters (pb, kex, universal DW_AB, τc) and ground-state chemical shifts (CS_A) seeded from peak fitting.",
  createDefaultParameters: createDefaultCpmgParameterConfig,
  codec: {
    toToml: (cfg) => configToCpmgToml(cfg),
    fromToml: cpmgTomlToConfig,
    migrate: migrateLegacyCpmgParameterConfig,
  },
  extraGlobals: [
    { key: "dw_ab", label: "Universal Δω (DW_AB)", hint: "Universal starting chemical shift difference (ppm)", defaultValue: 2.0 },
  ],
  resync: {
    buttonLabel: "Re-sync from Peak Fit",
    buttonTitle: "Non-destructively re-sync CS_A from the current peak-fitting results",
    staleBanner: (n) => `${n} residue${n === 1 ? "" : "s"} have updated CS_A values from peak fitting.`,
    successMessage: "Re-synced CS_A from peak fitting successfully",
  },
  residueTable: {
    heading: "Per-Residue Ground-State Shifts & Relaxation Rates",
    expectsBPicks: false,
    profileTitle: "Dispersion Profile",
    pickNoun: "peak fit",
    pickedLabel: "From Peak Fit",
    staleLabel: "Peak Fit Changed",
  },
  renderResidueProfile: (row, size) => (
    <DispersionThumbnail
      profile={row.profile as CpmgProfileItem | undefined}
      width={size === "thumb" ? 130 : 480}
      height={size === "thumb" ? 34 : 120}
      className={size === "large" ? "w-full" : undefined}
    />
  ),
};

export const cpmgPlugin: ExperimentPlugin = {
  id: "cpmg",
  displayName: "CPMG Relaxation Dispersion",
  family: "cpmg",
  defaultModule: "cpmg_15n_ip",
  supportedModules: [
    "cpmg_15n_rc",
    "cpmg_15n_ip",
    "cpmg_15n_ip_0013",
    "cpmg_15n_tr",
    "cpmg_15n_tr_0013",
    "cpmg_1hn_ap",
    "cpmg_1hn_ap_0013",
    "cpmg_hn_dq_zq",
    "cpmg_13c_ip",
    "cpmg_13co_ap",
    "cpmg_ch3_mq",
    "cpmg_ch3_13c_h2c",
    "cpmg_ch3_13c_h2c_0013",
    "cpmg_ch3_1h_sq",
    "cpmg_ch3_1h_dq",
    "cpmg_ch3_1h_tq",
    "cpmg_ch3_1h_tq_diff",
    "cpmg_chd2_1h_ap",
  ],
  hasDataPrepTab: true,
  dataPrepTabLabel: "Inspect Dispersion",
  endpointFamily: "cpmg",
  parameters: CPMG_PARAMETER_CAPABILITIES,

  getDefaultParameters: () => createDefaultCpmgParameterConfig(),

  getDefaultMethod: () => createDefaultMethodConfig(),
};

// Auto-register CPMG plugin on import
registerExperimentPlugin(cpmgPlugin);

export default cpmgPlugin;
