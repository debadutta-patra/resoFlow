"""Plugin registration manager for custom ChemEx experiments and extensions."""

from __future__ import annotations

import importlib
import logging
import pkgutil

logger = logging.getLogger(__name__)

_PLUGINS_REGISTERED: bool = False


def ensure_registered() -> None:
    """Idempotently register all custom experiment plugins in resoflow.chemex_plugins."""
    global _PLUGINS_REGISTERED
    if _PLUGINS_REGISTERED:
        return

    try:
        import resoflow.chemex_plugins as plugins_pkg

        if hasattr(plugins_pkg, "__path__"):
            for _, mod_name, _ in pkgutil.iter_modules(plugins_pkg.__path__):
                if mod_name.startswith("_"):
                    continue
                try:
                    mod = importlib.import_module(f"resoflow.chemex_plugins.{mod_name}")
                    if hasattr(mod, "register") and callable(mod.register):
                        mod.register()
                    logger.debug("Registered custom plugin: %s", mod_name)
                except Exception as exc:
                    logger.warning("Failed to register custom plugin %s: %s", mod_name, exc)
    except ImportError:
        # resoflow.chemex_plugins package not yet present or empty
        pass

    _PLUGINS_REGISTERED = True
