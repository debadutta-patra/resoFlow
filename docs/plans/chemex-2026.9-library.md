# resoFlow × ChemEx 2026.9.2: library integration plan

**Target branch:** `feat/chemex-2026.9-library` (cut from `main` at `c94146e`)
**ChemEx target:** `chemex==2026.9.2` (latest PyPI release, tagged 2026-09-23). Do **not** track ChemEx `main`: it already contains unreleased breaking changes (e.g. `2st_rs` removed in favour of `2st.rs`, and `run_fit` now uses `compile_method_plan`).
**Guiding rule:** a fit launched by resoFlow must produce the *same output tree and the same numbers* as `chemex fit` 2026.9.2 run on the same TOML inputs. resoFlow gains control and structure; ChemEx behaviour stays unchanged.

---

## 0. How to use this plan with an agent (Claude Code / Antigravity)

1. Put this file in the repo at `docs/plans/chemex-2026.9-library.md` and commit it as the first commit on the branch.
2. Run one **phase** per agent session. Start each session with:

   > Read `docs/plans/chemex-2026.9-library.md`. We are on branch `feat/chemex-2026.9-library`. Implement Phase N only. Follow the "Agent rules". Stop at any **STOP-AND-ASK** item. At the end, run the phase's acceptance gate and report results.

3. **Agent rules**
   - Never commit to `main`. Create the branch first: `git checkout main && git pull && git checkout -b feat/chemex-2026.9-library`.
   - One logical task = one commit, with conventional messages (`feat(chemex-api): …`, `fix(parser): …`, `test(parity): …`).
   - Read ChemEx source **at the tag** before you call or patch anything: `git clone https://github.com/gbouvignies/ChemEx /tmp/ChemEx && git -C /tmp/ChemEx checkout 2026.09.2`. Do not code against memory of older ChemEx APIs.
   - Do not touch ChemEx internals beyond the hook points listed in §3.5. Every private symbol used must be listed in `resoflow/chemex_api/compat.py` and verified at import time.
   - Use claude.MD to map the project.
   - Do not edit the frontend except where a task explicitly says so.
   - Keep `resoflow/` importable without `backend/app` (it runs inside the slim ChemEx container). `backend/resoflow` is a symlink to `../resoflow`; edit the real path.

---

## 1. Current state (what is in `main` today)

| Area | Where | What it does |
|---|---|---|
| Pin | `backend/pyproject.toml` (`chemex==2026.6.1`), `containers/Containerfile.chemex` (`uv pip install "chemex==2026.6.1"`) | Two independent pins that must move together |
| Command building | `_build_chemex_command` in `cest_tasks.py`, `_build_cpmg_chemex_command` in `cpmg_tasks.py`, `_build_exchange_chemex_command` in `exchange_tasks.py` | Three near-identical copies building `["fit", "-e", …, "-p", parameters.toml, "-m", method.toml, "-d", model]` + `-o` |
| Execution | `services/fitting/chemex_runner.py::run_chemex_job` | Rewrites argv paths, stages output in `<out>.tmp`, then either `podman run … resoflow-chemex` or `python -m resoflow.progress <argv>`; streams stdout to `chemex.log`; progress over an inherited pipe FD → `progress.json`; atomic promote on exit 0; cancellation via container stop |
| Progress | `resoflow/progress/{shim,targets,__main__}.py` | Monkeypatches `chemex.optimize.gridding.track`, `chemex.optimize.resampling.track`, `chemex.optimize.mcmc._RichEmceeProgressBar`, `chemex.optimize.minimizer.Reporter.print_line`, then calls `chemex.chemex.main()` with the CLI argv. `targets.verify()` runs at import time and **raises** if the targets are missing |
| Library use already present | `resoflow/preflight.py` (sharing map), `services/fitting/chemex_registry.py` (module schema introspection via `chemex.experiments.factories`) | Partial library use |
| Custom experiment | `containers/chemex_catalog/cpmg_15n_rc.py` | Copied into `site-packages/chemex/experiments/catalog/` at image build; uses `chemex.experiments.factories` |
| Version and provenance | `get_chemex_image_info()` runs `podman run <image> --version` | Regex-parses the version string |
| Method TOML | `services/fitting/method_emitter.py` | Emits **v1** method TOML (FIT/FIX/CONSTRAINTS/GRID/INCLUDE/STATISTICS, MCMC subtable with THIN/WALKERS/WORKERS/UPDATE_PARAMETERS) |
| Output parsing | `services/fitting/chemex_output/*`, `chemex_parser.py`, `statistics_parser.py`, `routers/analysis.py` (≈26 hard-coded path fallbacks), `reporting/uncertainty.py`, `zip_export.py` | Assumes the 2026.6 layout: `STEPn/All/…`, `STEPn/Groups/<grp>/…`, `Grid/Groups/*.out`, `lower_1sigma`/`stderr` fields, `lmfit_version` |
| Models list | `frontend/src/lib/methodConfig.ts` | Hard-coded model names (includes `2st_rs`) |
| Tests and fixtures | `backend/tests/fixtures/chemex_trees/*` | Produced by 2026.6.1 (contain `Groups/`) |
| Results tab reads | `GET /{uuid}/results` (`routers/analysis.py`) | **Re-parses the whole ChemEx tree and rewrites `results.json` on every visit.** `/chemex-results`, `/cest/profiles`, `/statistics/*` and `/steps/*/grid*` each parse their own files again |
| Report and plots | `_render_or_serve_pdf`, `reporting/tasks.py`, `export/plot_export.py` | `build_report_model()` parses the tree again for every PDF, HTML, JSON and plot-ZIP request. The PDF "cache" is `report.pdf` or `report_<palette>.pdf` keyed **only by palette**, so a changed `style`, changed excluded residues, or a re-run can serve a **stale PDF** |

---

## 2. What 2026.9.x breaks in resoFlow

Items marked ✅ were verified in ChemEx source at tag `2026.09.2`. The rest come from `CHANGELOG.md` entries 2026.09.0–2026.09.2 and must be confirmed while implementing.

| # | Change | Impact on resoFlow | Severity |
|---|---|---|---|
| B1 ✅ | `chemex.experiments.factories` removed; experiment types now register via `chemex.experiments.experiment_types.register_experiment_type(ExperimentType(name, config_type, create_profile_calculation, support))` and `registered_experiment_types()` | `chemex_registry.py` swallows the ImportError, so `CHEMEX_AVAILABLE=False` and the **module picker silently goes empty**. `cpmg_15n_rc.py` fails to import, so the plugin loader errors | **Blocker** |
| B2 ✅ | `optimize/gridding.py` and `optimize/minimizer.py` are gone; `mcmc._RichEmceeProgressBar` is gone. Progress now flows through `chemex.messages.MinimizationProgressReporter.observe(context, event)` and `McmcProgressReporter.observe(completed_steps)` | `resoflow/progress/targets.verify()` raises at import, so **every fit fails** | **Blocker** |
| B3 ✅ | `ParameterStore` aliases removed (`set_param_defaults`, etc.) | `preflight.py` has a `getattr` fallback, which works but should be cleaned up | Low |
| B4 | Output layout: no more `All/`, `Groups/`, `Grid/Groups/`; aggregate artifacts sit at the step root; `Grid/` holds factor TSVs, 1D/2D profile TSVs, PDFs and `summary.toml` instead of `grid.out` | Parser, routers, report and zip export all miss results | **Blocker** |
| B5 | Statistics renames: MC/BS/BSN `lower_1sigma/upper_1sigma/stderr` become `percentile_68_lower/percentile_68_upper/half_percentile_68_width`; MCMC uses `credible_interval_68_*` and `half_credible_interval_68_width` | Statistics tabs and report show blanks | High |
| B6 | lmfit removed; deterministic fits now write covariance-derived stderr into `Parameters/fitted.toml`, **not scaled by reduced χ²**; `lmfit_version` gone | Parser fields; provenance text ("Levenberg-Marquardt (leastsq)" in `reporting/provenance.py`) is now wrong; uncertainty numbers change by design | High |
| B7 | `run_info/` schema 2: `parameters_used.toml` (start), `restart.toml` (latest committed state, valid `-p` input), `run.toml`, `outcome.toml` (written last, success marker) | Opportunity: use `outcome.toml` as the authoritative success flag and `restart.toml` for "continue from this run" | Medium (opportunity) |
| B8 ✅ | Method format v1 is deprecated (prints a warning, frozen compatibility window); v2 (`FORMAT_VERSION = 2`, `ROLES`, `ROLES_FROM`, `[STEP.SEARCH.GRID] AXES`, `[STEP.STATISTICS.MC] REPLICATES/SEED`) is canonical. `MethodPlan.render()` emits v2. v2 MCMC has no THIN/WALKERS/WORKERS (rendered as `# V1_ONLY_*` comments); native MCMC rejects `UPDATE_PARAMETERS = true`. `FITMETHOD` is only `trf` | `method_emitter.py` must emit v2; several MCMC controls in the UI become meaningless | High |
| B9 | Model/parameter changes: bare `4st/5st/6st` now fit all complete-graph `KEX`; `3st_binding_cs/if` use `KEQ_*`/`KEX_*` instead of `KAB/KBA`/`KBC/KCB`; `.tc` uses `DW0_AX/DW1_AX` instead of `DWP/DWM`; oligomer `KON*` outputs removed; `KD_EFF` becomes `KD_APP`; new `3st_eyring_linear/fork`, `4st/5st/6st_linear/fork` | Model list, parser special cases (`KAB` handling in `chemex_output/parser.py`), stored parameter files | Medium |
| B10 | Finite default bounds for standard parameters; `S2 ∈ [0,1]` | Fits without explicit bounds are bounded now, so results can differ at the edges | Info |
| B11 ✅ | `scipy>=1.18,<1.19`, Python ≥ 3.13 | Backend lock must resolve scipy 1.18.x (backend says `scipy>=1.12`, which is fine) | Low |
| B12 ✅ | Native MCMC uses `multiprocessing.get_context("spawn").Pool(...)`; statistics use process workers; `run()` mutates `os.environ` for native-thread settings | **Cannot run fits inside a Celery prefork worker** (daemonic processes cannot have children; env mutation leaks between jobs). This drives the architecture in §3 | **Design constraint** |
| B13 | Ctrl-C/interrupt exits with **130**; new `--debug`; new `--workers N|auto`, `--native-threads N|auto` | `chemex_runner` treats only 137/143 as cancelled | Low |
| B14 ✅ | `run_fit` calls `invalidate_planned_outputs(plan, output)` before fitting | Fine with `.tmp` staging; do not pre-create result folders in the staging directory | Info |

---

## 3. Target architecture

### 3.1 The key decision: library first, process isolated

"Library, not CLI" means **no argv construction, no `chemex.chemex.main()`, no stdout scraping for results**. resoFlow builds a typed job spec and calls ChemEx Python functions directly.

It does **not** mean running ChemEx inside the Celery or FastAPI process. B12 makes that unsafe: MCMC and statistics spawn process pools (illegal under Celery's daemonic prefork children), ChemEx mutates `os.environ`, holds global plugin and console state, and a long fit cannot be cancelled cleanly in-thread. So:

The fit **always runs in its own process**, never inside Celery or FastAPI, and it must be able to run on another machine (an HPC node) later. §3.10 lists the rules that keep that possible.

```
Celery task (cest/cpmg/exchange)
   │  builds FitJobSpec (pydantic) ──► writes a self-contained job directory (job.json + inputs)
   ▼
Launcher (Local | Podman today; Slurm/PBS + Apptainer later)  ← submit / poll / cancel / collect
   ▼
python -m resoflow.engine run job.json                  ← new entry point (replaces resoflow.progress)
   ▼
resoflow.chemex_api.run_fit(spec, observer)             ← library calls, mirrors chemex.chemex.run()
   ▼
chemex: AnalysisSession → build_experiments → read_defaults → read_method_plan → chemex.chemex.run_fit
   ▼
Output tree identical to `chemex fit`  +  engine_result.json  +  progress.jsonl (same event JSON contract)
```

The only interface between resoFlow and a running fit is **files in the job directory**: `job.json` in; `progress.jsonl`, `heartbeat`, `engine.log`, the output tree and `engine_result.json` out. No pipes, no shared memory, no DB access from the engine. This one rule lets the same engine run locally, in Podman, or on a cluster node.

Short, side-effect-free calls run **in-process in the API/worker**: module registry, model list, parameter inspection, sharing map, method/parameter validation (dry build without fitting). These are the "easier control of parameters" wins in the UI.

### 3.2 Fidelity contract (the "as similar as possible" guarantee)

`resoflow.chemex_api.run_fit` must reproduce `chemex.chemex.run()` (tag 2026.09.2) step for step and **delegate the fit itself to `chemex.chemex.run_fit`**, which owns run_info, output invalidation, method-plan execution and the outcome marker. Do not reimplement `execute_method_plan`.

Mirror these steps in this order (copy the structure from `src/chemex/chemex.py::run` at the tag):

1. `ensure_plugins_registered()` → then `resoflow.chemex_api.plugins.ensure_registered()` (resoFlow plugins).
2. `session = AnalysisSession.create()`
3. `session.execution = ExecutionSettings.from_counts(workers=…, native_threads=…)`; `os.environ.update(session.execution.native_thread_env())` (safe because we are in a dedicated process).
4. `input_files = capture_input_files(args_ns)`.
5. `session.set_model(spec.model)`.
6. `experiments = build_experiments(spec.experiment_files, Selection(include, exclude), session=session)`; empty → raise `NoDataError` (ChemEx calls `sys.exit()`; we must not).
7. `plan = read_method_plan(spec.method_files)` (or the default single-step plan, as in `_read_fit_methods`).
8. `session.parameters.set_defaults(read_defaults(spec.parameter_files))`.
9. `session.try_build_analysis_values()` with the same error translation as ChemEx (`ParameterConfigurationError` etc.).
10. `chemex.chemex.run_fit(args_ns, experiments, session, input_files=input_files, argv=equivalent_argv, methods=plan)`.

`args_ns` is an `argparse.Namespace` built by `chemex.cli.build_parser().parse_args(equivalent_argv[1:])`. Using ChemEx's own parser guarantees every attribute `run_fit`/`write_run_info` reads is present with ChemEx's defaults. `equivalent_argv` is the exact `chemex fit …` command that would reproduce the run. It is recorded in `run_info/run.toml`, so any resoFlow run can be replayed with the plain CLI. This is the provenance story.

### 3.3 Parameter control

- **Source of truth stays on disk as TOML artifacts** (`Parameters/parameters.toml`, `Methods/method.toml`), so runs remain reproducible with the CLI and `run_info/inputs/` keeps copies.
- **Overrides:** a new `ParameterOverride(selector, value, min=None, max=None)` list in the spec is rendered to `Parameters/overrides.toml` and passed as a **second** `-p` file. ChemEx deep-merges parameter files in order (`chemex.toml.read_toml_multi`: later file wins), so overrides apply exactly as a user would apply them manually. Add a test that proves precedence.
- **Continue from a previous run:** pass `<previous>/run_info/restart.toml` as the first parameter file (ChemEx documents it as a valid `-p` input). This replaces ad-hoc "inherit CS_A/DW_AB" copying where possible.
- **Inspection API (in-process):** `inspect_parameters(spec) -> list[ParamRow]` builds the session up to step 9 and returns every parameter with id, selector, value, bounds, vary or fix, constraint expression, and which experiments use it. Generalise `resoflow/preflight.py::build_sharing_map` into this function.
- **Validation API (in-process):** `validate_inputs(spec) -> ValidationReport` runs steps 1–9 plus `plan.validate(parameter_model)` and returns structured errors (bad selectors, unknown parameters, migrated names from B9) **before** a job is queued.

### 3.4 Method control (v2)

- `method_emitter.py` keeps its input model (`MethodConfigModel`) so the UI contract is unchanged, but emits **v2**. Preferred implementation: build `chemex.configuration.method_plan.MethodPlan`/`StepPlan` objects and call `.render()`, so ChemEx itself guarantees the syntax. Fallback: hand-write v2 following `examples/Experiments/CPMG_15N_IP/Methods/method_grid.toml` and `method_stat.toml` at the tag.
- Mapping: `FIT`/`FIX`/`CONSTRAINTS` become ordered `ROLES = [{FIT=[…]}, {FIX=[…]}, {CONSTRAIN=[…]}]`. `GRID` becomes `[STEP.SEARCH.GRID] AXES = […]`. `INCLUDE`/`EXCLUDE` are unchanged. `STATISTICS = {MC=n}` becomes `[STEP.STATISTICS.MC] REPLICATES=n` (+ optional `SEED`). The MCMC subtable becomes `[STEP.STATISTICS.MCMC] STEPS/BURN/SEED`.
- **Role inheritance differs between v1 and v2.** v2 uses explicit `ROLES_FROM`. Emit `ROLES_FROM = "<previous step>"` for every step after the first to preserve today's v1 sequential-inheritance semantics. Verify with a parity test (§5) that v1 and v2 produce identical fits for every shipped preset.
- `parse_method_toml` must read **both** v1 (historic runs in the DB) and v2. Use `chemex.configuration.methods.read_method_plan` on a temp file to parse either format, then convert the `MethodPlan` into `MethodConfigModel`.
- `raw_override` stays: pass through verbatim, but run `validate_inputs` on it.
- **STOP-AND-ASK:** MCMC `THIN`, `WALKERS`, `WORKERS`, `UPDATE_PARAMETERS` have no v2 or native equivalent. Proposed default: hide them in the Methods panel when ChemEx ≥ 2026.9, keep them readable for old runs, and map global workers to `ExecutionSettings` (see §3.6).

### 3.5 Progress (same event contract, new hooks)

Keep the existing event JSON exactly (`{"kind": "fit", "iteration", "chisqr", "redchi"}`, `{"kind": "grid"|"resample"|"mcmc", "done", "total"}`) so `progress.json` and the frontend need no changes.

**Transport changes from an inherited pipe FD to a file.** A pipe cannot cross machines; a file in the job directory works locally, through a Podman bind mount, and on a cluster's shared filesystem.

- The engine appends one JSON object per line to `<job_dir>/progress.jsonl`, adding `"t": <unix time>` and a monotonically increasing `"seq"`. It flushes after each line and throttles to at most about 4 lines per second per kind, always writing the first and final event.
- The engine rewrites `<job_dir>/heartbeat` (a timestamp) every 15 s from a daemon thread. resoFlow treats a job whose heartbeat is older than `RESOFLOW_ENGINE_STALE_SECONDS` (default 120) as lost.
- The runner tails `progress.jsonl` from the last `seq` it saw. It then feeds the **existing** `_dispatch_progress_event` (`progress.json` throttling and log milestones are unchanged).
- Drop `RESOFLOW_PROGRESS_FD` and the `os.pipe()` and `pass_fds` code.

New `resoflow/chemex_api/progress.py`:

- **Deterministic fit and GRID:** subclass `chemex.messages.MinimizationProgressReporter`, override `observe(context, event)` to emit, then call `super().observe(...)`. Install by rebinding the name **in the consumer module**: `chemex.optimize.native_deterministic.MinimizationProgressReporter = Wrapped` (it is imported by name there). Mapping:
  - `iteration = event.objective_evaluations_completed`, `chisqr = event.best_chi_square`, `redchi = event.reduced_chi_square`.
  - If `context.grid_seed_total` is set, also emit `{"kind": "grid", "done": context.grid_seed_ordinal, "total": context.grid_seed_total}`.
- **MCMC:** subclass `chemex.messages.McmcProgressReporter`, override `observe(completed_steps)` (emit `done=completed_steps`, `total=requested_steps`) and `start()`; rebind `chemex.optimize.mcmc.McmcProgressReporter`.
- **Resampling (MC/BS/BSN):** 2026.9.2 has no per-replicate observer. Emit stage start/finish by wrapping `chemex.optimize.resampling.run_native_resampling` (`total=None`, so the UI shows an indeterminate bar). **Do not** patch `native_resampling._execute_serial_replicates`; it would not cover the parallel path. Optional follow-up: open an upstream PR adding a `replicate_observer` to `execute_resampling_evidence`.
- `compat.py::verify_hooks()` checks that each symbol exists with the expected signature (`inspect.signature`) and raises `ChemExCompatError` with the installed version. Call it in `engine version`, at worker startup (log plus capability flag), and in a unit test. A ChemEx upgrade that moves these hooks then fails a test, not a production fit.
- Delete `resoflow/progress/` once `resoflow.engine` is wired in. Keep a thin `resoflow/progress/__main__.py` that forwards to the engine for one release only if any deployment still references it (search `deploy/`, `containers/`).
- Console output: the engine redirects its own stdout/stderr to `<job_dir>/engine.log` (line-buffered), so the log exists wherever the job runs. Set `TERM=dumb` and attach no TTY, so ChemEx uses its non-interactive line output (`console.is_terminal` is False). The runner tails `engine.log` into `chemex.log` exactly as it streams stdout today.

### 3.6 Execution settings

- Add `ExecutionSpec(workers: int | "auto" = "auto", native_threads: int | "auto" = "auto")` to the job spec. Default from env `RESOFLOW_CHEMEX_WORKERS` and `RESOFLOW_CHEMEX_NATIVE_THREADS`. In container mode, clamp workers to `--cpus` when a limit is set.
- `Containerfile.chemex` currently forces `OMP_NUM_THREADS=1` and similar. Keep that as the container default. Let `ExecutionSettings.native_thread_env()` override inside the engine process so behaviour matches the CLI.

### 3.7 Structured results

The engine writes `engine_result.json` atomically into the output directory:

```json
{
  "schema": 1,
  "status": "complete|incomplete|failed|cancelled",
  "exit_code": 0,
  "chemex_version": "2026.9.2",
  "resoflow_engine_version": "…",
  "equivalent_argv": ["chemex", "fit", "…"],
  "outcome_toml": "run_info/outcome.toml",
  "restart_toml": "run_info/restart.toml",
  "final_values": {"<param_id>": 1.23},
  "steps": [{"name": "STEP1", "output_dir": "STEP1"}],
  "warnings": ["…"],
  "error": {"type": "…", "message": "…", "stage": "deterministic_fit"}
}
```

`final_values` comes from `session.analysis_values.snapshot()` after `run_fit`. The file parser remains the primary source for UI tables (it carries stderr and statistics). `engine_result.json` is the authoritative status and replaces exit-code guessing.

### 3.8 Plugins (custom experiments)

- Move `containers/chemex_catalog/cpmg_15n_rc.py` to `resoflow/chemex_plugins/cpmg_15n_rc.py`. Port it to the `experiment_types` API by following `chemex/experiments/catalog/cpmg_15n_ip.py` at the tag (`cpmg_type(name=…, config_type=…)(create_profile_calculation)` + `register()` → `register_experiment_type`). Keep `EXPERIMENT_NAME = "cpmg_15n_rc"` unchanged so existing experiment TOMLs keep working.
- `resoflow/chemex_api/plugins.py::ensure_registered()` is idempotent and registers every module in `resoflow.chemex_plugins`. Call it after `ensure_plugins_registered()` in the engine **and** in the API (registry) process.
- Delete the `COPY containers/chemex_catalog/ …/site-packages/…` line from `Containerfile.chemex`. No more writing into site-packages.
- **STOP-AND-ASK** if the port changes any numeric output versus the 2026.6.1 baseline beyond 1e-8 relative. That could be a physics regression, not a refactor.

### 3.9 Version, provenance, capabilities

- `python -m resoflow.engine version` prints JSON `{chemex_version, engine_version, plugins: [...], hooks_ok: bool}`. `get_chemex_image_info()` calls this (container: `podman run --rm <image> version`; local: subprocess) and parses JSON instead of a regex.
- `reporting/provenance.py`: replace the hard-coded "Levenberg-Marquardt (leastsq)" with "SciPy TRF (ChemEx native)" for ≥ 2026.9; read the method and statistics actually used from `run_info/run.toml`. Keep the old text for old runs (dispatch on the recorded ChemEx version).
- `/api/capabilities` gains `chemex: {version, hooks_ok, models: [...], method_format: 2}`.
- New in-process endpoint `GET /api/chemex/models` returns registered kinetic model names from ChemEx's model registry (find the accessor at the tag under `chemex/models/`). `frontend/src/lib/methodConfig.ts` uses it with the current list as offline fallback. Add a small alias map `{"2st.rs": "2st_rs"}` in `compat.py` so the forthcoming upstream rename is a one-line change.

### 3.10 Separate-process execution and HPC readiness

Build the seams now and implement only Local and Podman. A Slurm/PBS backend should later be a new file, not a refactor.

**Self-contained job directory.** Everything the engine needs sits under one directory, and every path in `job.json` is relative to it:

```
<job_dir>/
  job.json                 # FitJobSpec, schema-versioned ("schema": 1)
  Experiments/*.toml  Data/…  Parameters/*.toml  Methods/method.toml
  output.tmp/              # staging; promoted to output/ by the launcher on success
  progress.jsonl  heartbeat  engine.log  engine_result.json
```

- No absolute host paths, no `RESOFLOW_HOST_DATA_ROOT` translation inside the engine. Path translation stays in the launcher.
- `job.json` records `engine_version`, `chemex_version` (required) and an optional `image` reference. The engine **refuses to run** (exit 2, clear error) if the installed ChemEx differs, so a mis-provisioned cluster node can never silently produce different numbers.
- The engine never touches the database, Redis or the network. The launcher owns all DB status updates, from the files above.

**Launcher interface** (`backend/app/services/fitting/launchers/`):

```python
class Launcher(Protocol):
    name: str
    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle: ...
    def poll(self, handle: JobHandle) -> JobState      # PENDING | RUNNING | DONE | FAILED | CANCELLED | LOST
    def cancel(self, handle: JobHandle) -> None: ...
    def collect(self, handle: JobHandle) -> Path       # local path of the finished job_dir (no-op on shared FS)

@dataclass
class Resources:
    cpus: int | None = None; memory: str | None = None; walltime_s: int | None = None
    partition: str | None = None; account: str | None = None   # ignored by Local/Podman
```

- `JobHandle` is JSON-serialisable (`{"launcher": "podman", "id": "rf-chemex-<uuid>", "job_dir": "…"}`) and stored on the `Analysis` row (new nullable `launcher_handle` JSON column, Alembic migration). Cancellation and status therefore work after a worker restart, and later for queued HPC jobs that outlive any Celery task.
- `LocalLauncher`: subprocess with `start_new_session=True`; cancel = SIGTERM then SIGKILL to the process group.
- `PodmanLauncher`: today's container logic moves here unchanged (naming, SELinux `:z`, `--userns=keep-id`, socket API with CLI fallback, orphan reaping). The bind mount is the job dir → `/work`.
- **Not now, but the design must allow:** `SlurmLauncher` (`sbatch` a generated script running `apptainer exec resoflow-chemex.sif python -m resoflow.engine run job.json`; poll with `squeue`/`sacct`; cancel with `scancel`; `collect` = no-op on shared FS or rsync back). Add a stub file with `NotImplementedError` and a docstring describing exactly this, so the seam is visible.
- Selection: `RESOFLOW_LAUNCHER=local|podman` (default keeps today's behaviour: podman if `RESOFLOW_USE_CONTAINER`/`RESOFLOW_SELINUX_MOUNT` is set, else local).

**Celery task shape.** The task does `submit` → poll loop (every 1 s locally; later the Slurm launcher can poll every 30 s) → `collect` → parse. Status comes **only** from files and `poll()`:

- `DONE` requires `engine_result.json.status == "complete"` and `run_info/outcome.toml` = complete.
- `LOST` = heartbeat stale and the launcher reports no live job.

Keep the poll loop in a single function, `wait_for_job(launcher, handle, on_progress)`. Later it can become a Celery beat/periodic poller for long HPC queues without touching the tasks.

**Engine packaging.** `resoflow/` (engine + `chemex_api` + `chemex_plugins`) must stay importable and runnable with only `chemex==2026.9.2` and the standard library, with no `backend/app` imports. Add a test that imports `resoflow.engine` in a venv containing only `chemex`. This is what lets you build an Apptainer image or `pip install` it on a cluster later.

**Determinism across machines.** Fits with statistics or MCMC must carry explicit seeds in the method (v2 `SEED`). When the user leaves a seed empty, the emitter fills in a generated seed and records it, so a rerun on another node reproduces the run.

### 3.11 Results bundle and prebuilt artifacts

Parse once, serve many times. The ChemEx output tree stays untouched as the raw scientific record. resoFlow derives a **results bundle** from it once per finished run and serves every results, statistics, grid and report request from that bundle.

**Location and contents.** The bundle lives in the run directory, next to the ChemEx output. It therefore moves with project export/import, is deleted together with the run, and needs no database migration for its contents.

```
<run_dir>/results/
  manifest.json      # bundle_schema, parser_version, chemex_version, source fingerprint, status, artifact index (path, sha256, render_key)
  summary.json       # small, eager: run status, fit statistics (χ², red-χ², AIC/BIC, n points), global/kinetic params ± err,
                     #   per-residue parameter table, warnings, uncertainty_kind, step list. Target < 200 kB.
  results.sqlite     # lazy, queryable (stdlib sqlite3, WAL off, written once then read-only)
  report_model.json  # serialized ReportModel (what build_report_model() returns today)
  artifacts/
    report-<render_key>.pdf
    plots-<render_key>.zip
```

`results.sqlite` tables (one row per item; units in column names):

- `parameters(step, param_id, name, residue, spin, value, err, err_kind, vary, expr, min, max)`
- `profiles(step, experiment, residue, x, y_obs, y_err, y_calc, excluded)`: CEST offsets, CPMG νCPMG, relaxation times
- `residuals(step, experiment, residue, x, residual, weighted_residual)`
- `stat_summary(step, method, param_id, center, lower_68, upper_68, half_width_68, mcse_mean, status)`
- `stat_correlations(step, method, param_a, param_b, r)`
- `grid_1d(step, param_id, value, chi2, delta_chi2)` and `grid_2d(step, param_x, param_y, x, y, chi2)`
- `sharing(param_id, experiment)`: from `inspect_parameters`

Raw MCMC chains and replicate arrays (`*.npz`, `samples.tsv`) are **not** copied. The manifest indexes their paths, and the histogram and joint-distribution endpoints keep reading them on demand, behind a small LRU cache.

**Why JSON + SQLite.** Both are standard library, single files, and work offline on a cluster or laptop. SQLite allows per-residue lazy queries, so a 300-residue CEST run never ships every profile to the browser. Parquet would need `pyarrow` and adds nothing here. Postgres would bloat the app DB and break project export/import. Only a handful of headline columns are copied to the `Analysis` row (`summary_redchi`, `summary_n_residues`, `bundle_status`) for dashboards.

**Producing the bundle.** A **post-process step** runs after `collect()` (§3.10), never inside the engine. The engine stays ChemEx-only, and the report needs WeasyPrint.

1. `ingest_results(run_dir)`: parse the tree once with the Phase 5 parsers, write `summary.json`, `results.sqlite` and `report_model.json` into `results.tmp/`, then atomically rename to `results/`. Mark the analysis `COMPLETED` only after this succeeds. If ingest fails, the run is `COMPLETED_WITH_ERRORS`, with raw files intact and the error shown. The fit is never lost because a parser broke.
2. `prebuild_artifacts(run_dir)` (Celery `stats` queue, chained after ingest): render the **default** PDF (`style=publication`, default palette, current excluded residues) and the default plots ZIP from `report_model.json`. Track progress in `manifest.artifacts[*].status` (`pending|ready|failed`). The Results tab opens as soon as ingest is done; the download button shows "Preparing…" until the artifact is ready.

**Cache key (fixes the stale-PDF bug).**

```
render_key = sha256(bundle_fingerprint, kind, style, palette, sorted(excluded_residues),
                    noe_threshold, REPORT_TEMPLATE_VERSION)[:16]
```

- A request whose key exists streams the file (`FileResponse`). A miss queues a render that is cached under its own key.
- `REPORT_TEMPLATE_VERSION` is a constant in `reporting/`; bump it whenever templates, CSS or plot styles change, and old artifacts simply stop matching.
- Keep at most 8 variants per run (LRU by mtime). Always keep the default.
- Changing excluded residues or palette in the UI therefore produces the right report, and re-running a fit produces a new bundle fingerprint.

**Serving.**

- `GET /results`, `/chemex-results`, `/cest/profiles`, `/cpmg/profiles`, `/statistics/summary`, `/steps/{step}/grid*` and `/report.json` read from the bundle. **Their response shapes stay identical**, so frontend changes are optional.
- Add `ETag: <bundle_fingerprint>` and honour `If-None-Match` (304), so revisiting the Results tab costs almost nothing.
- New, optional lazy endpoints for future UI use: `GET /results/summary` and `GET /results/residues/{residue}` (one residue's profiles, residuals and params from SQLite).
- Never re-parse on GET. If a bundle is missing or stale (`bundle_schema` or `parser_version` older than the code), return the raw-parse result once **and** enqueue `ingest_results`. This lazily migrates every historic run the first time someone opens it. An admin command `python -m app.cli rebuild-bundles [--all|--project X]` does the same in bulk.

**Fingerprint.** `bundle_fingerprint = sha256(parser_version, bundle_schema, sorted((relpath, size, mtime_ns) for files under the ChemEx output dir and run_info/))`. It is cheap to compute and changes on any re-run. The bundle is valid only while the fingerprint recomputed at read time (cached for 60 s in-process) matches the manifest.

---

## 4. Implementation phases

Each phase ends with an **acceptance gate**. Do not start the next phase until the gate passes.

### Phase 0: Branch, baseline and parity harness (no behaviour change)

1. Create the branch and commit this plan.
2. **Capture a 2026.6.1 baseline** for later comparison. In a throwaway venv with `chemex==2026.6.1` plus the current `cpmg_15n_rc.py`, run the CLI on:
   - ChemEx examples (from the 2026.06.1 tag): `CEST_15N`, `CPMG_15N_IP` (plain, `method_grid`, `method_stat`), one `DCEST_15N`.
   - One resoFlow-shaped CEST and one CPMG project exported from a dev instance (experiments + parameters + method as resoFlow writes them).
   - One `cpmg_15n_rc` dataset.
   Save under `backend/tests/fixtures/baselines/2026.6.1/<case>/` (inputs + outputs).
3. Write `backend/tests/parity/compare_trees.py`: compares two output trees. It checks the file set (ignoring `run_info/run.toml` timestamps, paths, argv), parses every `Parameters/*.toml`, `statistics.toml`, `Data/*.dat` and `Plots/*.fit`, and compares numerically with configurable `rtol`/`atol`.

**Gate:** baseline fixtures committed; `compare_trees.py` passes when comparing a tree with itself.

### Phase 1: Dependency bump and compatibility layer

1. `backend/pyproject.toml`: `chemex==2026.9.2`; `uv lock`; confirm scipy resolves to 1.18.x and that resoFlow's own lmfit-based relaxation code and `nmrglue` still import and pass tests under that scipy.
2. `containers/Containerfile.chemex`: `chemex==2026.9.2` (leave the catalog COPY for now; it is removed in Phase 3).
3. Create `resoflow/chemex_api/compat.py`:
   - `MIN_CHEMEX = MAX_CHEMEX = "2026.9.2"` (exact pin), `check_version()`.
   - `verify_hooks()` for every private symbol in §3.5.
   - `MODEL_ALIASES`.
4. Fix `resoflow/preflight.py` to call `store.set_defaults` directly (B3).
5. Port `chemex_registry.py` to `registered_experiment_types()`; read `config_type` from each `ExperimentType`. Replace the silent `except Exception` with logging plus `CHEMEX_AVAILABLE=False` **and** a `chemex.error` field in capabilities. Update `test_chemex_registry.py` to assert the registry is non-empty and contains `cest_15n`, `cpmg_15n_ip`, and (after Phase 3) `cpmg_15n_rc`.

**Gate:** `uv run pytest backend/tests -k "registry or preflight"` passes; `python -c "from resoflow.chemex_api.compat import verify_hooks; verify_hooks()"` passes against 2026.9.2.

### Phase 2: `resoflow.chemex_api` (library facade) and `resoflow.engine`

Create:

```
resoflow/chemex_api/
  __init__.py      # public: run_fit, run_simulation, validate_inputs, inspect_parameters, chemex_info
  spec.py          # FitJobSpec, ParameterOverride, ExecutionSpec, Selection (pydantic, JSON round-trip)
  session.py       # build_session(spec) → (session, experiments, plan, args_ns, input_files); steps 1–9 of §3.2
  fit.py           # run_fit(spec, observer) → EngineResult; step 10 + result extraction
  simulate.py      # run_simulation(spec) mirroring chemex.chemex.run_sim (needed later for previews)
  progress.py      # §3.5
  plugins.py       # §3.8
  results.py       # EngineResult model + atomic JSON writer
  errors.py        # NoDataError, ChemExCompatError, InputValidationError (with structured fields)
  compat.py        # (Phase 1)
resoflow/engine/__main__.py   # argparse: run <job.json> | validate <job.json> | version
```

Spec fields (minimum): `experiment_files`, `parameter_files` (ordered), `method_files` (optional), `model`, `include`, `exclude`, `output_dir`, `plot` (`nothing|normal|all`, default `normal`, matching the CLI default), `execution`, `overrides`.

Rules:

- All paths in `job.json` are **relative to the job dir** (§3.10). The engine `chdir`s into the job dir itself (`run job.json` resolves the job dir from the json's location), so it does not depend on the caller's cwd.
- The engine writes `progress.jsonl`, `heartbeat` and `engine.log` itself (§3.5) and refuses a ChemEx version mismatch with `job.json`.
- `engine run` exit codes: 0 complete, 2 input/validation error, 3 ChemEx known error (`ChemExError`), 130 interrupted, 1 unexpected. Always write `engine_result.json`, including on failure.
- Handle SIGTERM by raising `KeyboardInterrupt` in the main thread, so ChemEx writes its "incomplete" outcome and `engine_result.json` records `cancelled`. `scancel` and `podman stop` both send SIGTERM first.
- Install progress hooks before importing modules that rebind names, and only inside the engine process.

Tests (`backend/tests/chemex_api/`):

- `test_spec_roundtrip.py`.
- `test_equivalent_argv.py`: the argv parsed by `chemex.cli.build_parser()` yields a Namespace whose fields match what `run_fit` needs.
- `test_override_precedence.py`: an override in `overrides.toml` beats `parameters.toml`.
- `test_progress_hooks.py`: run a tiny fit, with the CPMG example restricted to 2 residues, and assert `progress.jsonl` contains ≥1 `fit` event, `grid` events for a GRID method, and `mcmc` events with `done == total` for a 20-step MCMC; `seq` is strictly increasing; `heartbeat` is updated.
- `test_engine_standalone.py`: in a fresh venv with **only** `chemex==2026.9.2` installed plus the `resoflow/` directory on `PYTHONPATH`, `python -m resoflow.engine version` and `run` on a tiny job succeed (no `backend/app` imports).
- `test_job_dir_relocatable.py`: build a job dir, **move it** to another path, run the engine there; outputs are identical.
- `test_version_guard.py`: `job.json` with a different `chemex_version` exits 2 without fitting.
- `test_sigterm.py`: SIGTERM mid-fit gives `engine_result.json.status == "cancelled"`, an incomplete `outcome.toml`, and exit 130.
- **`test_cli_parity.py` (the key test):** for each Phase 0 case, run `chemex fit` (subprocess, 2026.9.2) and `python -m resoflow.engine run`, then `compare_trees` with `rtol=1e-12` (deterministic TRF; statistics with fixed seeds). Mark slow cases `@pytest.mark.slow`.

**Gate:** all `chemex_api` tests pass, including CLI parity on every case. **This gate is the definition of "as similar as possible to ChemEx".**

### Phase 3: Plugin port

1. Move and port `cpmg_15n_rc.py` (§3.8); delete the site-packages COPY.
2. Run the `cpmg_15n_rc` case through the engine and compare against the **2026.6.1 baseline** with `rtol=1e-6` on `Data/*.dat` back-calculated profiles at **fixed input parameters**. Use `run_simulation`, not a fit, so solver changes (B6, B10) do not confound the physics check.

**Gate:** simulation parity for `cpmg_15n_rc` against the 2026.6.1 baseline; the module appears in the registry and module picker.

### Phase 4: Wire tasks to the engine

1. New `services/fitting/chemex_jobs.py::build_fit_spec(dirs, config) -> FitJobSpec`. It replaces the three `_build_*_chemex_command` functions (keep the existing ordering: sorted experiment TOMLs, `parameters.toml` only if non-empty, `method.toml` only if non-empty, model default `2st`). Delete the three copies.
2. Implement the launcher layer from §3.10: `launchers/base.py` (Protocol, `Resources`, `JobHandle`, `JobState`), `local.py`, `podman.py` (move the existing container code here unchanged in behaviour), and `slurm.py` (stub only). Add the `launcher_handle` column with an Alembic migration.
3. Rewrite `chemex_runner.run_chemex_job(job_id, job_dir, spec, …)` as a thin wrapper:
   - Write `job.json` with `output_dir = "output.tmp"`.
   - `launcher.submit` → `wait_for_job(launcher, handle, on_progress)`, which tails `progress.jsonl` and `engine.log` into the existing `_dispatch_progress_event`/`chemex.log`.
   - `collect` → promote `output.tmp` to the final output dir only on `DONE` (as defined in §3.10).
   - **No argv translation loop and no pipe FD.**
   - Treat 130, 137 and 143 as cancelled (B13); `cancel_chemex_job` reads `launcher_handle` from the DB and calls `launcher.cancel`.
4. `Containerfile.chemex`: `ENTRYPOINT ["python", "-m", "resoflow.engine"]`.
5. Update `cest_tasks.py`, `cpmg_tasks.py`, `exchange_tasks.py` and `get_chemex_image_info()` (§3.9). The tasks must now prepare inputs **inside** the job dir; check `_update_experiment_toml_exclusions` and the data-path handling so experiment TOMLs reference data by job-dir-relative paths.
6. Update `test_chemex_runner.py`: replace argv-translation tests with job-dir/launcher tests; keep the atomic promotion, cancellation, SELinux and podman3 socket tests (now under the Podman launcher). Add a fake launcher for unit tests of `wait_for_job` (stale heartbeat → `LOST`).

**Gate:** `pytest backend/tests` green; manual run in dev (`./dev.sh`) of one CEST, one CPMG and one Exchange analysis in **both** local and container modes; cancel a running MCMC and confirm no orphan Python processes (`ps -ef | grep resoflow.engine`).

### Phase 5: Output parser for the 2026.9 layout (backward compatible)

1. Add `chemex_output/layout.py::detect_layout(run_dir) -> "v2026_6" | "v2026_9"`. Use `run_info/outcome.toml` presence plus the version in `run_info/run.toml`; fall back to probing for `All/` or `Groups/`.
2. Add `chemex_output/locate.py` with one function per artifact (`fitted_params(step)`, `data_files(step)`, `statistics_dir(step, kind)`, `grid_dir(step)`, …) returning paths for either layout. **Replace every hard-coded path fallback** in `routers/analysis.py`, `reporting/uncertainty.py`, `export/zip_export.py`, `statistics_engine.py`, `sdm_sources.py` and `relaxation_*` with `locate` calls.
3. Statistics: normalise new field names into the existing `chemex_output/models.py` fields so API JSON stays unchanged:
   - `stderr ← half_percentile_68_width`, `lower ← percentile_68_lower`, `upper ← percentile_68_upper`.
   - MCMC: `credible_interval_68_*`.
   - Add an explicit `uncertainty_kind` field (`covariance`, `mc`, `bs`, `bsn`, `mcmc`) so the UI can label numbers honestly.
4. Grid: new `grid_parser_v2.py` for `Grid/summary.toml`, 1D/2D profile TSVs and factor TSVs, producing the same models `GridSearchSection.tsx` consumes. Keep `grid.out` parsing for old runs.
5. Parser special cases from B9: `KAB`/`KBA` derivation in `chemex_output/parser.py` must not break for models where ChemEx now reports `KEQ_*`/`KEX_*`; `KD_EFF` maps to `KD_APP`.
6. Fixtures: regenerate `fixtures/chemex_trees/*` with 2026.9.2 into `fixtures/chemex_trees_2026_9/`; **keep** the old trees and run every parser test against both.

**Gate:** parser tests pass on old and new fixtures. The API JSON for a new run matches the JSON schema of an old run (snapshot test of keys). Results, statistics, grid and report pages render for a fresh 2026.9 run and for an existing 2026.6 run in the dev DB.

### Phase 6: Results bundle and prebuilt report/plots (§3.11)

1. `services/results_bundle/`: `schema.py` (bundle_schema, SQLite DDL, `summary.json` pydantic model), `ingest.py` (`ingest_results(run_dir)`; atomic `results.tmp/` → `results/`), `fingerprint.py`, `store.py` (read API: `get_summary`, `get_residue`, `query_profiles`, `get_report_model`, …).
2. Refactor `build_report_model()` so it can be built from the parsed tree **once** and serialised to `report_model.json`. Make `ReportBuilder`, `export_all_plots_zip` and the HTML/JSON report endpoints accept a loaded `ReportModel` instead of a directory.
3. `services/results_bundle/artifacts.py`: `render_key()`, `get_or_queue(kind, options)`, LRU eviction, and the `REPORT_TEMPLATE_VERSION` constant. Replace `_render_or_serve_pdf`, `_trigger_pdf_async` and the plot-ZIP paths with it; delete the palette-only `report.pdf`/`report_<palette>.pdf` logic (old files are ignored, not deleted, for one release).
4. Celery chain in `cest_tasks.py`, `cpmg_tasks.py` and `exchange_tasks.py` after `collect`: `ingest_results.si(...) | prebuild_artifacts.si(...)`. Add the `bundle_status`, `summary_redchi` and `summary_n_residues` columns (Alembic) and the `COMPLETED_WITH_ERRORS` status. *(Frontend touch: treat `COMPLETED_WITH_ERRORS` like `COMPLETED` plus a warning banner.)*
5. Switch the read endpoints listed in §3.11 to the bundle store, with ETag/304 and the lazy-migration fallback. Remove the "rewrite `results.json` on GET" code. Keep writing `results.json` for one release as a compatibility copy of `summary.json`'s fields if anything else reads it (grep first).
6. Admin command `rebuild-bundles`.
7. Tests:
   - `test_bundle_equivalence.py`: for every fixture tree (2026.6 and 2026.9), endpoint JSON from the bundle **equals** endpoint JSON from the raw parser (deep equality after float sanitising). This is the key test.
   - `test_render_key.py`: changing style, palette, excluded residues, template version or the source tree changes the key; identical inputs give an identical key.
   - `test_ingest_atomic.py`: a crash mid-ingest leaves no `results/` directory and the raw tree untouched.
   - `test_lazy_migration.py`: a run without a bundle is served correctly and gets a bundle queued.
   - `test_no_reparse_on_get.py`: patch the parser to raise; `GET /results` on a bundled run still succeeds.
   - A timing smoke test on the largest fixture: bundled `GET /results` is at least 10× faster than raw parse (log the numbers rather than asserting hard wall-clock limits in CI).

**Gate:** all tests green. In dev, a fresh CEST run opens its Results tab from the bundle (no parser call in logs), the default PDF downloads instantly after "Preparing…" clears, and changing excluded residues produces a different (correct) PDF. An old 2026.6 run is migrated on first open.

### Phase 7: Method v2, validation and parameter-control features

1. `method_emitter.py` emits v2 via `MethodPlan.render()` (§3.4); `parse_method_toml` reads v1 and v2.
2. Parity test: for each built-in Methods preset, v1 emission and v2 emission produce identical fits under 2026.9.2.
3. `POST /api/projects/{project_uuid}/analysis/{analysis_uuid}/chemex/validate` (in-process `validate_inputs`) is called by the frontend before queuing a run. Errors are shown inline in the Parameters and Methods panels. *(Frontend touch: show the returned error list; no layout redesign.)*
4. `POST /api/projects/{project_uuid}/analysis/{analysis_uuid}/chemex/parameters/inspect` (in-process `inspect_parameters`) feeds the Parameters panel: fit/fix/constrained status per parameter, shared-across-experiments flags, and the `CONDITION_MISMATCH`/`NEAR_FIELD`/`ISOLATED` warnings from the preflight sharing map.
5. "Continue from run" action: creates a new run whose first parameter file is `<source>/run_info/restart.toml`.
6. **STOP-AND-ASK:** apply the MCMC UI change from §3.4.

**Gate:** method tests and parity pass; UI validation shows a readable error for a deliberately wrong selector and for a legacy `.tc` name (`DWP_AB`).

### Phase 8: Cleanup, docs, release

1. Delete `resoflow/progress/` (or reduce it to a deprecated forwarder), `containers/chemex_catalog/`, the dead argv code and the stale `chemex.pid` handling if unused.
2. Update `backend/README.md` and the deploy docs: new engine entry point, `RESOFLOW_CHEMEX_WORKERS`/`NATIVE_THREADS`, the pinned ChemEx version, and "how to bump ChemEx" (rerun `verify_hooks`, regenerate fixtures, run CLI parity).
3. A user-facing **changelog note**: why numbers can change versus older resoFlow runs (B6 uncertainties no longer χ²-scaled, B10 default bounds, B9 model reparameterisations, statistics label renames). Old runs still display as before.
4. `containers/build.sh`: build and tag `resoflow-chemex` with the ChemEx version label (`io.resoflow.chemex_version=2026.9.2`).
5. Open the PR `feat/chemex-2026.9-library → main` with the gate results pasted in.

**Gate:** clean `pytest`, frontend `npm test`, container build, and one end-to-end run per analysis type on the built images.

---

## 5. Test matrix (summary)

| Test | Purpose | Tolerance |
|---|---|---|
| CLI parity (`test_cli_parity.py`) | resoFlow engine ≡ `chemex fit` 2026.9.2 | rtol 1e-12; file set identical except run_info metadata |
| Plugin physics parity | `cpmg_15n_rc` simulate ≡ 2026.6.1 | rtol 1e-6 |
| v1 vs v2 method parity | Emitter change does not change fits | rtol 1e-12 |
| Override precedence | Second `-p` file wins | exact |
| Progress hooks | Events for fit, grid and mcmc; resample start/finish | presence and monotonic `done` |
| Hook verification | ChemEx upgrade breaks a test, not production | n/a |
| Dual-layout parsers | Old runs still render | snapshot of API keys |
| Cancellation | No orphan pool workers after cancel | process count |
| Engine standalone | Runs with only `chemex` installed (HPC/Apptainer-ready) | n/a |
| Relocatable job dir | Moving the job dir does not change outputs | rtol 1e-12 |
| Version guard | Wrong ChemEx on a node refuses to run | exit 2 |
| SIGTERM | Clean `cancelled` result (scancel/podman stop) | exit 130 |
| Bundle equivalence | Bundle-served JSON ≡ raw-parse JSON, old and new layouts | deep equality |
| Render key | Correct report for every style/palette/exclusion; no stale PDFs | exact |
| No re-parse on GET | Results tab never touches the parser for bundled runs | n/a |

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Private hooks (`MinimizationProgressReporter`, `McmcProgressReporter`, `run_native_resampling`) move in the next ChemEx release | Exact pin, `verify_hooks()` test, progress degrades gracefully (fit still runs, events missing) instead of crashing. Upstream PR for a public observer API |
| Users see changed uncertainties and fit values after the upgrade | Changelog note, `uncertainty_kind` labels, ChemEx version shown on each run, old runs untouched |
| v1 → v2 inheritance semantics differ subtly | Explicit `ROLES_FROM` chain plus the v1/v2 parity test on every preset |
| Celery worker environment differs from the engine's | Engine is always a separate process (local or container); never import fitting code paths into the Celery process |
| Historic parameter files using renamed parameters (`DWP_*`, `KAB` for binding models) | `validate_inputs` reports a migration message (ChemEx already emits guidance); no silent auto-rewrite |
| Future HPC: no shared filesystem, slow queues, nodes without Podman | File-only interface, relocatable job dir, `collect()` hook for rsync, handle persisted in DB, engine runnable under Apptainer with only `chemex` installed |
| Bundle drifts from raw files after a parser fix | `parser_version` in fingerprint; stale bundles are rebuilt lazily or with `rebuild-bundles` |
| Prebuilt artifacts pile up on disk | Max 8 variants per run, LRU; artifacts are reproducible and safe to delete |
| ChemEx `main` drifts (e.g. `2st_rs` removal, `compile_method_plan`) | Pin to the tag; `MODEL_ALIASES`; next bump is a separate branch using §7 |

---

## 7. Future ChemEx bumps (checklist to keep)

1. Read `CHANGELOG.md` between versions; list breaking items in a table like §2.
2. Bump both pins (`backend/pyproject.toml`, `Containerfile.chemex`) and `compat.py`.
3. `verify_hooks()`; update `progress.py` if hooks moved.
4. Diff `src/chemex/chemex.py::run`/`run_fit` against `chemex_api/session.py`/`fit.py` and mirror any new step.
5. Regenerate fixtures; run CLI parity; run plugin physics parity.
