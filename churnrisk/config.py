from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "static"
TEMPLATES_DIR = ROOT / "templates"
DATABASE_PATH = Path(
    os.getenv("DATABASE_PATH", str(ROOT / "data" / "churn.db"))
).expanduser()
SESSION_DAYS = 7
MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAX_ACCOUNTS = 100_000
MAX_SERVICES = 500_000
MAX_TRANSACTIONS = 1_000_000
LOGIN_ATTEMPT_LIMIT = 8
LOGIN_WINDOW_SECONDS = 15 * 60
