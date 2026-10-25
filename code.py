"""Compatibility entry point used by Uvicorn and existing local scripts."""

from churnrisk.api import app
from churnrisk.domain import (
    DEFAULT_WEIGHTS,
    analyze,
    payment_period,
    summary,
)
from churnrisk.domain import (
    FEATURE_LABELS as FEATURES,
)
from churnrisk.security import password_hash, verify_password
from churnrisk.storage import db, init_db, load_source, replace_snapshot

__all__ = [
    "DEFAULT_WEIGHTS",
    "FEATURES",
    "analyze",
    "app",
    "db",
    "init_db",
    "load_source",
    "password_hash",
    "payment_period",
    "replace_snapshot",
    "summary",
    "verify_password",
]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("code:app", host="0.0.0.0", port=8000)
