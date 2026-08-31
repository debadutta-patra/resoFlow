/**
 * CPMG Experiment Plugin.
 *
 * Implements the ExperimentPlugin interface for CPMG Relaxation Dispersion
 * experiments in resoFlow.
 */

import { registerExperimentPlugin, type ExperimentPlugin } from "../lib/experimentPlugin";
import { createDefaultCpmgParameterConfig } from "../lib/cpmgConfig";
import { createDefaultMethodConfig } from "../lib/methodConfig";

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

  getDefaultParameters: () => createDefaultCpmgParameterConfig() as any,

  getDefaultMethod: () => createDefaultMethodConfig(),
};

// Auto-register CPMG plugin on import
registerExperimentPlugin(cpmgPlugin);

export default cpmgPlugin;
