# Aéza - это быстрый хостинг
"""Optional OpenID Connect login (Authorization Code flow with PKCE).

The panel keeps its local administrator password as a fallback; OIDC is
enabled only when the ``OIDC_*`` environment variables are set.  After a
successful code exchange the ID token is verified against the issuer's
JWKS (signature, issuer, audience, expiry, nonce) and the verified
identity is mapped onto the same server-side session cookie used by the
password login, so the rest of the API does not care how the user
authenticated.

HTTP and JWT helpers import their third-party libraries lazily: the
application still starts (with OIDC reporting itself as unavailable)
when ``httpx``/``PyJWT`` are not installed.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode


class OidcError(RuntimeError):
    """Any recoverable OIDC failure (network, token, identity)."""


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scopes: str
    provider_name: str
    allowed_users: frozenset[str] = field(default_factory=frozenset)


def load_config() -> OidcConfig | None:
    """Return the OIDC configuration, or None when OIDC is disabled."""
    issuer = os.getenv("OIDC_ISSUER", "").strip()
    client_id = os.getenv("OIDC_CLIENT_ID", "").strip()
    if not issuer or not client_id:
        return None
    allowed = frozenset(
        item.strip().casefold()
        for item in os.getenv("OIDC_ALLOWED_USERS", "").split(",")
        if item.strip()
    )
    return OidcConfig(
        issuer=issuer.rstrip("/"),
        client_id=client_id,
        client_secret=os.getenv("OIDC_CLIENT_SECRET", "").strip(),
        redirect_uri=os.getenv("OIDC_REDIRECT_URI", "").strip(),
        scopes=os.getenv("OIDC_SCOPES", "openid profile email").strip() or "openid",
        provider_name=os.getenv("OIDC_PROVIDER_NAME", "SSO").strip() or "SSO",
        allowed_users=allowed,
    )


def code_verifier() -> str:
    return secrets.token_urlsafe(48)


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


_DISCOVERY_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_DISCOVERY_TTL_SECONDS = 300.0


def _http_get_json(url: str) -> dict[str, Any]:
    try:
        import httpx
    except ImportError as error:  # pragma: no cover - depends on env
        raise OidcError("OIDC требует установленный httpx") from error
    try:
        response = httpx.get(url, timeout=5.0, follow_redirects=True)
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        raise OidcError("OIDC провайдер недоступен") from error
    if not isinstance(payload, dict):
        raise OidcError("OIDC провайдер вернул некорректный ответ")
    return payload


def _http_post_form(url: str, form: dict[str, str]) -> dict[str, Any]:
    try:
        import httpx
    except ImportError as error:  # pragma: no cover - depends on env
        raise OidcError("OIDC требует установленный httpx") from error
    try:
        response = httpx.post(url, data=form, timeout=5.0)
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        raise OidcError("Обмен кода авторизации не удался") from error
    if not isinstance(payload, dict):
        raise OidcError("OIDC провайдер вернул некорректный ответ")
    return payload


def discover(issuer: str) -> dict[str, Any]:
    """Fetch and briefly cache the issuer discovery document."""
    now = time.monotonic()
    cached = _DISCOVERY_CACHE.get(issuer)
    if cached and now - cached[0] < _DISCOVERY_TTL_SECONDS:
        return cached[1]
    document = _http_get_json(f"{issuer}/.well-known/openid-configuration")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not document.get(key):
            raise OidcError(f"В discovery-документе отсутствует {key}")
    _DISCOVERY_CACHE[issuer] = (now, document)
    return document


def build_authorize_url(
    config: OidcConfig,
    discovery: dict[str, Any],
    *,
    state: str,
    nonce: str,
    challenge: str,
    redirect_uri: str,
) -> str:
    params = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": redirect_uri,
        "scope": config.scopes,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{discovery['authorization_endpoint']}?{urlencode(params)}"


def _verify_id_token(
    id_token: str,
    config: OidcConfig,
    discovery: dict[str, Any],
) -> dict[str, Any]:
    try:
        import jwt
    except ImportError as error:  # pragma: no cover - depends on env
        raise OidcError("OIDC требует установленный PyJWT") from error
    try:
        jwk_client = jwt.PyJWKClient(str(discovery["jwks_uri"]))
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            audience=config.client_id,
            issuer=str(discovery.get("issuer") or config.issuer),
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except OidcError:
        raise
    except Exception as error:
        raise OidcError("ID-токен не прошёл проверку") from error
    if not isinstance(claims, dict):
        raise OidcError("ID-токен не содержит claims")
    return claims


def exchange_and_verify(
    config: OidcConfig,
    discovery: dict[str, Any],
    *,
    code: str,
    verifier: str,
    nonce: str,
    redirect_uri: str,
) -> dict[str, Any]:
    """Exchange the authorization code and verify the returned ID token."""
    tokens = _http_post_form(
        str(discovery["token_endpoint"]),
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "code_verifier": verifier,
        },
    )
    id_token = tokens.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise OidcError("OIDC провайдер не вернул ID-токен")
    claims = _verify_id_token(id_token, config, discovery)
    if claims.get("nonce") != nonce:
        raise OidcError("Nonce ID-токена не совпадает")
    return claims


def identity_from_claims(claims: dict[str, Any]) -> str:
    for key in ("preferred_username", "email", "sub"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise OidcError("ID-токен не содержит идентификатор пользователя")


def is_allowed(config: OidcConfig, claims: dict[str, Any]) -> bool:
    """Optional allowlist: OIDC_ALLOWED_USERS (sub / email / username)."""
    if not config.allowed_users:
        return True
    candidates = {
        str(claims.get(key, "")).strip().casefold()
        for key in ("preferred_username", "email", "sub")
    }
    return bool(candidates & config.allowed_users)
