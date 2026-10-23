"""Test configuration uses an isolated database and disposable credentials."""

import os
import tempfile
from pathlib import Path

_test_root = Path(tempfile.mkdtemp(prefix="churnrisk-tests-"))
os.environ["DATABASE_PATH"] = str(_test_root / "test.db")
os.environ["ADMIN_USERNAME"] = "test-admin"
os.environ["ADMIN_PASSWORD"] = "test-only-password-2026"
os.environ["COOKIE_SECURE"] = "false"
