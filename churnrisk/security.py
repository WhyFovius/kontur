from __future__ import annotations

import hashlib
import hmac
import os
import secrets

_CONFIGURED_SALT = b"churn-risk-configured-password-v1"


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


def verify_admin(username: str, password: str) -> bool:
    expected_username, expected_password = configured_admin()
    # Always perform the expensive password derivation, even if the username is wrong.
    actual_hash = password_hash(password, _CONFIGURED_SALT)
    expected_hash = password_hash(expected_password, _CONFIGURED_SALT)
    username_matches = hmac.compare_digest(
        username.encode("utf-8"), expected_username.encode("utf-8")
    )
    password_matches = hmac.compare_digest(
        actual_hash.encode("ascii"), expected_hash.encode("ascii")
    )
    return username_matches & password_matches
