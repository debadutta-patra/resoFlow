/**
 * Combined CEST + CPMG ("EXCHANGE") Experiment Plugin.
 *
 * A composite of the CEST and CPMG plugins: CEST picks drive re-sync, and each residue
 * shows whichever profile it has (CEST profile, else CPMG dispersion).
 */

import { registerExperimentPlugin, type ExperimentPlugin, type ParameterTabCapabilities } from "../lib/experimentPlugin";
import { createDefaultParameterConfig } from "../lib/parameterConfig";
import { createDefaultMethodConfig } from "../lib/methodConfig";
import { ProfileThumbnail, type CestProfile } from "../components/parameters/ProfileThumbnail";
import { DispersionThumbnail } from "../components/cpmg/DispersionThumbnail";
import type { CpmgProfileItem } from "../components/cpmg/CpmgDispersionTab";
import { cestPlugin, CEST_PARAMETER_CAPABILITIES } from "./cestPlugin";
import { cpmgPlugin } from "./cpmgPlugin";

const isCpmgProfile = (p: unknown): p is CpmgProfileItem =>
  !!p && Array.isArray((p as CpmgProfileItem).experiments) &&
  (p as CpmgProfileItem).experiments.some((e) => Array.isArray((e as { nu_cpmg?: unknown }).nu_cpmg));

export const EXCHANGE_PARAMETER_CAPABILITIES: ParameterTabCapabilities = {
  ...CEST_PARAMETER_CAPABILITIES,
  description:
    "Configure global kinetic settings and per-residue shifts & rates shared by the CEST and CPMG datasets, with full provenance and stale detection.",
  createDefaultParameters: createDefaultParameterConfig,
  residueTable: { ...CEST_PARAMETER_CAPABILITIES.residueTable, profileTitle: "Profile" },
  renderResidueProfile: (row, size) => {
    const width = size === "thumb" ? 130 : 480;
    const height = size === "thumb" ? 34 : 120;
    const className = size === "large" ? "w-full" : undefined;
    return isCpmgProfile(row.profile) ? (
      <DispersionThumbnail profile={row.profile} width={width} height={height} className={className} />
    ) : (
      <ProfileThumbnail
        profile={row.profile as CestProfile | undefined}
        csA={row.cs_a}
        csB={row.cs_b}
        width={width}
        height={height}
        className={className}
      />
    );
  },
};

export const exchangePlugin: ExperimentPlugin = {
  id: "exchange",
  displayName: "Combined CEST + CPMG Exchange",
  family: "exchange",
  defaultModule: cestPlugin.defaultModule,
  supportedModules: [],
  hasDataPrepTab: true,
  dataPrepTabLabel: "Pick CEST / Inspect Dispersion",
  endpointFamily: "exchange",
  parameters: EXCHANGE_PARAMETER_CAPABILITIES,

  getDefaultParameters: () => createDefaultParameterConfig(),

  getDefaultMethod: () => createDefaultMethodConfig(),
};

/** Modules handled by the composite plugin (CEST ∪ CPMG). */
export const EXCHANGE_COMPONENT_MODULES = [...cestPlugin.supportedModules, ...cpmgPlugin.supportedModules];

registerExperimentPlugin(exchangePlugin);

export default exchangePlugin;
