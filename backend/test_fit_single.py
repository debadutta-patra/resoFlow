import asyncio
from httpx import AsyncClient
from app.main import app

async def test_fit():
    async with AsyncClient(app=app, base_url="http://test") as ac:
        auth_response = await ac.post("/api/auth/token", data={"username": "admin", "password": "password"})
        if auth_response.status_code == 200:
            token = auth_response.json()["access_token"]
            headers = {"Authorization": f"Bearer {token}"}
            
            # Fetch preview to get the peaks first
            preview_payload = {
                "peaklist_format": "csv",  # from UI
                "x_radius_ppm": 0.075,
                "y_radius_ppm": 0.48,
                "clustering_method": "mask",
                "struc_el": "disk",
                "struc_size": [3]
            }
            res = await ac.post("/api/projects/1/spectra/1/fitting/preview-clusters", json=preview_payload, headers=headers)
            peaks = res.json().get('peaks', [])
            
            # Now fit cluster 51
            payload = {
                "cluster_id": 51,
                "peaks": peaks,
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
            res2 = await ac.post("/api/projects/1/spectra/1/fitting/fit-cluster", json=payload, headers=headers)
            print("Fit status:", res2.status_code)
            print("Result:", res2.text)

if __name__ == "__main__":
    asyncio.run(test_fit())
