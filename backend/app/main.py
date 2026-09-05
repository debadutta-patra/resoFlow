import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from . import models, database
from .routers import auth, dashboard, projects, admin, fs, peak_fitting, analysis, experiments, cpmg

database.init_db()

app = FastAPI(title="NMR Relaxation Platform API")

# In production the SPA and API are served from the same origin via the
# Caddy reverse proxy, so CORS is dev-only in practice. CORS_ORIGINS lets a
# non-default deployment (e.g. a separate frontend host) override the list
# without a code change.
_default_cors_origins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", _default_cors_origins).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(auth.router, prefix="/api")
app.include_router(dashboard.router)
app.include_router(projects.router)
app.include_router(admin.router)
app.include_router(fs.router)
app.include_router(peak_fitting.router)
app.include_router(analysis.router)
app.include_router(analysis.analysis_report_router)
app.include_router(analysis.analysis_report_router, prefix="/api")
app.include_router(experiments.router)
app.include_router(cpmg.router)

@app.get("/")
def read_root():
    return {"message": "Welcome to NMR Relaxation Platform API"}
