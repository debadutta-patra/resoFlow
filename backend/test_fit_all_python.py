import traceback
from app.services.fitting.service import run_peak_fitting
from app.schemas import PeakFittingResponse
from fastapi.encoders import jsonable_encoder
import json

file_path = "/home/debadutta/Documents/resoFlow/test_data/cest.ft2"
peaklist_path = "/home/debadutta/Documents/resoFlow/test_data/ccpnTable.csv"

payload = {
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "lineshape": "PV",
    "fit_method": "leastsq",
    "clustering_method": "auto",
    "struc_el": "disk",
    "struc_size": [3],
    "noise": None,
    "max_cluster_size": None,
    "to_fix": ["fraction", "sigma", "center"]
}

try:
    res = run_peak_fitting(
        spectrum_path=file_path,
        peaklist_path=peaklist_path,
        **payload
    )
    obj = PeakFittingResponse(**res)
    encoded = jsonable_encoder(obj)
    json.dumps(encoded, allow_nan=False)
    print("SUCCESS! Full fit completed spanning", obj.summary.total_clusters, "clusters.")
except Exception as e:
    traceback.print_exc()
