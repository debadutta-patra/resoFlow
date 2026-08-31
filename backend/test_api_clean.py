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
            "clustering_method": "mask",
            "struc_el": "disk",
            "struc_size": [3]
        }
        
        res = requests.post("http://localhost:8000/api/projects/1/spectra/1/fitting/preview-clusters", json=payload, headers=headers)
        print("Status:", res.status_code)
        try:
            print(res.json())
        except Exception:
            print(res.text)
    else:
        print("Auth failed", auth_res.status_code, auth_res.text)
except Exception as e:
    print(e)
