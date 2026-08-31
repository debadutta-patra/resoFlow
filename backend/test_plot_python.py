import traceback
import json
from fastapi.encoders import jsonable_encoder
from app.services.fitting.service import generate_fitted_cluster_surfaces
from app.schemas import SingleClusterFitResponse

file_path = "/home/debadutta/Documents/resoFlow/test_data/cest.ft2"
peaklist_path = "/home/debadutta/Documents/resoFlow/test_data/ccpnTable.csv"

# Mock fitted_peaks based on how the frontend might send it
fitted_peaks = [
    {
        "ASS": "bmrb52618.11.GLN.H_bmrb52618.11.GLN.N",
        "X_PPM": 8.0,
        "Y_PPM": 120.0,
        "center_x_ppm": 8.0,
        "center_y_ppm": 120.0,
        "amp": 10000.0,
        "fwhm_x_hz": 20.0,
        "fwhm_y_hz": 20.0,
        "fraction": 0.5,
        "sigma": 5.0,
        "height": 5000.0
    }
]

payload = {
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "lineshape": "PV",
    "clustering_method": "auto",
    "struc_el": "disk",
    "struc_size": [3]
}

try:
    res = generate_fitted_cluster_surfaces(
        spectrum_path=file_path,
        peaklist_path=peaklist_path,
        cluster_id=1,
        fitted_peaks=fitted_peaks,
        **payload
    )
    obj = SingleClusterFitResponse(**res)
    encoded = jsonable_encoder(obj)
    json.dumps(encoded, allow_nan=False)
    print("SUCCESS! Cluster 1 plot surfaces generated successfully.")
except Exception as e:
    traceback.print_exc()
