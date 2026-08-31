/**
 * Typed NMR Spin-System Key implementation.
 *
 * Handles parsing, formatting, sorting by residue number, numeric range
 * resolution, and cross-format matching for single-spin (15N/13C),
 * two-spin (15N-1H TROSY, 1H-15N IP/AP), and methyl (13C-1H MQ) keys.
 */

export const AA_3TO1: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C",
  GLU: "E", GLN: "Q", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P",
  SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
};

export const AA_1TO3: Record<string, string> = Object.entries(AA_3TO1).reduce(
  (acc, [three, one]) => ({ ...acc, [one]: three }),
  {}
);

export class SpinSystemKey {
  readonly resNum: number;
  readonly symbol: string;
  readonly spins: readonly string[];
  readonly raw: string;

  constructor(resNum: number, symbol = "", spins: string[] = [], raw = "") {
    this.resNum = resNum;
    this.symbol = symbol.toUpperCase();
    this.spins = Object.freeze(spins.map(s => s.toUpperCase()));
    this.raw = raw;
  }

  static parse(keyStr: string): SpinSystemKey {
    if (!keyStr) return new SpinSystemKey(0, "", [], "");

    const rawClean = keyStr.trim();
    const parts = rawClean.split("-");

    const p0 = parts[0].trim();
    let sym = "";
    let rnum = 0;
    let spin0 = "";

    const mNum3 = p0.match(/^(\d+)([A-Za-z]{3})(.*)$/);
    const m3 = p0.match(/^([A-Za-z]{3})(\d+)(.*)$/);
    const m1 = p0.match(/^([A-Za-z]?)(\d+)(.*)$/);
    const mNum1 = p0.match(/^(\d+)([A-Za-z])(.*)$/);

    if (mNum3) {
      rnum = parseInt(mNum3[1], 10) || 0;
      const aa3 = mNum3[2].toUpperCase();
      sym = AA_3TO1[aa3] || aa3[0];
      spin0 = mNum3[3].trim();
    } else if (m3) {
      const aa3 = m3[1].toUpperCase();
      sym = AA_3TO1[aa3] || aa3[0];
      rnum = parseInt(m3[2], 10) || 0;
      spin0 = m3[3].trim();
    } else if (m1 && m1[2]) {
      sym = m1[1].toUpperCase();
      rnum = parseInt(m1[2], 10) || 0;
      spin0 = m1[3].trim();
    } else if (mNum1) {
      rnum = parseInt(mNum1[1], 10) || 0;
      const letter = mNum1[2].toUpperCase();
      const rem = mNum1[3].trim();
      if (letter === "N" || letter === "C" || letter === "H") {
        sym = "";
        spin0 = `${letter}${rem}`;
      } else {
        sym = letter;
        spin0 = rem;
      }
    } else {
      sym = "";
      rnum = 0;
      spin0 = p0;
    }

    const spinsList: string[] = [];
    if (spin0) {
      spinsList.push(spin0.toUpperCase());
    } else if (rnum > 0) {
      spinsList.push("N");
    }

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      // If sub-spin has residue prefix e.g. "G2HN" in "G2N-G2HN", strip prefix
      const subM = p.match(/^[A-Za-z]?\d+(.*)$/);
      if (subM && subM[1]) {
        spinsList.push(subM[1].trim().toUpperCase());
      } else {
        spinsList.push(p.toUpperCase());
      }
    }

    return new SpinSystemKey(rnum, sym, spinsList, rawClean);
  }

  format(style: "canonical" | "short" = "canonical"): string {
    const includeSymbol = style === "canonical";
    const prefix = includeSymbol && this.symbol ? `${this.symbol}${this.resNum}` : `${this.resNum}`;
    if (this.spins.length === 0) return prefix;

    const firstSpin = this.spins[0];
    const firstPart = `${prefix}${firstSpin}`;
    if (this.spins.length === 1) return firstPart;

    const otherSpins = this.spins.slice(1).join("-");
    return `${firstPart}-${otherSpins}`;
  }

  get canonical(): string {
    return this.format("canonical");
  }

  get short(): string {
    return this.format("short");
  }

  matches(other: SpinSystemKey): boolean {
    if (this.resNum !== other.resNum) return false;
    if (this.symbol && other.symbol && this.symbol !== other.symbol) return false;
    return true;
  }
}

/**
 * Parses any residue/spin key string into a typed SpinSystemKey.
 */
export function parseSpinKey(rawKey: string): SpinSystemKey {
  return SpinSystemKey.parse(rawKey);
}

/**
 * Normalizes a residue label to canonical form (e.g., "GLY13N" -> "G13N", "13N" -> "13N").
 */
export function normalizeResidueKey(label: string): string {
  if (!label) return "";
  const parsed = SpinSystemKey.parse(label);
  return parsed.canonical;
}

/**
 * Extracts a numeric value for sorting residues (e.g., "13N" -> 13, "G14N" -> 14, "L3CD1-HD1" -> 3).
 */
export function extractResidueNumber(resKey: string): number {
  return SpinSystemKey.parse(resKey).resNum;
}

/**
 * Sorts keys numerically by residue number regardless of prefix or format.
 */
export function sortSpinKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const pA = SpinSystemKey.parse(a);
    const pB = SpinSystemKey.parse(b);
    if (pA.resNum !== pB.resNum) {
      return pA.resNum - pB.resNum;
    }
    if (pA.symbol !== pB.symbol) {
      return pA.symbol.localeCompare(pB.symbol);
    }
    return a.localeCompare(b);
  });
}

/**
 * Deduplicates spin keys representing the same spin system entity (e.g. "32N" and "32N-H").
 * Prefers shorter keys (e.g. "32N" over "32N-H") or keys without trailing coupled partner.
 */
export function deduplicateSpinKeys(keys: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const parsed = SpinSystemKey.parse(k);
    const gid = parsed.resNum > 0
      ? `${parsed.resNum}_${parsed.symbol}_${parsed.spins[0] || ''}`
      : `raw_${k}`;
    const list = groups.get(gid) || [];
    list.push(k);
    groups.set(gid, list);
  }

  const result: string[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.length - b.length || a.localeCompare(b));
    result.push(list[0]);
  }
  return sortSpinKeys(result);
}

/**
 * Resolves a range expression (e.g. "13-15, 25, 40-44") against available keys.
 */
export function resolveNumericRange(
  rangeExpr: string,
  availableKeys: string[]
): { matched: string[]; unmatched: string[] } {
  if (!rangeExpr || !rangeExpr.trim()) {
    return { matched: [], unmatched: [] };
  }

  const tokens = rangeExpr.trim().split(/[,;\s]+/).filter(Boolean);
  const targetNumbers = new Set<number>();
  const unmatched: string[] = [];

  for (const token of tokens) {
    if (token.includes("-")) {
      const parts = token.split("-");
      if (parts.length === 2) {
        const sNum = parseInt(parts[0].replace(/\D/g, ""), 10);
        const eNum = parseInt(parts[1].replace(/\D/g, ""), 10);
        if (!isNaN(sNum) && !isNaN(eNum) && sNum <= eNum) {
          for (let i = sNum; i <= eNum; i++) {
            targetNumbers.add(i);
          }
        } else {
          unmatched.push(token);
        }
      } else {
        unmatched.push(token);
      }
    } else {
      const num = parseInt(token.replace(/\D/g, ""), 10);
      if (!isNaN(num)) {
        targetNumbers.add(num);
      } else {
        unmatched.push(token);
      }
    }
  }

  const matched = availableKeys.filter(k => {
    const p = SpinSystemKey.parse(k);
    return targetNumbers.has(p.resNum);
  });

  return { matched, unmatched };
}

export interface SpinKeyMatchResult {
  matched: Array<{ source: string; target: string; resNum: number }>;
  unmatchedSource: string[];
  unmatchedTarget: string[];
}

/**
 * Matches two sets of spin-system keys of potentially different formats.
 */
export function matchSpinKeySets(
  sourceKeys: string[],
  targetKeys: string[]
): SpinKeyMatchResult {
  const srcParsed = sourceKeys.map(s => ({ key: s, parsed: SpinSystemKey.parse(s) }));
  const tgtParsed = targetKeys.map(t => ({ key: t, parsed: SpinSystemKey.parse(t) }));

  const matched: Array<{ source: string; target: string; resNum: number }> = [];
  const matchedSrc = new Set<string>();
  const matchedTgt = new Set<string>();

  for (const s of srcParsed) {
    for (const t of tgtParsed) {
      if (matchedTgt.has(t.key)) continue;
      if (s.parsed.matches(t.parsed)) {
        matched.push({
          source: s.key,
          target: t.key,
          resNum: s.parsed.resNum || t.parsed.resNum,
        });
        matchedSrc.add(s.key);
        matchedTgt.add(t.key);
        break;
      }
    }
  }

  const unmatchedSource = sourceKeys.filter(s => !matchedSrc.has(s));
  const unmatchedTarget = targetKeys.filter(t => !matchedTgt.has(t));

  return {
    matched,
    unmatchedSource,
    unmatchedTarget,
  };
}
