import traceback
from app.services.fitting.service import preview_clusters
from app.schemas import ClusterPreviewResponse

file_path = "/home/debadutta/Documents/resoFlow/test_data/cest.ft2"
peaklist_path = "/home/debadutta/Documents/resoFlow/test_data/ccpnTable.csv"

payload_preview = {
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "clustering_method": "auto",
    "struc_el": "disk",
    "struc_size": [3]
}

res = preview_clusters(
    spectrum_path=file_path,
    peaklist_path=peaklist_path,
    **payload_preview
)

try:
    obj = ClusterPreviewResponse(**res)
    print("Pydantic validation passed! Total peaks:", obj.total_peaks)
except Exception as e:
    traceback.print_exc()
