import traceback
from app.services.fitting.service import generate_fitted_cluster_surfaces

try:
    res = generate_fitted_cluster_surfaces(
        spectrum_path="examples/1D/bruker/1/pdata/1/1r", # need a real file if it actually opens it
        peaklist_path="examples/1D/bruker/1/pdata/1/peaklist.csv",
        cluster_id=59,
        fitted_peaks=[{"amp": 1.0, "center_x_ppm": 4.1, "center_y_ppm": 120.4}],
        dims=[0, 1, 2],
        lineshape="PV",
        clustering_method="auto",
        peaklist_format="csv",
        struc_el="disk",
        struc_size=[3]
    )
    print("Success")
except Exception as e:
    traceback.print_exc()
