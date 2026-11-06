"""Slurm / HPC batch scheduler launcher stub.

Future extension point for running resoFlow ChemEx jobs on HPC clusters:
  - Submits batch jobs using `sbatch` wrapping Apptainer / Singularity:
      apptainer exec --bind <job_dir>:/work resoflow-chemex.sif python -m resoflow.engine run job.json
  - Polls job status with `squeue` and `sacct`
  - Cancels jobs using `scancel <job_id>`
  - Collects results across shared filesystems (no-op) or rsync back
"""

from __future__ import annotations

from pathlib import Path

from resoflow.chemex_api.spec import FitJobSpec

from .base import JobHandle, JobState, Launcher, Resources


class SlurmLauncher(Launcher):
    """Stub launcher for Slurm / Apptainer HPC execution environments."""

    name: str = "slurm"

    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle:
        raise NotImplementedError(
            "SlurmLauncher is a planned extension point for HPC environments. "
            "Use LocalLauncher or PodmanLauncher for local and container execution."
        )

    def poll(self, handle: JobHandle) -> JobState:
        raise NotImplementedError("SlurmLauncher is not implemented yet.")

    def cancel(self, handle: JobHandle) -> None:
        raise NotImplementedError("SlurmLauncher is not implemented yet.")

    def collect(self, handle: JobHandle) -> Path:
        raise NotImplementedError("SlurmLauncher is not implemented yet.")
