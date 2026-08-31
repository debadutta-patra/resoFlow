import traceback
from app.services.fitting.service import preview_clusters

file_path = "/home/debadutta/Documents/resoFlow/test_data/cest.ft2"
peaklist_path = "/home/debadutta/Documents/resoFlow/test_data/ccpnTable.csv"

payload_preview = {
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "clustering_method": "mask",
    "struc_el": "disk",
    "struc_size": [3]
}

try:
    res = preview_clusters(
        spectrum_path=file_path,
        peaklist_path=peaklist_path,
        **payload_preview
    )
    print("Success. Peaks found:", len(res["peaks"]))
except Exception as e:
    traceback.print_exc()
