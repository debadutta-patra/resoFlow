"""Plugin registration manager for custom ChemEx experiments and extensions."""

from __future__ import annotations

import importlib
import logging
import pkgutil

logger = logging.getLogger(__name__)

_PLUGINS_REGISTERED: bool = False
_REGISTERED_PLUGINS: list[str] = []


def ensure_registered() -> list[str]:
    """Idempotently register all custom experiment plugins in resoflow.chemex_plugins."""
    global _PLUGINS_REGISTERED, _REGISTERED_PLUGINS
    if _PLUGINS_REGISTERED:
        return list(_REGISTERED_PLUGINS)

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
                    exp_name = getattr(mod, "EXPERIMENT_NAME", mod_name)
                    if exp_name not in _REGISTERED_PLUGINS:
                        _REGISTERED_PLUGINS.append(exp_name)
                    logger.debug("Registered custom plugin: %s (%s)", mod_name, exp_name)
                except Exception as exc:
                    logger.warning("Failed to register custom plugin %s: %s", mod_name, exc)
    except ImportError:
        # resoflow.chemex_plugins package not yet present or empty
        pass

    _PLUGINS_REGISTERED = True
    return list(_REGISTERED_PLUGINS)


def registered_plugins() -> list[str]:
    """Return the list of registered custom plugin experiment names."""
    ensure_registered()
    return list(_REGISTERED_PLUGINS)
