import type { AvailableParamMeta } from '../components/methods/ParameterTable';

/**
 * Verified on ChemEx 2026.9.2 (tests/chemex_api/test_global_precedence.py): for each
 * parameter the last matching entry in file order wins, and resoFlow writes [GLOBAL] first.
 */
export const GLOBAL_PRECEDENCE_HELP =
  'A [GLOBAL] value is a blanket starting value for every residue. ChemEx applies the last matching entry in the file, ' +
  'and resoFlow writes [GLOBAL] first, so per-residue sections ([CS_A], [DW_AB], [R2_A], …) override it.';

/** Catalogue rows that can be added as a [GLOBAL] blanket value. */
export function addableGlobals(catalog: AvailableParamMeta[] | null | undefined, shown: string[]): AvailableParamMeta[] {
  const taken = new Set(shown.map(s => s.toUpperCase()));
  return (catalog ?? []).filter(
    r =>
      !taken.has(r.name.toUpperCase()) &&
      !r.protected &&
      (!r.derived || /^R[12]_[B-F]$/.test(r.name.toUpperCase()))
  );
}
