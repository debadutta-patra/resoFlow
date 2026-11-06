from dataclasses import dataclass
from typing import Dict, List, Any, Optional

@dataclass
class GeneratedExperiment:
    """Represents a generated experiment ready for ChemEx."""
    toml_content: str
    written_data_files: Dict[str, str] # e.g. mapping of residue name to file content (or just file names)
    inspection_profiles: List[Dict[str, Any]]
    settings_hash: str
