# Peak Fitting Integration — Walkthrough

## What Was Built

Integrated peakipy's NMR peak fitting algorithms directly into resoFlow (vendored, no peakipy dependency).

### Backend — `backend/app/services/fitting/`

| File | Purpose |
|------|---------|
| [constants.py](file:///home/debadutta/Documents/resoFlow/backend/app/services/fitting/constants.py) | Math constants (π, log2, tiny) |
| [lineshapes.py](file:///home/debadutta/Documents/resoFlow/backend/app/services/fitting/lineshapes.py) | All 2D lineshape functions (PV, G, L, V, PV_PV, G_L, PV_G, PV_L) + height/FWHM calculators |
| [io.py](file:///home/debadutta/Documents/resoFlow/backend/app/services/fitting/io.py) | `Pseudo3D` (NMR data wrapper), `Peaklist` (reads NMRPipe/Sparky/Analysis v2/v3/CSV), clustering |
| [fitting.py](file:///home/debadutta/Documents/resoFlow/backend/app/services/fitting/fitting.py) | Core engine: mask creation, lmfit model building, parameter management, fit pipeline |
| [service.py](file:///home/debadutta/Documents/resoFlow/backend/app/services/fitting/service.py) | High-level orchestrator: `run_peak_fitting()` and `preview_clusters()` |

### API Endpoints — [peak_fitting.py](file:///home/debadutta/Documents/resoFlow/backend/app/routers/peak_fitting.py)

- `POST /api/projects/{id}/spectra/{id}/fitting/run` — Full peak fitting
- `POST /api/projects/{id}/spectra/{id}/fitting/preview-clusters` — Clustering preview

### Frontend — [SpectraAnalysis.tsx](file:///home/debadutta/Documents/resoFlow/frontend/src/pages/SpectraAnalysis.tsx)

Replaced placeholder in the Peak Fitting Results tab with a configuration panel + sortable results table + CSV export.

### Other Modified Files

- [pyproject.toml](file:///home/debadutta/Documents/resoFlow/backend/pyproject.toml) — added `nmrglue`, `lmfit`, `numpy`, `pandas`, `scipy`, `scikit-image`
- [schemas.py](file:///home/debadutta/Documents/resoFlow/backend/app/schemas.py) — added `PeakFittingRequest/Response`, `ClusterPreviewRequest/Response`
- [main.py](file:///home/debadutta/Documents/resoFlow/backend/app/main.py) — registered `peak_fitting` router

---

## Verification

### Backend ✅
- `uv run python -c "from app.main import app"` — imports OK
- OpenAPI spec confirms both fitting endpoints registered
- Swagger docs render correctly

### Frontend ✅
- `npx tsc --noEmit` — zero errors
- Peak Fitting tab renders all controls correctly:

![Peak Fitting Tab Screenshot](/home/debadutta/.gemini/antigravity/brain/60bb6dbf-ca5b-41ac-a8fb-77270edb321a/peak_fitting_screenshot.png)

### Browser Flow ✅
Login → Project → Spectrum → Peak Fitting tab — all navigation works. Configuration panel shows all controls with correct defaults.

![Browser recording of the verification flow](/home/debadutta/.gemini/antigravity/brain/60bb6dbf-ca5b-41ac-a8fb-77270edb321a/peak_fitting_final_1772955368334.webp)
