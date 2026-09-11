# resoFlow

resoFlow is a self-hosted web platform for NMR relaxation and exchange data analysis. It takes raw spectrometer output (Bruker / NMRPipe) through peak fitting, and drives [ChemEx](https://github.com/gbouvignies/chemex) fits for relaxation dispersion (CPMG), chemical exchange saturation transfer (CEST), and simple relaxation experiments (R1, R2, hetNOE), then presents fitted parameters, uncertainty analysis, and publication-ready reports through a React UI.

It's built for a single research group or lab to run on their own workstation or server — projects and their underlying data live on the host filesystem, ChemEx fits execute in isolated, ephemeral Podman containers, and results are tracked in a Postgres database.

For a walkthrough of using the app itself (projects, peak fitting, CPMG/CEST/relaxation analyses), see the [User Guide](docs/user-guide.md).

## Contents

- [Architecture](#architecture)
- [Core features](#core-features)
- [Installation](#installation)
  - [Extra browsable directories](#extra-browsable-directories)
  - [Updating resoFlow](#updating-resoflow)
  - [Backing up and restoring](#backing-up-and-restoring)
  - [Troubleshooting](#troubleshooting)
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

resoFlow ships as a set of Podman containers (API, Celery worker, Postgres, Redis, and a Caddy-served web UI) run as a rootless pod. `deploy/install.sh` builds this out end-to-end on a single host — no Kubernetes, no root/sudo required. All platforms run the same containers; only the service supervisor differs:

| Platform | Container runtime | Service supervisor | Units installed to |
|---|---|---|---|
| Linux, Podman 5.x | rootless Podman | systemd user units via [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) | `~/.config/containers/systemd/` |
| Linux, Podman 3.4+ / 4.x | rootless Podman | systemd user units | `~/.config/systemd/user/` |
| Windows 10/11 | rootless Podman **inside WSL 2** | systemd user units inside the distro | `~/.config/...` inside WSL |
| macOS 12+ | Podman machine (Linux VM) | `launchd` LaunchAgents | `~/Library/LaunchAgents/` |

The installer picks the mode for you: Quadlet on Podman 5.x, systemd user services on Podman 3.4+/4.x, launchd on macOS.

### Prerequisites

Common to every platform:

- **Podman 3.4+ or 5.x** (rootless) — on Linux, Podman 3.4.x (such as default Ubuntu 22.04 LTS), 4.x, and 5.x are supported. A standalone static Podman binary or archive can also be pointed to directly without root or system package manager installation
- `curl` — used by the installer's post-start health check
- `openssl` for secret generation (falls back to `python3 -c "import secrets..."` if absent)
- Roughly **2–3 GB** of disk for the built images (they share a common base layer), plus whatever your project data needs

Platform-specific requirements are covered in each section below.

### Step 1 — Build (or unpack) the container images

If you have the source tree and a container build toolchain available:

```bash
./containers/build.sh
```

This builds five images in order — `resoflow-base` (shared Python/scientific base), `resoflow-api`, `resoflow-worker`, `resoflow-chemex` (the per-job ChemEx execution image), and `resoflow-web` (built SPA + Caddy) — each tagged both `localhost/resoflow-*:latest` and with a git-describe version tag. The base image must build first; the others derive from it.

There is **no image registry** — resoFlow images are always local (`localhost/...`) and the service units are set to `Pull=never`. You either build them on the machine or load them from an offline bundle.

For an air-gapped lab machine, build a self-contained offline bundle on a connected machine instead:

```bash
./containers/build.sh          # bundle.sh does not build for you
./deploy/bundle.sh [version]
```

This produces `dist/resoflow-<version>-offline-bundle.tar.gz`, containing the pre-built images (`podman save`d as tarballs, including `postgres:16-alpine` and `redis:7-alpine`), a pinned standalone static Podman release (`5.8.4` for Linux `amd64`/`arm64`), systemd and Quadlet units, `install.sh`/`uninstall.sh`, and a generated `INSTALL.md`. Copy that archive to the target host, extract it, and run `./install.sh` from inside — the installer auto-detects and `podman load`s any image tarballs found under its own `images/` directory, and can automatically extract and configure the bundled static Podman if Podman is missing or outdated on the host.

### Step 2 — Run the installer

#### Linux

Make sure your user has a subuid/subgid range allocated (rootless Podman needs it) and that the systemd user session is live:

```bash
grep "^$USER:" /etc/subuid            # should print a range
systemctl --user is-system-running    # "running" or "degraded" is fine
```

If the subuid range is missing, the installer warns and continues, but containers will likely fail to start. Fix it with:

```bash
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
podman system migrate
```

Then run the installer:

```bash
./deploy/install.sh
```

It keeps the pod alive after you log out by enabling `loginctl enable-linger` for your user.

#### macOS

resoFlow runs inside the Podman machine VM on macOS. Install Podman and bring the VM up **before** running the installer:

```bash
brew install podman
podman machine init --cpus 4 --memory 8192 --disk-size 50   # first time only
podman machine start
```

The installer will create a machine with those same settings (4 CPUs / 8 GB / 50 GB) if none exists, but its "is the machine up?" check can pass while the VM is merely defined and stopped — in which case the install fails later with a "Cannot connect to Podman" error. Starting it yourself first avoids that. If you already have a smaller machine, resize it rather than relying on the defaults:

```bash
podman machine stop && podman machine set --cpus 4 --memory 8192 && podman machine start
```

Then:

```bash
./deploy/install.sh
```

The installer copies `resoflow-service.sh` to `~/.local/share/resoflow/scripts/`, installs the `org.resoflow.pod` and `org.resoflow.backup` LaunchAgents into `~/Library/LaunchAgents/`, and starts the pod. `org.resoflow.pod` has `RunAtLoad`, so resoFlow comes back automatically when you log in.

**macOS-specific limitations, worth knowing before you install:**

- **`--lan` and `--bind` have no effect.** The macOS pod publishes to `127.0.0.1` unconditionally, so the deployment is local-only. Use a Linux host if you need to serve the lab.
- **Keep `--data-dir` under your home directory.** Only `$HOME` is shared into the Podman VM by default; a data dir outside it silently mounts as an empty directory inside the VM.
- **The first start needs internet access**, even with locally built resoFlow images — `postgres:16-alpine` and `redis:7-alpine` are pulled from Docker Hub on macOS.
- **Homebrew's `podman` may not be on launchd's PATH at login.** launchd agents get a minimal `PATH` that excludes `/opt/homebrew/bin` and `/usr/local/bin`, so the agent can fail at login with `Error: 'podman' CLI is not installed.` even though it works fine from Terminal. Check `~/.local/share/resoflow/logs/resoflow-service-err.log` if resoFlow isn't up after a reboot.
- ChemEx jobs spawn sibling containers through the Podman socket, which is mounted from a host path that does not exist inside the VM — expect this to be a rough edge on macOS.

#### Windows (WSL 2)

resoFlow runs inside a WSL 2 Linux distro; the PowerShell script is a wrapper that prepares WSL and delegates to `deploy/install.sh`.

**Before you start:**

1. **Install WSL 2** — in an *elevated* PowerShell: `wsl --install`, then reboot and create your Linux user. (The installer script checks only that `wsl.exe` exists; it does not verify the WSL version or that a distro is present.)
2. **Install Podman 3.4+ inside the distro.** The PowerShell script never checks for or installs Podman — `install.sh` will stop with an error if it's missing or too old. Both Ubuntu 22.04 (ships Podman 3.4) and Ubuntu 24.04 (ships Podman 4.9) are supported out of the box.
   ```bash
   # inside WSL
   sudo apt update && sudo apt install -y podman
   podman --version    # must be >= 3.4
   ```
3. **Clone the repo inside the WSL filesystem** (e.g. `~/resoFlow`), not on `C:\`. Repos under `/mnt/c` have no real Unix ownership, which breaks rootless Podman bind mounts and is markedly slower. The same applies to `-DataDir`.
4. **Allow the script to run** — it is unsigned, so either launch it as below or set `Set-ExecutionPolicy -Scope Process Bypass` first.

Then, from PowerShell in the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
```

What the wrapper does, in order:

1. Checks that `wsl.exe` is available.
2. **Enables systemd** in the distro by appending `[boot]` / `systemd=true` to `/etc/wsl.conf` (as root, no `sudo` prompt), then runs `wsl --shutdown`. ⚠️ **This terminates every running WSL distro** — save and close other WSL work first. Skipped if systemd is already enabled.
3. Normalizes line endings (CRLF → LF) across `deploy/`, `containers/`, and `backend/`. This rewrites files in your working tree, so `git status` may show modifications afterwards.
4. Runs `bash deploy/install.sh` in your **default** WSL distro, passing through the parameters below. There is no way to target a non-default distro — use `wsl --set-default <distro>` if needed. Interactive prompts from `install.sh` appear in the PowerShell window unless you pass `-y`.
5. Writes `%USERPROFILE%\Desktop\resoFlow.url`, pointing at the port that was actually installed.

PowerShell parameters map onto the `install.sh` flags one-to-one:

| PowerShell | Maps to | Notes |
|---|---|---|
| `-Port` / `-p` | `--port` | Default `8080` |
| `-ApiPort` | `--api-port` | |
| `-Lan` | `--lan` | |
| `-Bind` | `--bind` | |
| `-DataDir` / `-d` | `--data-dir` | Accepts a Windows path; translated via `wslpath` |
| `-Podman` | `--podman` | Path to static Podman binary, directory, or `.tar.gz` archive |
| `-UseBundledPodman` | `--use-bundled-podman` | Use bundled static Podman archive |
| `-AdminEmail` | `--admin-email` | |
| `-AdminPassword` | `--admin-password` | |
| `-AdminName` | `--admin-name` | Default `Administrator` |
| `-SkipAdmin` | `--skip-admin` | |
| `-NonInteractive` / `-y` | `-y` | |
| `-Help` | `--help` | Prints usage and exits |

```powershell
.\deploy\windows\install.ps1 -Port 50000 -DataDir "C:\resoflow_data"
.\deploy\windows\install.ps1 -Podman "C:\podman\podman-linux-amd64.tar.gz"
.\deploy\windows\install.ps1 -y -Port 8080 -AdminEmail admin@lab.org -AdminPassword secret
```

> ⚠️ **Alias trap:** `-p` means `-Port` in `install.ps1`, but `-PurgeData` in `uninstall.ps1`. Spell out `-PurgeData` when uninstalling.

**Windows networking notes:**

- `http://127.0.0.1:<port>` works from Windows thanks to WSL 2 localhost forwarding — this is the normal way to reach resoFlow.
- `-Lan` alone does **not** make resoFlow reachable from other machines. WSL 2 sits behind NAT, so you also need a `netsh interface portproxy` rule plus a Windows firewall rule. The "LAN:" address the installer prints is the NAT'd `172.x` VM address, not your Windows host's LAN IP.
- The pod stops when the distro shuts down (including `wsl --shutdown`) and starts again the next time the distro boots with systemd.

### Installer options

Run without flags in a terminal, the installer prompts interactively for:

1. **Base port** for the web UI (default `8080`; the API gets `8000` if you keep the default, or `port + 1` otherwise).
2. **Host storage path** for project data — spectra, ChemEx output trees, the project JSON index (default `~/.local/share/resoflow/projects`).
3. **Additional browsable directories** — any directories outside that storage path the file browser should be able to reach (an instrument drive, a NAS mount). Blank for none; changeable later.
4. Whether to **create an administrator account** now (email, full name, password), so there's a usable login the moment the pod comes up.

For scripted/unattended installs on any platform, pass CLI flags:

```bash
./deploy/install.sh -y \
  --port 50000 \
  --data-dir /mnt/nmr_data \
  --extra-browse-root /mnt/spectrometer \
  --admin-email admin@lab.org \
  --admin-password 'change-me'
```

| Flag | Description |
|---|---|
| `-p`, `--port PORT` | Base port for the web UI (default `8080`); the API port is derived from it unless overridden. |
| `--api-port PORT` | Override the internal backend API port explicitly. |
| `--lan` | Allow access over local network (binds to `0.0.0.0` instead of `127.0.0.1`). |
| `--bind IP` | Bind IP address for Web UI (default `127.0.0.1`). |
| `--extra-browse-root PATH` | Additional host directory the file browser may reach, beyond the data directory. Repeat for several. Sets up the container bind mount and the backend setting together. See [Extra browsable directories](#extra-browsable-directories). |
| `-d`, `--data-dir PATH` | Host directory for project/spectra storage (default `~/.local/share/resoflow/projects`). |
| `--podman PATH` | Path to Podman binary, directory, or static `.tar.gz` archive (default: uses `podman` in `$PATH` or auto-detects bundled Podman). |
| `--use-bundled-podman` | Extract and use the bundled static Podman archive from the offline distribution bundle. |
| `--podman-extract-dir DIR` | Extraction directory for static Podman archive (default: `~/.local/podman-static`). |
| `--mode MODE` | Service supervisor mode: `systemd`, `quadlet`, or `launchd` (default: auto-detected). |
| `--admin-email EMAIL` | Initial administrator account email. |
| `--admin-password PWD` | Initial administrator account password. |
| `--admin-name NAME` | Initial administrator full name (default `Administrator`). |
| `--skip-admin` / `--no-admin` | Don't create an admin account during install. |
| `-y`, `--non-interactive` | Run unattended, using flags/defaults instead of prompting. |
| `-h`, `--help` | Show usage and exit. |

#### Using a static Podman binary (rootless / no root required)

On Linux workstations where Podman is missing, locked to an older unsupported version (< 3.4), or where you do not have root/sudo permissions to install system packages, you can point the installer directly to a standalone static Podman build (such as those provided by [podman-static](https://github.com/mgoltzsche/podman-static)):

```bash
# Point directly to an executable Podman binary:
./deploy/install.sh --podman /opt/podman-static/bin/podman

# Point to a static archive (.tar.gz):
./deploy/install.sh --podman ~/Downloads/podman-linux-amd64.tar.gz

# Use the bundled static Podman packaged inside an offline bundle:
./deploy/install.sh --use-bundled-podman
```

When a custom or static Podman is specified, the installer:
- Unpacks the archive into `~/.local/podman-static` (or `--podman-extract-dir`) and verifies executable permissions.
- Automatically selects `systemd` user service mode and customizes all service unit files (`resoflow-pod`, `resoflow-api`, `resoflow-worker`, `resoflow-postgres`, `resoflow-redis`, `resoflow-web`) to invoke this specific binary.
- Configures `Environment="PATH=...:/usr/local/bin:/usr/bin:/bin"` in the service units so Podman's helper binaries (`conmon`, `crun`, `netavark`, `fuse-overlayfs`) are properly resolved by systemd.
- Automatically sets up a user-level `podman.socket` and `podman.service` if not present on the host system, enabling Celery background workers to access `%t/podman/podman.sock` for ChemEx job execution.
- Records `PODMAN_BIN` in `~/.config/resoflow/resoflow.env` so `backup.sh` and `uninstall.sh` use the exact same Podman instance.

### What the installer does

1. **Pre-flight checks** — verifies `podman` is available (or resolves the static binary / bundled archive), initializes `podman machine` on macOS, and verifies `systemd` on Linux/WSL.
2. **Loads offline images**, if run from an offline bundle (an adjacent `images/` directory with image tarballs).
3. **Generates secrets** on first run: a Postgres password and the JWT `SECRET_KEY`, written to `~/.config/resoflow/resoflow.env` (`chmod 600`). Re-running the installer preserves those secrets — but it re-prompts from built-in defaults rather than your current settings, so see [Updating resoFlow](#updating-resoflow) before re-running it against a live install.
4. **Installs service definitions**:
   - **Linux / WSL 2**: Installs Podman 5.x Quadlets (`~/.config/containers/systemd/`) or customized systemd user units (`~/.config/systemd/user/`) invoking the resolved Podman binary.
   - **macOS**: Installs native `launchd` LaunchAgents in `~/Library/LaunchAgents/` (`org.resoflow.pod.plist`, `org.resoflow.backup.plist`).
5. **Enables the Podman socket, backup timers, and background persistence**.
6. **Starts the pod and verifies health** by polling the web interface on `http://127.0.0.1:<WEB_PORT>`.
7. **Bootstraps the administrator account**, if requested, inside the running API container.

### Verifying the installation

Open `http://127.0.0.1:<WEB_PORT>` (default `8080`) and log in with the administrator account you created during install. If you skipped that step — or the installer warned that it couldn't create one — create it now:

```bash
podman exec -it resoflow-api python create_superuser.py
```

The pod name is `resoflow` and the containers are `resoflow-api`, `resoflow-worker`, `resoflow-web`, `resoflow-postgres`, and `resoflow-redis` on every platform:

```bash
podman ps --filter pod=resoflow    # all five should be Up
```

### Managing the deployment

The installer puts a `resoflow` command on your PATH that wraps whichever supervisor it picked, so the same commands work on Linux, WSL and macOS:

```bash
resoflow status            # service + container state, and whether the UI answers
resoflow start
resoflow stop
resoflow restart           # runs daemon-reload first, so unit-file edits are picked up
resoflow logs              # follow api and worker
resoflow logs api          # or: worker | web | postgres | redis
resoflow url               # print the web address
resoflow browse-roots ...  # see Extra browsable directories above
```

Start and stop walk the services in dependency order — Postgres and Redis come up first and go down last, so the database outlives its clients. Services absent from a partial install are skipped rather than reported as errors.

Both `resoflow` and `resoflow-browse-roots` are symlinked into `~/.local/bin`, so **that directory needs to be on your `PATH`**. Most distributions add it automatically when it exists, but if `resoflow: command not found` comes back, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc
source ~/.bashrc
```

The installer checks this at the end and tells you if it's missing. Either way the real scripts live in `~/.local/share/resoflow/scripts/`, so `~/.local/share/resoflow/scripts/resoflow-ctl.sh status` always works.

The underlying commands remain available if you need finer control.

**Linux / Windows (WSL 2)** — everything hangs off the pod service; restarting it cascades to all five containers:

```bash
systemctl --user status resoflow-pod.service
systemctl --user restart resoflow-pod.service
systemctl --user stop resoflow-pod.service
systemctl --user daemon-reload                          # after any unit file change
journalctl --user -u resoflow-api -u resoflow-worker -f
systemctl --user list-timers resoflow-backup.timer      # nightly backup schedule
```

On Windows, run these inside WSL. The pod stops with the distro (`wsl --shutdown`) and starts again when it next boots.

**macOS** — use the service script the installer placed in `~/.local/share/resoflow/scripts/`:

```bash
~/.local/share/resoflow/scripts/resoflow-service.sh status
~/.local/share/resoflow/scripts/resoflow-service.sh restart
~/.local/share/resoflow/scripts/resoflow-service.sh stop
podman logs -f resoflow-api
launchctl list | grep org.resoflow
```

Note that `launchctl unload` on `org.resoflow.pod` does not stop the containers — the agent is a one-shot `start` invocation. Use `resoflow-service.sh stop`. Service logs live in `~/.local/share/resoflow/logs/`.

**If `podman ps` shows nothing while the services are plainly running**, your terminal is redirecting `XDG_DATA_HOME` — snap- and flatpak-packaged terminals and editors do this — so `podman` is reading a different image store than the services use. `resoflow status` reports the store path when this happens. Building or inspecting images from such a terminal will silently act on the wrong store; run those from a normal shell, or override `XDG_DATA_HOME=~/.local/share`.

### Extra browsable directories

The in-app file browser is confined to the data directory you chose at install time. Anything outside it is refused with a 403 — that boundary is what keeps one lab member's account from reading the rest of the host.

When spectra genuinely live elsewhere (an instrument drive, a NAS share), name those directories and resoFlow will allow them. Two things have to line up for that to work — a bind mount into the api and worker containers, and the backend's list of permitted roots — so this is managed by tooling rather than by editing files. Setting only one half fails *silently*: an unmounted path doesn't exist inside the container, so the backend drops it without an error.

At install time:

```bash
./deploy/install.sh --extra-browse-root /mnt/spectrometer
```

Afterwards, with the `resoflow-browse-roots` command the installer puts on your PATH:

```bash
resoflow-browse-roots list
resoflow-browse-roots add /mnt/spectrometer
resoflow-browse-roots add /srv/nas/nmr /media/backup     # several at once
resoflow-browse-roots remove /mnt/spectrometer
```

Give **host** paths, as your shell sees them. Each one is mounted at `/data/extra/<name>` inside the containers, `RESOFLOW_EXTRA_BROWSE_ROOTS` is regenerated to match, and `resoflow-api` and `resoflow-worker` are restarted so the change takes effect immediately. The worker gets the mount too — without it, a fit on a spectrum from that directory would fail with a missing file long after the pick appeared to succeed.

Directories inside the data directory are already browsable and are skipped. Paths containing whitespace are rejected, since they cannot be expressed in the container unit files. A directory that doesn't exist is reported rather than silently ignored.

If the command is not on your PATH, it also lives at `~/.local/share/resoflow/scripts/browse-roots.sh`.

### Updating resoFlow

There is no update script and no image registry: every resoFlow image is local (`localhost/...`) and the units are `Pull=never`. **Updating means rebuilding the images (or loading new ones) and restarting the pod.** Database migrations need no manual step — the API container runs `alembic upgrade head` on every start.

#### 1. Back up first

```bash
~/.local/share/resoflow/scripts/backup.sh          # any platform
systemctl --user start resoflow-backup.service     # Linux / WSL equivalent
```

This dumps **Postgres only**. Copy your project data directory separately — see [Backing up and restoring](#backing-up-and-restoring).

#### 2. Standard update (from source)

For a normal release that doesn't change service definitions or add configuration keys:

```bash
git pull
./containers/build.sh

# then restart, per platform:
systemctl --user restart resoflow-pod.service                    # Linux / WSL 2
~/.local/share/resoflow/scripts/resoflow-service.sh restart      # macOS
```

This works because `build.sh` re-points the `:latest` tags that the service units reference, and the restart recreates the containers from them.

#### 3. When unit files or configuration changed

If a release changes the Quadlet/systemd units, ports, or the environment template, re-run the installer — but do it **non-interactively, re-supplying your original settings**. An interactive re-run prompts from built-in defaults (`8080`, `~/.local/share/resoflow/projects`, localhost-only), not from your current configuration, so pressing Enter through it would move your install to a different port and an empty data directory. It would also reset the admin account password, since the bootstrap step upserts.

Read your current settings back first:

```bash
grep -E '^(WEB_PORT|API_PORT|RESOFLOW_HOST_DATA_ROOT)=' ~/.config/resoflow/resoflow.env
```

Then:

```bash
./deploy/install.sh -y \
  --port <WEB_PORT> \
  --data-dir <RESOFLOW_HOST_DATA_ROOT> \
  --skip-admin              # omit only if you intend to reset the admin password
                            # add --lan if the install was originally LAN-bound
```

Your `SECRET_KEY` and Postgres password are preserved (they're only generated when `resoflow.env` doesn't exist), so existing logins and the database keep working. Note that re-running the installer refreshes only `WEB_PORT`, `API_PORT`, `RESOFLOW_HOST_DATA_ROOT`, and `RESOFLOW_SELINUX_MOUNT` — **new** configuration keys introduced by a release are not back-filled, so after a major update compare your `~/.config/resoflow/resoflow.env` against the template block in `deploy/install.sh` and add anything missing by hand. Any manual edits you made to installed unit files are overwritten.

#### 4. Air-gapped update

On a connected machine, build a fresh bundle for the new version:

```bash
./containers/build.sh && ./deploy/bundle.sh
```

Copy it over, extract, and run the installer from inside the bundle with your existing settings:

```bash
tar -xzf resoflow-<version>-offline-bundle.tar.gz
cd resoflow-<version>-offline-bundle
./install.sh -y --port <WEB_PORT> --data-dir <RESOFLOW_HOST_DATA_ROOT> --skip-admin
```

The bundled `images/` directory is loaded automatically, replacing the `:latest` tags.

#### 5. Verify, then clean up

```bash
systemctl --user status resoflow-pod.service     # or resoflow-service.sh status on macOS
journalctl --user -u resoflow-api -n 50
```

Check the API logs specifically: if a migration fails, uvicorn never starts and the unit will restart in a loop. That log is where the reason appears.

Once you're satisfied the update is good, reclaim disk. `build.sh` tags every image with a git-describe version as well as `:latest`, so previous builds stay on disk under their old version tags:

```bash
podman image prune                    # dangling layers
podman images | grep resoflow         # then remove old version tags you no longer need
podman rmi localhost/resoflow-api:<old-version-tag>
```

### Backing up and restoring

The installer schedules a nightly Postgres dump at 02:00 (`resoflow-backup.timer` on Linux/WSL, `org.resoflow.backup` on macOS), writing to:

```
~/.local/share/resoflow/backups/resoflow_backup_<YYYYmmdd_HHMMSS>.sql.gz
```

Dumps older than **14 days are pruned automatically**, so copy anything you want to keep long-term elsewhere. Note that the backup covers **the database only** — projects, spectra, and ChemEx output trees live in your data directory and must be archived separately:

```bash
DATA_DIR=$(grep '^RESOFLOW_HOST_DATA_ROOT=' ~/.config/resoflow/resoflow.env | cut -d= -f2)
tar -czf "resoflow-projects-$(date +%F).tar.gz" -C "$DATA_DIR" .
```

To restore a database dump into a running deployment:

```bash
gunzip -c ~/.local/share/resoflow/backups/resoflow_backup_<timestamp>.sql.gz \
  | podman exec -i resoflow-postgres psql -U resoflow -d resoflow
```

> ⚠️ `./deploy/uninstall.sh --purge-data` deletes `~/.local/share/resoflow` entirely — **including the backups directory**. Never treat "purge and reinstall" as an upgrade path.

### Uninstalling

- **Linux / macOS**:
  ```bash
  ./deploy/uninstall.sh                # stops services, removes service definitions; data/config/volumes are kept
  ./deploy/uninstall.sh --purge-data    # also deletes database volumes, secrets, backups, and project data
  ```
- **Windows (PowerShell)**:
  ```powershell
  .\deploy\windows\uninstall.ps1
  .\deploy\windows\uninstall.ps1 -PurgeData
  ```

The Windows uninstaller delegates to `uninstall.sh` inside WSL and removes the Desktop shortcut. It does not remove container images, disable systemd in `/etc/wsl.conf`, or uninstall Podman.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error: 'podman' is not installed` | Install Podman — on Windows this means **inside the WSL distro**, not on Windows itself. On macOS, `brew install podman`. |
| `Error: Podman 4.0 or higher is required` | Ubuntu 22.04 ships 3.4. Use Ubuntu 24.04 or a backport. |
| `Error: 'systemctl' is not available` | systemd isn't enabled. On WSL, add `[boot]` / `systemd=true` to `/etc/wsl.conf`, then `wsl --shutdown` from Windows and reopen the distro. |
| `Warning: User '<user>' does not have a subuid mapping` | `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER" && podman system migrate` |
| `Error: Cannot start resoFlow without required container images` | Run `./containers/build.sh`, or install from an offline bundle whose `images/` directory contains the tarballs. |
| `Warning: Services started, but healthcheck timed out` | The web UI didn't answer within 35s. Check `podman logs -n 50 resoflow-api` — usually a database or migration failure. |
| `Warning: Could not create admin account automatically` | The installer prints the underlying error; create the account manually with `podman exec -it resoflow-api python create_superuser.py`. |
| macOS: nothing running after login | launchd's minimal PATH may not include Homebrew's `podman`. Check `~/.local/share/resoflow/logs/resoflow-service-err.log`. |
| Rebuilt images, but the app is unchanged | Restart the pod (`systemctl --user restart resoflow-pod.service`, or `resoflow-service.sh restart` on macOS) — containers keep running their original image until recreated. |

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
| `RESOFLOW_EXTRA_BROWSE_ROOTS` / `RESOFLOW_EXTRA_MOUNTS` | unset | Extra directories the file explorer may browse, beyond the project data root. **Managed for you** — set them with `--extra-browse-root` at install time or `resoflow-browse-roots` afterwards (see [Extra browsable directories](#extra-browsable-directories)) rather than by hand, since each root also needs a matching bind mount in the api and worker containers. Paths outside the data root and these extras are refused with a 403; with none set, the explorer is confined to the data root. |
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

Most frontend tests run over plain modules. Component tests that need a DOM opt
in per file with a `@vitest-environment jsdom` docblock (see
`src/components/FileBrowserModal.test.tsx`), which keeps the pure-logic suites
running without the jsdom startup cost.
