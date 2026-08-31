from fastapi.testclient import TestClient
from app.main import app
import traceback

client = TestClient(app)

payload = {
    "peaklist_format": "pipe",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "clustering_method": "auto",
    "struc_el": "disk",
    "struc_size": [3]
}

try:
    response = client.post("/api/projects/1/spectra/1/fitting/preview-clusters", json=payload)
    print("STATUS", response.status_code)
    print("TEXT", response.text)
except Exception as e:
    traceback.print_exc()
