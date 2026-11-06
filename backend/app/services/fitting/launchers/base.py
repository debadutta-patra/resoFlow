"""Base interfaces, data structures, and state definitions for ChemEx job launchers."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from resoflow.chemex_api.spec import FitJobSpec


class JobState(str, Enum):
    """Lifecycle states of a launched ChemEx fitting job."""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    LOST = "LOST"


@dataclass
class Resources:
    """Execution resources requested for a job."""

    cpus: int | float | None = None
    memory: str | None = None
    walltime_s: int | None = None
    partition: str | None = None  # Ignored by Local and Podman
    account: str | None = None  # Ignored by Local and Podman


@dataclass
class JobHandle:
    """JSON-serializable handle referencing a launched ChemEx job."""

    launcher: str
    id: str
    job_dir: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize handle to a JSON-compatible dictionary for database persistence."""
        return {
            "launcher": self.launcher,
            "id": self.id,
            "job_dir": self.job_dir,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> JobHandle:
        """Reconstitute a JobHandle from a serialized dictionary."""
        return cls(
            launcher=str(data.get("launcher", "")),
            id=str(data.get("id", "")),
            job_dir=str(data.get("job_dir", "")),
            metadata=dict(data.get("metadata", {})),
        )


class Launcher(Protocol):
    """Protocol implemented by all execution backends (Local, Podman, Slurm)."""

    name: str

    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle:
        """Submit a job for execution in `job_dir` using the given specification and resources."""
        ...

    def poll(self, handle: JobHandle) -> JobState:
        """Query the current state of a launched job."""
        ...

    def cancel(self, handle: JobHandle) -> None:
        """Cancel a running or pending job."""
        ...

    def collect(self, handle: JobHandle) -> Path:
        """Retrieve finished outputs to a local path (no-op on shared local filesystems)."""
        ...


def find_engine_result(job_dir: Path) -> Path | None:
    """Locate engine_result.json in the job directory or under output staging directories."""
    direct = job_dir / "engine_result.json"
    if direct.exists():
        return direct
    # Check staging .tmp folders
    for cand in job_dir.glob("*.tmp/engine_result.json"):
        if cand.exists():
            return cand
    for cand in job_dir.glob("*/*.tmp/engine_result.json"):
        if cand.exists():
            return cand
    # Check output directories
    for cand in job_dir.glob("*/engine_result.json"):
        if cand.exists() and cand != direct:
            return cand
    return None

