"""Offline tests for the pure-python modules of astrbot_plugin_agenda.

The modules are loaded straight from file paths so the tests run without
AstrBot installed::

    python -m unittest discover -s tests -t . -v
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "astrbot_plugin_agenda"


def load_module(stem: str, alias: str | None = None):
    """Load a plugin module by file stem, bypassing package imports.

    Args:
        stem: File name without ``.py``, e.g. ``store``.
        alias: Module name to register, defaults to ``agenda_<stem>``.

    Returns:
        The imported module object.
    """
    alias = alias or f"agenda_{stem}"
    if alias in sys.modules:
        return sys.modules[alias]
    spec = importlib.util.spec_from_file_location(alias, PLUGIN_DIR / f"{stem}.py")
    assert spec and spec.loader, f"cannot load {stem}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


__all__ = ["PLUGIN_DIR", "load_module", "unittest"]
