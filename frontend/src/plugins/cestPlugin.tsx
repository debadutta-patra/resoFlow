/**
 * CEST Experiment Plugin.
 *
 * Implements the ExperimentPlugin interface for Chemical Exchange Saturation
 * Transfer (CEST) experiments in resoFlow.
 */

import { registerExperimentPlugin, type ExperimentPlugin } from "../lib/experimentPlugin";
import { createDefaultParameterConfig } from "../lib/parameterConfig";
import { createDefaultMethodConfig } from "../lib/methodConfig";

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

  getDefaultParameters: () => createDefaultParameterConfig(),

  getDefaultMethod: () => createDefaultMethodConfig(),
};

// Auto-register CEST plugin on import
registerExperimentPlugin(cestPlugin);

export default cestPlugin;
