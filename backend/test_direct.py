from app.services.fitting.service import fit_single_cluster
import json

payload = {
    "cluster_id": 51,
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "lineshape": "PV",
    "fit_method": "leastsq",
    "clustering_method": "mask",
    "struc_el": "disk",
    "struc_size": [3]
}

try:
    with open('/home/debadutta/Documents/resoFlow/backend/peaks.json') as f:
        peaks = json.load(f)
except Exception:
    peaks = []

try:
    res = fit_single_cluster(
        spectrum_path="/home/debadutta/Documents/resoFlow/data/project_1/spectra/1/test.ft2",
        peaklist_path="/home/debadutta/Documents/resoFlow/data/project_1/spectra/1/test.csv", # Replace with actual path
        peaks=peaks,
        **payload
    )
    print("Success")
except Exception as e:
    import traceback
    traceback.print_exc()
