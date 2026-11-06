"""Direct library entry point for running ChemEx simulations."""

from __future__ import annotations

from pathlib import Path

import chemex.chemex

from .session import build_session
from .spec import FitJobSpec


def run_simulation(spec: FitJobSpec, job_dir: Path | None = None) -> None:
    """Execute a ChemEx simulation matching chemex.chemex.run_sim."""
    base_dir = Path(job_dir).resolve() if job_dir is not None else Path.cwd()
    session, experiments, _, args_ns, _, _ = build_session(
        spec, job_dir=base_dir, command="simulate"
    )
    chemex.chemex.run_sim(args_ns, experiments, session)
