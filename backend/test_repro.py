from app.services.fitting.service import preview_clusters, fit_single_cluster

file_path = "/home/debadutta/Documents/resoFlow/test_data/cest.ft2"
peaklist_path = "/home/debadutta/Documents/resoFlow/test_data/ccpnTable.csv"

# 1. Preview clusters to mimic what UI does (and get peaks)
payload_preview = {
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "clustering_method": "mask",
    "struc_el": "disk",
    "struc_size": [3]
}

res = preview_clusters(
    spectrum_path=file_path,
    peaklist_path=peaklist_path,
    **payload_preview
)

peaks = res["peaks"]

# 2. Fit a valid cluster
valid_clusters = list(set(p["CLUSTID"] for p in peaks if p.get("CLUSTID") is not None))
target_cluster = valid_clusters[0]

payload_fit = {
    "cluster_id": target_cluster,
    "peaks": peaks,
    "peaklist_format": "csv",
    "dims": [0, 1, 2],
    "x_radius_ppm": 0.075,
    "y_radius_ppm": 0.48,
    "lineshape": "PV",
    "fit_method": "leastsq",
    "clustering_method": "mask",
    "struc_el": "disk",
    "struc_size": [3],
    "noise": None,
    "to_fix": ["fraction", "sigma", "center"]
}

try:
    res2 = fit_single_cluster(
        spectrum_path=file_path,
        peaklist_path=peaklist_path,
        **payload_fit
    )
    print("Success")
except Exception as e:
    import traceback
    traceback.print_exc()
