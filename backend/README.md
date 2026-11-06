# resoFlow Backend

FastAPI, Celery, and scientific analysis application for the resoFlow NMR relaxation data analysis platform.

## ChemEx Integration (2026.9.2)

resoFlow integrates with ChemEx 2026.9.2 using an isolated library execution engine rather than CLI stdout-scraping.

### Architecture Overview

- **Engine Entrypoint:** `python -m resoflow.engine run <job.json>`
- **Core Library API:** `resoflow.chemex_api.fit.run_fit` reproduces `chemex.chemex.run()` step-for-step using the fidelity contract, delegating directly to `chemex.chemex.run_fit`.
- **Fidelity Guarantee:** `backend/tests/chemex_api/test_cli_parity.py` asserts numerical parity within `rtol=1e-12` against native `chemex fit`.
- **Process Isolation:** Fits always execute in dedicated processes (either via `PodmanLauncher` or `LocalLauncher`), never inside Celery or FastAPI worker processes.
- **Job Directory Interface:** Execution communicates purely through files (`job.json`, `progress.jsonl`, `heartbeat`, `engine.log`, `engine_result.json`).

### Configuration & Concurrency

Configure engine concurrency using environment variables:
- `RESOFLOW_CHEMEX_WORKERS`: Process worker count for statistics and MCMC (`auto` or integer, default: `auto`).
- `RESOFLOW_CHEMEX_NATIVE_THREADS`: Thread count for OpenMP/BLAS native operations (`auto` or integer, default: `auto`).
- `RESOFLOW_LAUNCHER`: Launcher backend (`podman` or `local`).

### Subcommands

```bash
# Display ChemEx and engine versions, registered plugins, and hook compatibility
python -m resoflow.engine version

# Dry-run validation of job.json without starting a fit
python -m resoflow.engine validate job.json

# Execute a fit from job.json
python -m resoflow.engine run job.json
```

### ChemEx Upgrade Procedure

When upgrading ChemEx to a future release:
1. Update version pins in `backend/pyproject.toml` and `containers/Containerfile.chemex`.
2. Update `PINNED_CHEMEX_VERSION` in `resoflow/chemex_api/compat.py`.
3. Verify progress hook signatures: `pytest backend/tests/chemex_api/test_hook_verification.py`.
4. Diff `src/chemex/chemex.py::run` and `run_fit` upstream against `resoflow/chemex_api/session.py` and `resoflow/chemex_api/fit.py` to mirror any new session setup steps.
5. Regenerate fixture baselines under `backend/tests/fixtures/baselines/`.
6. Run CLI parity tests: `pytest backend/tests/chemex_api/test_cli_parity.py`.
7. Verify custom plugin physics parity: `pytest backend/tests/chemex_api/test_plugin_parity.py`.
