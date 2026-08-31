import urllib.request
import json

def main():
    url = "http://localhost:8000/api/projects/1/spectra/1/fitting/plot-fitted-cluster"
    payload = {
        "cluster_id": 59,
        "fitted_peaks": [{"amp": 1.0, "center_x_ppm": 4.1, "center_y_ppm": 120.4}],
        "dims": [0, 1, 2],
        "lineshape": "PV",
        "clustering_method": "auto",
        "peaklist_format": "csv",
        "struc_el": "disk",
        "struc_size": [3]
    }
    
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as response:
            print("Status:", response.status)
            print("Response:", response.read().decode('utf-8')[:500])
    except urllib.error.HTTPError as e:
        print("HTTP Error:", e.code)
        print("Response:", e.read().decode('utf-8'))

if __name__ == "__main__":
    main()
