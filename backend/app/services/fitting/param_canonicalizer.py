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
    
    def matches(self, name: str, scope: str = 'global') -> bool:
        """Check if this key matches a query (name, scope).
        Both name and scope must match exactly (after normalization).
        """
        if self.name != name.upper():
            return False
        if scope == 'global' and self.is_global:
            return True
        return self.scope == normalize_scope(scope)
    
    def __str__(self) -> str:
        parts = [self.name]
        if not self.is_global:
            parts.append(f'NUC->{self.scope}')
        if self.field:
            parts.append(f'B0->{self.field}')
        return ', '.join(parts)


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
    
    parts = [p.strip() for p in cleaned.split(', ')]
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
