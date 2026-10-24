from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from threading import Lock

_CONFIGURED_SALT = b"churn-risk-configured-password-v1"
_EXPECTED_HASH_LOCK = Lock()
_EXPECTED_HASH_CACHE: tuple[bytes, str] | None = None


def password_hash(password: str, salt: bytes | None = None) -> str:
    actual_salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=actual_salt, n=2**14, r=8, p=1
    ).hex()
    return f"{actual_salt.hex()}:{digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        salt_hex, expected = encoded.split(":", 1)
        actual = password_hash(password, bytes.fromhex(salt_hex)).split(":", 1)[1]
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def configured_admin() -> tuple[str, str]:
    username = os.getenv("ADMIN_USERNAME", "admin").strip()
    password = os.getenv("ADMIN_PASSWORD", "")
    return username, password


def _configured_password_hash(expected_password: str) -> str:
    global _EXPECTED_HASH_CACHE
    fingerprint = hashlib.sha256(expected_password.encode("utf-8")).digest()
    with _EXPECTED_HASH_LOCK:
        cached = _EXPECTED_HASH_CACHE
        if cached is not None and hmac.compare_digest(cached[0], fingerprint):
            return cached[1]
        expected_hash = password_hash(expected_password, _CONFIGURED_SALT)
        _EXPECTED_HASH_CACHE = (fingerprint, expected_hash)
        return expected_hash


def verify_admin(username: str, password: str) -> bool:
    expected_username, expected_password = configured_admin()
    # Always perform the expensive password derivation, even if the username is wrong.
    actual_hash = password_hash(password, _CONFIGURED_SALT)
    expected_hash = _configured_password_hash(expected_password)
    username_matches = hmac.compare_digest(
        username.encode("utf-8"), expected_username.encode("utf-8")
    )
    password_matches = hmac.compare_digest(
        actual_hash.encode("ascii"), expected_hash.encode("ascii")
    )
    # An unset administrator credential must fail closed.  Without this
    # explicit check, an empty Basic password would compare equal to an
    # empty ADMIN_PASSWORD even though the UI reports password login as
    # unavailable.
    credentials_configured = bool(expected_username and expected_password)
    return credentials_configured and username_matches & password_matches
