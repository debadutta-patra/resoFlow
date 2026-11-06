"""Deprecated forwarder to resoflow.engine for backward compatibility."""
from __future__ import annotations

import warnings

warnings.warn(
    "resoflow.progress is deprecated and will be removed in a future release. "
    "Use 'python -m resoflow.engine' instead.",
    DeprecationWarning,
    stacklevel=2,
)

from resoflow.engine.__main__ import main

if __name__ == "__main__":
    main()
