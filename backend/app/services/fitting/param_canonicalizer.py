from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class CanonicalParamKey:
    """Canonical representation of a ChemEx parameter key."""
    name: str           # e.g. 'KEX_AB', 'PB', 'DW_AB', 'R2_A'
    scope: str          # 'global' or residue like '14N', '55N'
    field: Optional[str] = None  # e.g. '600.3MHZ' or None
    
    @property
    def is_global(self) -> bool:
        return self.scope == 'global'
    
    @property
    def is_exchange(self) -> bool:
        return self.name in ('KEX_AB', 'KEX', 'PB', 'PA', 'KAB', 'KBA')
    
    def matches(self, name: str, scope: str = 'global',
                field: Optional[str] = None) -> bool:
        """Check if this key matches a query (name, scope[, field]).

        Name and scope must match exactly after normalization. `field` is
        opt-in: passing None keeps the historical behaviour of ignoring it,
        so existing callers are unaffected, while a caller that knows which
        static field it wants can say so. Ignoring the field silently
        matches whichever B0 block happens to come first, and for R2 across
        500/800 MHz that is a difference of tens of percent.
        """
        if self.name != name.upper():
            return False
        if field is not None and not self.matches_field(field):
            return False
        if scope == 'global' and self.is_global:
            return True
        return self.scope == normalize_scope(scope)

    def matches_field(self, field: str) -> bool:
        """Whether this key belongs to the given static field.

        Compares numerically where both sides parse, so "600.3MHZ",
        "600.3mhz" and "600.3" agree. A key with no field qualifier matches
        any request, since a single-field fit writes no qualifier at all.
        """
        if self.field is None:
            return True
        mine = parse_field_mhz(self.field)
        theirs = parse_field_mhz(field)
        if mine is None or theirs is None:
            return str(self.field).upper() == str(field).upper()
        return abs(mine - theirs) < 1e-6
    
    def __str__(self) -> str:
        parts = [self.name]
        if not self.is_global:
            parts.append(f'NUC->{self.scope}')
        if self.field:
            parts.append(f'B0->{self.field}')
        return ', '.join(parts)


def parse_field_mhz(field: Optional[str]) -> Optional[float]:
    """Turn a ChemEx B0 qualifier such as "600.3MHZ" into MHz."""
    if field is None:
        return None
    text = str(field).upper().replace("MHZ", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def normalize_scope(scope: str) -> str:
    """Normalize a residue/scope identifier.
    '32' -> '32N', '14N' -> '14N', 'C14N' -> '14N', 'global' -> 'global'
    """
    s = scope.strip().upper()
    if s == 'GLOBAL' or s == '':
        return 'global'
    # Strip leading 'C' from forms like 'C14N'
    if s.startswith('C') and len(s) > 1 and s[1:2].isdigit():
        s = s[1:]
    # If purely numeric, append 'N'
    if s.isdigit():
        s = s + 'N'
    return s


def canonicalize(raw_name: str) -> CanonicalParamKey:
    """Parse a raw ChemEx parameter key into its canonical form."""
    cleaned = raw_name.strip().strip('"').strip("'").strip("[]").strip()
    
    parts = [p.strip() for p in cleaned.split(',') if p.strip()]
    if not parts:
        return CanonicalParamKey(name="", scope="global", field=None)
    name = parts[0].upper()
    
    scope = 'global'
    field = None
    
    for part in parts[1:]:
        if part.startswith('NUC->'):
            scope = normalize_scope(part[5:])
        elif part.startswith('B0->'):
            field = part[4:].upper()
            
    return CanonicalParamKey(name=name, scope=scope, field=field)


def canonicalize_header(header: str) -> list[CanonicalParamKey]:
    """Parse a full TSV header line into canonical keys.
    Handles the tab-separated bracket-enclosed format.
    """
    keys = []
    # Strip newline or trailing spaces
    header = header.strip()
    if not header:
        return keys
        
    cols = header.split('\t')
    for col in cols:
        col = col.strip()
        # skip empty columns or chisqr
        if not col or col.lower() in ('chisqr', 'chi2', 'chisq'):
            continue
        keys.append(canonicalize(col))
        
    return keys


def match_param_in_keys(name: str, scope: str, keys: list[CanonicalParamKey]) -> Optional[int]:
    """Find the index of the first key that matches the given name and scope."""
    for idx, key in enumerate(keys):
        if key.matches(name, scope):
            return idx
    return None
