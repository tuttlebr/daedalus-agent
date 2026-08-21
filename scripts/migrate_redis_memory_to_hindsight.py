#!/usr/bin/env python3
"""Run the packaged Redis-to-Hindsight migration from a source checkout."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

BUILDER_DIR = Path(__file__).resolve().parents[1] / "builder"
NAT_HELPERS_SRC = BUILDER_DIR / "nat_helpers" / "src"
sys.path.insert(0, str(BUILDER_DIR))
sys.path.insert(0, str(NAT_HELPERS_SRC))

runpy.run_path(
    str(BUILDER_DIR / "migrate_redis_memory_to_hindsight.py"),
    run_name="__main__",
)
