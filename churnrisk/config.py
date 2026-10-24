from __future__ import annotations

import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "static"
TEMPLATES_DIR = ROOT / "templates"
DATABASE_PATH = Path(
    os.getenv("DATABASE_PATH", str(ROOT / "data" / "churn.db"))
).expanduser()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


DATABASE_POOL_MAX = _positive_int_env("DATABASE_POOL_MAX", 10)
DATABASE_CONNECT_TIMEOUT_SECONDS = _positive_float_env(
    "DATABASE_CONNECT_TIMEOUT_SECONDS", 5.0
)
SQLITE_JOURNAL_MODE = os.getenv("SQLITE_JOURNAL_MODE", "WAL").strip().upper()
SQLITE_SYNCHRONOUS = os.getenv("SQLITE_SYNCHRONOUS", "NORMAL").strip().upper()
SQLITE_BUSY_TIMEOUT_MS = _positive_int_env("SQLITE_BUSY_TIMEOUT_MS", 15_000)
SQLITE_CACHE_SIZE_KIB = _positive_int_env("SQLITE_CACHE_SIZE_KIB", 16_384)
ANALYSIS_CACHE_TTL_SECONDS = _positive_float_env(
    "ANALYSIS_CACHE_TTL_SECONDS", 10.0
)
SESSION_DAYS = 7
MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAX_ACCOUNTS = 100_000
MAX_SERVICES = 500_000
MAX_TRANSACTIONS = 1_000_000
LOGIN_ATTEMPT_LIMIT = 8
LOGIN_WINDOW_SECONDS = 15 * 60
