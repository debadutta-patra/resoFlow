import os
import sys
import json
from decimal import Decimal

# Setup environment
sys.path.append('/home/debadutta/Documents/resoFlow/backend')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')

# Mock celery before imports
from unittest.mock import MagicMock
sys.modules["celery"] = MagicMock()
sys.modules["...celery_app"] = MagicMock()
sys.modules["...models"] = MagicMock()
sys.modules["...database"] = MagicMock()

# Use a standalone parser call instead of full Django if possible
from app.services.fitting.cest_tasks import _parse_chemex_output

analysis_dir = "/home/debadutta/Documents/drb2d1_relaxation/high_conc/drb2d1/cest_fitting/785a5349-2366-43df-acc4-fb51a44a03af"
print(f"Reparsing {analysis_dir}...")

results = _parse_chemex_output(analysis_dir)

# Print some results for verification
residues = results.get("residues", {})
print(f"Found {len(residues)} residues.")

# Check L73N
l73 = residues.get("L73N", {}).get("parameters", {})
print(f"L73N Params: {l73}")

# Check I43N (which was previously missing DW_AB)
i43 = residues.get("I43N", {}).get("parameters", {})
print(f"I43N Params: {i43}")

with open(os.path.join(analysis_dir, "results.json"), "w") as f:
    json.dump(results, f, indent=2)
print("Updated results.json")
