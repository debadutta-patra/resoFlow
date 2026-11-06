"""Job launcher subsystem for executing ChemEx fits across execution backends."""

from __future__ import annotations

import os

from .base import JobHandle, JobState, Launcher, Resources
from .local import LocalLauncher
from .podman import PodmanLauncher, get_container_name, is_chemex_container_running, reap_orphaned_chemex_containers
from .slurm import SlurmLauncher
from .wait import wait_for_job

__all__ = [
    "JobHandle",
    "JobState",
    "Launcher",
    "Resources",
    "LocalLauncher",
    "PodmanLauncher",
    "SlurmLauncher",
    "wait_for_job",
    "get_launcher",
    "get_container_name",
    "is_chemex_container_running",
    "reap_orphaned_chemex_containers",
]


def get_launcher(name: str | None = None) -> Launcher:
    """Retrieve an appropriate launcher instance based on configuration or environment.

    Precedence:
      1. Explicit `name` argument
      2. Environment variable `RESOFLOW_LAUNCHER` (local, podman, slurm)
      3. Fallback: if `RESOFLOW_USE_CONTAINER` or `RESOFLOW_SELINUX_MOUNT` is set -> podman, else local.
    """
    if name is None:
        name = os.getenv("RESOFLOW_LAUNCHER", "").lower().strip()
    if not name:
        if os.getenv("RESOFLOW_USE_CONTAINER", "").lower() in ("true", "1", "yes") or "RESOFLOW_SELINUX_MOUNT" in os.environ:
            name = "podman"
        else:
            name = "local"

    if name == "local":
        return LocalLauncher()
    elif name == "podman":
        return PodmanLauncher()
    elif name == "slurm":
        return SlurmLauncher()
    else:
        raise ValueError(f"Unknown launcher '{name}'. Supported options: 'local', 'podman', 'slurm'.")
