import requests

try:
    auth_res = requests.post("http://localhost:8000/api/auth/token", data={"username": "admin", "password": "password"})
    if auth_res.status_code == 200:
        token = auth_res.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
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
        
        # We test the fit-all endpoint (run fitting for the whole module)
        res = requests.post("http://localhost:8000/api/projects/1/spectra/1/fitting/fit", json=payload, headers=headers)
        print("Status Fit All:", res.status_code)
        try:
            print(res.json().get('summary'))
        except Exception:
            print(res.text)
    else:
        print("Auth failed", auth_res.status_code, auth_res.text)
except Exception as e:
    print(e)
