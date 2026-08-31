from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

AA_3TO1 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLU": "E", "GLN": "Q", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}

AA_1TO3 = {v: k for k, v in AA_3TO1.items()}


@dataclass(frozen=True)
class SpinSystemKey:
    """
    Typed representation of an NMR spin-system key.
    Examples:
      - G2N: res_num=2, symbol='G', spins=('N',)
      - 2N: res_num=2, symbol='', spins=('N',)
      - G2N-HN: res_num=2, symbol='G', spins=('N', 'HN')
      - G2HN-N: res_num=2, symbol='G', spins=('HN', 'N')
      - L3CD1-HD1: res_num=3, symbol='L', spins=('CD1', 'HD1')
    """
    res_num: int
    symbol: str = ""
    spins: Tuple[str, ...] = ()
    raw: str = ""

    @classmethod
    def parse(cls, key_str: str) -> SpinSystemKey:
        if not key_str:
            return cls(res_num=0, raw="")

        raw_clean = key_str.strip()
        parts = raw_clean.split("-")

        # Parse first part (e.g. "GLY14N", "G14N", "14N", "40ASN", "71LYS", "L3CD1", "3CD1")
        p0 = parts[0].strip()
        m_num3 = re.match(r"^(\d+)([A-Za-z]{3})(.*)$", p0)
        m3 = re.match(r"^([A-Za-z]{3})(\d+)(.*)$", p0)
        m1 = re.match(r"^([A-Za-z]?)(\d+)(.*)$", p0)
        m_num1 = re.match(r"^(\d+)([A-Za-z])(.*)$", p0)

        if m_num3:
            rnum = int(m_num3.group(1))
            aa3 = m_num3.group(2).upper()
            sym = AA_3TO1.get(aa3, aa3[0])
            spin0 = m_num3.group(3).strip()
        elif m3:
            aa3 = m3.group(1).upper()
            sym = AA_3TO1.get(aa3, aa3[0])
            rnum = int(m3.group(2))
            spin0 = m3.group(3).strip()
        elif m1 and m1.group(2):
            sym = m1.group(1).upper()
            rnum = int(m1.group(2))
            spin0 = m1.group(3).strip()
        elif m_num1:
            rnum = int(m_num1.group(1))
            letter = m_num1.group(2).upper()
            rem = m_num1.group(3).strip()
            if letter in ("N", "C", "H"):
                sym = ""
                spin0 = f"{letter}{rem}"
            else:
                sym = letter
                spin0 = rem
        else:
            sym = ""
            rnum = 0
            spin0 = p0

        spins_list: List[str] = []
        if spin0:
            spins_list.append(spin0.upper())
        elif rnum > 0:
            spins_list.append("N")

        for p in parts[1:]:
            p_clean = p.strip()
            # If sub-spin has residue prefix e.g. "G2HN" in "G2N-G2HN", strip prefix
            sub_m = re.match(r"^[A-Za-z]?\d+(.*)$", p_clean)
            if sub_m and sub_m.group(1):
                spins_list.append(sub_m.group(1).strip().upper())
            else:
                spins_list.append(p_clean.upper())

        return cls(
            res_num=rnum,
            symbol=sym,
            spins=tuple(spins_list),
            raw=raw_clean,
        )

    def format(self, style: str = "canonical", include_symbol: bool = True) -> str:
        """
        Format spin key according to style:
          - canonical: G2N, G2N-HN, L3CD1-HD1
          - short: 2N, 2N-HN, 3CD1-HD1 (no AA symbol)
          - chemex_15n: 2N (or G2N if symbol requested)
        """
        prefix = f"{self.symbol}{self.res_num}" if (include_symbol and self.symbol) else f"{self.res_num}"
        if not self.spins:
            return prefix

        first_spin = self.spins[0]
        first_part = f"{prefix}{first_spin}"
        if len(self.spins) == 1:
            return first_part

        other_spins = "-".join(self.spins[1:])
        return f"{first_part}-{other_spins}"

    @property
    def canonical(self) -> str:
        return self.format(include_symbol=True)

    @property
    def short(self) -> str:
        return self.format(include_symbol=False)

    def matches(self, other: SpinSystemKey) -> bool:
        """Check if two keys represent the same residue entity."""
        if self.res_num != other.res_num:
            return False
        if self.symbol and other.symbol and self.symbol != other.symbol:
            return False
        return True


def sort_spin_keys(keys: Sequence[str]) -> List[str]:
    """Sort keys numerically by residue number, then alphabetically."""
    parsed_pairs = [(SpinSystemKey.parse(k), k) for k in keys]
    parsed_pairs.sort(key=lambda p: (p[0].res_num, p[0].symbol, p[0].spins, p[1]))
    return [p[1] for p in parsed_pairs]


def resolve_numeric_range(range_expr: str, available_keys: Sequence[str]) -> Tuple[List[str], List[str]]:
    """
    Resolve range expression (e.g. "13-15, 25, 40-44") against available keys.
    Returns (matched_keys, unrecognized_tokens).
    """
    tokens = re.split(r"[,;\s]+", range_expr.strip())
    tokens = [t for t in tokens if t]
    target_numbers: Set[int] = set()
    unrecognized: List[str] = []

    for token in tokens:
        if "-" in token:
            parts = token.split("-")
            if len(parts) == 2:
                try:
                    s_num = int(re.sub(r"\D", "", parts[0]))
                    e_num = int(re.sub(r"\D", "", parts[1]))
                    if s_num <= e_num:
                        for n in range(s_num, e_num + 1):
                            target_numbers.add(n)
                    else:
                        unrecognized.append(token)
                except ValueError:
                    unrecognized.append(token)
            else:
                unrecognized.append(token)
        else:
            try:
                num = int(re.sub(r"\D", "", token))
                target_numbers.add(num)
            except ValueError:
                unrecognized.append(token)

    parsed_keys = [(SpinSystemKey.parse(k), k) for k in available_keys]
    matched = [k for p, k in parsed_keys if p.res_num in target_numbers]
    return matched, unrecognized


def match_spin_key_sets(
    source_keys: Sequence[str],
    target_keys: Sequence[str]
) -> Dict[str, Any]:
    """
    Match two sets of spin-system keys of potentially different formats.
    Returns:
      {
        "matched": [{"source": s, "target": t, "res_num": n}, ...],
        "unmatched_source": [...],
        "unmatched_target": [...]
      }
    """
    src_parsed = {s: SpinSystemKey.parse(s) for s in source_keys}
    tgt_parsed = {t: SpinSystemKey.parse(t) for t in target_keys}

    matched: List[Dict[str, Any]] = []
    matched_src: Set[str] = set()
    matched_tgt: Set[str] = set()

    for s, s_key in src_parsed.items():
        for t, t_key in tgt_parsed.items():
            if t in matched_tgt:
                continue
            if s_key.matches(t_key):
                matched.append({
                    "source": s,
                    "target": t,
                    "res_num": s_key.res_num or t_key.res_num,
                })
                matched_src.add(s)
                matched_tgt.add(t)
                break

    unmatched_src = [s for s in source_keys if s not in matched_src]
    unmatched_tgt = [t for t in target_keys if t not in matched_tgt]

    return {
        "matched": matched,
        "unmatched_source": unmatched_src,
        "unmatched_target": unmatched_tgt,
    }
