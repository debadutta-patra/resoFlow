# resoFlow

resoFlow is a self-hosted web platform for NMR relaxation and exchange data analysis. It takes raw spectrometer output (Bruker / NMRPipe) through peak fitting, and drives [ChemEx](https://github.com/gbouvignies/chemex) fits for relaxation dispersion (CPMG), chemical exchange saturation transfer (CEST), and simple relaxation experiments (R1, R2, hetNOE), then presents fitted parameters, uncertainty analysis, and publication-ready reports through a React UI.

It's built for a single research group or lab to run on their own workstation or server — projects and their underlying data live on the host filesystem, ChemEx fits execute in isolated, ephemeral Podman containers, and results are tracked in a Postgres database.

For a walkthrough of using the app itself (projects, peak fitting, CPMG/CEST/relaxation analyses), see the [User Guide](docs/user-guide.md).

## Contents

- [Architecture](#architecture)
- [Core features](#core-features)
- [Installation](#installation)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Testing](#testing)

## Architecture

```
┌─────────────┐      ┌──────────────────────────┐      ┌──────────────────┐
│  React SPA  │─────▶│  FastAPI backend (Uvicorn) │────▶│  Postgres / SQLite │
│ (Vite, TS)  │◀─────│  JWT auth, REST API        │◀─────│  (project, job,   │
└─────────────┘      └──────────────────────────┘      │   analysis state) │
                              │        ▲                └──────────────────┘
                              │        │
                              ▼        │
                      ┌───────────────────────┐        ┌─────────┐
                      │  Redis (Celery broker)│◀──────▶│ Celery  │
                      └───────────────────────┘        │ workers │
                                                         └────┬────┘
                                                              │ spawns
                                                              ▼
                                                  ┌────────────────────────┐
                                                  │ Ephemeral Podman        │
                                                  │ containers running      │
                                                  │ ChemEx fits              │
                                                  └────────────────────────┘
```

- **Backend** — FastAPI app exposing a REST API, backed by SQLAlchemy models and Alembic migrations.
- **Workers** — Celery workers pick up long-running fitting jobs from Redis-backed queues (`chemex`, `peakfit`, `stats`) and stream progress/logs back to the database.
- **ChemEx execution** — CPMG and CEST fits run inside deterministically-named, per-job Podman containers, with host/container path translation, atomic output staging, and orphan-container reaping on worker startup — so a fit is fully isolated from the worker process and safely cancellable.
- **Frontend** — React 19 + TypeScript SPA (Vite, Tailwind, Plotly) that talks to the API under `/api` and `/auth`.
- **Data on disk** — Each project owns a directory on the host (or a mounted volume in the containerized deployment) holding spectra, ChemEx output trees, and a `resoFlow.json` project index kept in sync with the database.

## Core features

- **Project & spectrum management** — organize spectra (Bruker pdata directories or NMRPipe `.ft2` files) into projects, browse/import from the host filesystem, auto-extract B0 from spectral metadata.
- **Interactive peak fitting** — cluster picking/preview, per-cluster lineshape fitting (Gaussian/Lorentzian/pseudo-Voigt/PV-PV), re-clustering, and job-level progress/log streaming.
- **Relaxation analysis (R1/R2/hetNOE)** — exponential decay fitting across a project's spectra with statistics.
- **CPMG relaxation dispersion** — ChemEx-driven dispersion curve fitting, per-experiment method/config generation, live log streaming, cancellation, and diagnostics.
- **CEST** — ChemEx-driven CEST profile fitting with the same config/run/log/cancel lifecycle, plus PDF report generation.
- **Statistics & uncertainty** — parses ChemEx's grid search, Monte Carlo, Bootstrap, and MCMC output trees into structured, provenance-tracked results, with parameter histograms, joint-distribution plots, and raw replicate downloads.
- **Reporting & export** — modern PDF report generation with proper uncertainty resolution and derived-kinetics propagation, plus streamed ZIP export of full analysis output trees via signed, expiring download tokens.
- **Admin & multi-user** — JWT-based auth with an approval gate (new registrations are inactive until an admin activates them), a superuser admin panel for user management, and per-user project scoping enforced at the dependency layer.
- **Dashboard** — cross-project overview of active runs, recent analyses, and job cancellation.

## Installation

resoFlow ships as a set of Podman containers (API, Celery worker, Postgres, Redis, and a Caddy-served web UI) run as a rootless pod under systemd, using [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) unit files. `deploy/install.sh` builds this out end-to-end on a single Linux host — no Kubernetes, no root/sudo required.

### Prerequisites

- A Linux host with **systemd** (user session support — `systemctl --user is-system-running`)
- **Podman 4.x or 5.x**, rootless, with a subuid/subgid range allocated for your user (`grep "^$USER:" /etc/subuid`) — the installer auto-selects Quadlet on Podman 5.x and systemd user services on Podman 4.x
- `curl` (used by the installer's post-start health check)
- `openssl` for secret generation (falls back to `python3 -c "import secrets..."` if absent)

### 1. Build (or unpack) the container images

If you have the source tree and a container build toolchain available:

```bash
./containers/build.sh
```

This builds five images in order — `resoflow-base` (shared Python/scientific base), `resoflow-api`, `resoflow-worker`, `resoflow-chemex` (the per-job ChemEx execution image), and `resoflow-web` (built SPA + Caddy) — all tagged `localhost/resoflow-*:latest` plus a git-describe version tag.

For an air-gapped lab machine, build a self-contained offline bundle on a connected machine instead:

```bash
./deploy/bundle.sh [version]
```

This produces `dist/resoflow-<version>-offline-bundle.tar.gz`, containing the pre-built images (`podman save`d as tarballs), the Quadlet units, `install.sh`/`uninstall.sh`, and a generated `INSTALL.md`. Copy that archive to the target host, extract it, and run `./install.sh` from inside — the installer auto-detects and `podman load`s any image tarballs found under its own `images/` directory before proceeding.

### 2. Run the installer

#### Linux / macOS
```bash
./deploy/install.sh
```
*(On macOS, install Podman first via `brew install podman`. The installer initializes and starts `podman machine` and registers `launchd` LaunchAgents).*

#### Windows (WSL 2)
Open PowerShell and run:
```powershell
.\deploy\windows\install.ps1
```
*(The PowerShell script verifies WSL 2, enables native `systemd` support, delegates to `install.sh`, and creates a Windows Desktop shortcut).*

---

Run without flags in a terminal, it prompts interactively for:

1. **Base port** for the web UI (default `8080`; the API gets `8000` if you keep the default, or `port + 1` otherwise).
2. **Host storage path** for project data — spectra, ChemEx output trees, the project JSON index (default `~/.local/share/resoflow/projects`).
3. Whether to **create an administrator account** now (email, full name, password), so there's a usable login the moment the pod comes up.

For scripted/unattended installs on any platform, pass CLI flags:

```bash
./deploy/install.sh -y \
  --port 50000 \
  --data-dir /mnt/nmr_data \
  --admin-email admin@lab.org \
  --admin-password 'change-me'
```

| Flag | Description |
|---|---|
| `-p`, `--port PORT` | Base port for the web UI (default `8080`); the API port is derived from it unless overridden. |
| `--api-port PORT` | Override the internal backend API port explicitly. |
| `--lan` | Allow access over local network (binds to `0.0.0.0` instead of `127.0.0.1`). |
| `--bind IP` | Bind IP address for Web UI (default `127.0.0.1`). |
| `-d`, `--data-dir PATH` | Host directory for project/spectra storage (default `~/.local/share/resoflow/projects`). |
| `--admin-email EMAIL` | Initial administrator account email. |
| `--admin-password PWD` | Initial administrator account password. |
| `--admin-name NAME` | Initial administrator full name (default `Administrator`). |
| `--skip-admin` / `--no-admin` | Don't create an admin account during install. |
| `-y`, `--non-interactive` | Run unattended, using flags/defaults instead of prompting. |
| `-h`, `--help` | Show usage and exit. |

### What the installer does

1. **Pre-flight checks** — verifies `podman` is available, initializes `podman machine` on macOS, and verifies `systemd` on Linux/WSL.
2. **Loads offline images**, if run from an offline bundle (an adjacent `images/` directory with image tarballs).
3. **Generates secrets** on first run: a Postgres password and the JWT `SECRET_KEY`, written to `~/.config/resoflow/resoflow.env` (`chmod 600`). Re-running the installer against an existing install preserves existing secrets and updates configurations.
4. **Installs service definitions**:
   - **Linux / WSL 2**: Installs Podman 5.x Quadlets (`~/.config/containers/systemd/`) or Podman 4.x systemd user units.
   - **macOS**: Installs native `launchd` LaunchAgents in `~/Library/LaunchAgents/` (`org.resoflow.pod.plist`, `org.resoflow.backup.plist`).
5. **Enables the Podman socket, backup timers, and background persistence**.
6. **Starts the pod and verifies health** by polling the web interface on `http://127.0.0.1:<WEB_PORT>`.
7. **Bootstraps the administrator account**, if requested, inside the running API container.

### Managing the deployment

```bash
# Access
http://127.0.0.1:<WEB_PORT>          # 8080 by default

# Linux / WSL 2 Status & Logs
systemctl --user status resoflow-pod.service
journalctl --user -u resoflow-api -u resoflow-worker -f

# macOS Status & Logs
~/.local/share/resoflow/scripts/resoflow-service.sh status
podman logs -f resoflow-api
```

### Uninstalling

- **Linux / macOS**:
  ```bash
  ./deploy/uninstall.sh                # stops services, removes service definitions; data/config/volumes are kept
  ./deploy/uninstall.sh --purge-data    # also deletes database volumes, secrets, and project data directory
  ```
- **Windows (PowerShell)**:
  ```powershell
  .\deploy\windows\uninstall.ps1
  .\deploy\windows\uninstall.ps1 -PurgeData
  ```

## Local development

### Prerequisites

- Python 3.13 and [uv](https://docs.astral.sh/uv/)
- Node.js 24+ and npm
- Docker or Podman (for the local Postgres/Redis dev containers via `docker-compose.yml`)
- Podman (rootless) if you want to actually execute ChemEx fits locally — the backend degrades gracefully for everything else without it

### Quick start (all services)

```bash
./start_apps.sh
```

This brings up Postgres/Redis (via `docker-compose.yml`), the FastAPI backend, a Celery worker, and the Vite dev server.

- Web app: http://localhost:5173
- API docs (Swagger): http://localhost:8000/docs
- Postgres: `localhost:5433` (`resoflow` / `resoflow`)
- Redis: `localhost:6380`

For live, streamed terminal logs from all processes instead of backgrounded log files, use `./dev.sh`.

Stop the app processes with `./stop_apps.sh` (add `--all` to also stop the DB/cache containers, or `--down` to remove them).

### Running the pieces by hand

```bash
# Backend API
cd backend
uv sync
uv run alembic upgrade head        # only needed against Postgres; SQLite auto-creates tables
uv run uvicorn app.main:app --reload

# Celery worker (separate terminal)
cd backend
uv run celery -A app.celery_app worker --loglevel=info -Q chemex,peakfit,stats,celery

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/auth` to `http://localhost:8000`, so the frontend needs no `VITE_API_URL` in development.

### First admin user

New registrations are inactive until approved. To bootstrap the first admin:

```bash
cd backend
uv run python create_superuser.py
```

## ChemEx Progress Capture

resoFlow captures real-time fit progress from ChemEx in-process to report live status to the frontend.

### Why in-process patching?

ChemEx uses `rich` for its terminal progress rendering. When executed in headless or piped environments (such as Celery worker tasks or child subprocesses without a pseudo-terminal), `rich.live.Live.refresh()` suppresses progress display because `console.is_terminal` evaluates to `False`. Piped stdout scraping yields only a final summary frame without incremental updates. Instead of fragile ANSI scraping or pty wrappers, resoFlow patches ChemEx's progress call sites directly in-process.

### Pinned ChemEx Version

Pinned target is **ChemEx 2026.6.1** (GPL-3.0-or-later).

Patch targets in `chemex.optimize`:
- `chemex.optimize.gridding.track`: grid search progress iterations.
- `chemex.optimize.resampling.track`: Monte Carlo and bootstrap sample iterations.
- `chemex.optimize.mcmc._RichEmceeProgressBar`: MCMC walker steps.
- `chemex.optimize.minimizer.Reporter.print_line`: plain fit optimization iterations ($\chi^2$, reduced $\chi^2$).

### File Descriptor Contract

The entry point `python -m resoflow.progress` reads the target file descriptor from the `RESOFLOW_PROGRESS_FD` environment variable:
- When `RESOFLOW_PROGRESS_FD` is set, events are emitted as single-line JSON records to that descriptor with line buffering.
- When unset or invalid, output falls back to `sys.stderr` so the module stays runnable by hand.
- **Parent Process Obligation**: The parent process creating the pipe **must drain the fd**. An unread pipe buffer (typically 64 KiB on Linux) will block the child fit process when full.

### Event Schema

Events are flat, JSON-serializable dictionaries with a `kind` discriminator:

| `kind` | Fields | Description |
|---|---|---|
| `grid` | `done: int`, `total: int` | Grid search iteration progress |
| `resample` | `done: int`, `total: int` | Monte Carlo / Bootstrap sample progress |
| `mcmc` | `done: int`, `total: int` | MCMC sampling progress |
| `fit` | `iteration: int`, `chisqr: float`, `redchi: float` | Minimizer convergence iteration |

## Configuration

The backend reads configuration entirely from environment variables (see `deploy/install.sh`'s generated `resoflow.env` for the production set):

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | random per-process (dev only) | JWT signing key. **Must** be set to a stable secret in any real deployment — `openssl rand -hex 32`. The installer generates this automatically. |
| `ALGORITHM` | `HS256` | JWT signing algorithm. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` | JWT token lifetime. |
| `DATABASE_URL` | `sqlite:///.../sql_app.db` | SQLAlchemy database URL. `postgres://`/`postgresql://` are normalized to the `psycopg` v3 driver. |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` / `DB_POOL_RECYCLE` | `5` / `10` / `1800` | Postgres connection pool sizing. |
| `REDIS_URL` | `redis://localhost:6380/0` | Celery broker/result backend. |
| `CORS_ORIGINS` | localhost dev ports | Comma-separated list of allowed CORS origins. Only relevant when the frontend isn't served from the same origin as the API (in production, Caddy reverse-proxies both, so this is dev-only in practice). |
| `RESOFLOW_CHEMEX_IMAGE` | `localhost/resoflow-chemex:latest` | Podman image used to run ChemEx fits. |
| `RESOFLOW_HOST_DATA_ROOT` / `RESOFLOW_CONTAINER_DATA_ROOT` | unset | Path translation between the worker's view of project data and the Podman host's view, needed when the worker itself runs in a container. |
| `CONTAINER_HOST` | unset | Podman API socket URL, for containerized workers talking to the host's rootless Podman. |
| `WEB_PORT` / `API_PORT` | `8080` / `8000` | Ports the `resoflow-web` (Caddy) and `resoflow-api` containers listen on; set by the installer. |

## Testing

```bash
cd backend
uv run pytest
```

The suite covers ChemEx method emission, the ChemEx output-tree parser (against recorded fixture trees in `backend/tests/fixtures/`), statistics/uncertainty resolution, filesystem-endpoint path-traversal protections, dashboard cross-user scoping, and export/report generation.

Frontend:

```bash
cd frontend
npm run lint
npm run test       # vitest
npm run build       # tsc -b && vite build
```
