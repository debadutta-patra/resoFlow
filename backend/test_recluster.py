import requests

try:
    auth_res = requests.post("http://127.0.0.1:8000/auth/login", data={"username": "admin", "password": "password"})
    if auth_res.status_code == 200:
        token = auth_res.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        payload = {
            "peaks": [
                {
                    "X_PPM": 2.5,
                    "Y_PPM": 10.5,
                    "X_RADIUS": 0.04,
                    "Y_RADIUS": 0.4,
                    "INTENSITY": 10000.0,
                    "ASS": "Peak_1",
                    "CLUSTID": 1
                }
            ],
            "peaklist_format": "csv",
            "dims": [0, 1, 2],
            "clustering_method": "auto",
            "struc_el": "disk",
            "struc_size": [3],
            "noise": None
        }
        
        # We test the recluster endpoint
        res = requests.post("http://127.0.0.1:8000/projects/1/spectra/1/fitting/recluster", json=payload, headers=headers)
        print("Status:", res.status_code)
        try:
            print(res.json())
        except Exception:
            print(res.text)
    else:
        print("Auth failed", auth_res.status_code, auth_res.text)
except Exception as e:
    print(e)
