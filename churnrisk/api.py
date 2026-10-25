from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Lock, RLock, Thread
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, Security
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.security import APIKeyCookie
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import oidc as oidc_service
from .alerts import (
    ensure_alert_tables,
    events_after,
    latest_event_id,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    mark_notification_unread,
    notification_counts,
    sync_alerts,
)
from .config import (
    ANALYSIS_CACHE_TTL_SECONDS,
    DEMO_WORKSPACE_DIR,
    MAX_REGISTERED_USERS,
    MAX_SNAPSHOT_BYTES,
    PUBLIC_REGISTRATION_ENABLED,
    SESSION_DAYS,
    STATIC_DIR,
    TEMPLATES_DIR,
)
from .database import (
    DatabaseError,
    active_database_target,
    checkpoint_database,
    close_database_pools,
    set_active_database_target,
    sqlite_database_target,
    use_database_target,
    use_sqlite_database,
)
from .database import (
    database_healthcheck as _database_healthcheck,
)
from .domain import (
    DEFAULT_WEIGHTS,
    FEATURE_LABELS,
    RISK_THRESHOLDS,
    ServiceFact,
    TransactionFact,
    analyze_prepared,
    churn_timeline,
    iso,
    rescue_queue,
    summary,
    utcnow,
)
from .realtime import (
    customer_realtime_history,
    ensure_realtime_tables,
    latest_realtime_event_id,
    list_reaction_outbox,
    list_reaction_templates,
    list_realtime_events,
    process_demo_event,
    realtime_dashboard,
    realtime_events_after,
    realtime_metric_counts,
    realtime_status,
    reset_demo_data,
    simulator_for,
    stop_all_simulators,
    update_reaction_template,
)
from .schemas import (
    AnalyticsSummary,
    AuthProvidersResponse,
    ChurnTimelineResponse,
    CustomerListResponse,
    CustomerRealtimeHistoryResponse,
    CustomerResponse,
    DemoGenerateRequest,
    DemoResetResponse,
    LoginRequest,
    LoginResponse,
    ModelSettingsResponse,
    NotificationListResponse,
    NotificationReadResponse,
    ReactionOutboxResponse,
    ReactionTemplate,
    ReactionTemplateListResponse,
    ReactionTemplatePatch,
    RealtimeDashboardResponse,
    RealtimeEvent,
    RealtimeEventListResponse,
    RealtimeStatusResponse,
    RegisterRequest,
    RescueQueueResponse,
    SettingsPatch,
    SimulatorActionResponse,
    SimulatorStartRequest,
    SnapshotRequest,
    SnapshotResponse,
)
from .security import configured_admin, password_hash, verify_admin, verify_password
from .storage import (
    RegisteredUserExistsError,
    SnapshotValidationError,
    clear_login_failures,
    count_registered_users,
    create_registered_user,
    db,
    delete_registered_user,
    ensure_auth_schema,
    get_registered_user,
    get_weights,
    init_db,
    load_prepared_source,
    login_rate_limited,
    record_login_failure,
    registry_db,
    replace_snapshot,
    touch_registered_user_login,
    update_weights,
)

logger = logging.getLogger("churnrisk")
session_cookie = APIKeyCookie(
    name="churn_session", auto_error=False, scheme_name="AdminSession"
)
PreparedSource = tuple[
    list[dict[str, Any]],
    dict[str, tuple[list[dict[str, Any]], list[ServiceFact]]],
    dict[str, TransactionFact],
]


@dataclass
class _AnalysisCacheEntry:
    key: tuple[str, int, int]
    computed_at: float
    generated_at: datetime
    customers: list[dict[str, Any]]
    aggregate: dict[str, Any]
    weights: dict[str, float]
    by_id: dict[str, dict[str, Any]] = field(init=False)
    _timeline: dict[str, Any] | None = field(default=None, init=False, repr=False)
    _rescue_cache: dict[tuple[int, int], dict[str, Any]] = field(
        default_factory=dict, init=False, repr=False
    )
    _sorted_cache: dict[tuple[str, str, str], list[dict[str, Any]]] = field(
        default_factory=dict, init=False, repr=False
    )
    _derived_lock: RLock = field(default_factory=RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        self.by_id = {str(customer["id"]): customer for customer in self.customers}


_analysis_state_lock = RLock()
_analysis_compute_lock = Lock()
_analysis_cache: dict[str, _AnalysisCacheEntry] = {}
_prepared_cache_lock = RLock()
_prepared_cache: dict[str, tuple[int, PreparedSource]] = {}
_analysis_refresh_lock = Lock()
_analysis_refresh_running: set[str] = set()
_MAX_CACHED_WORKSPACES = 8
_workspace_initialization_lock = Lock()
_initialized_workspace_files: set[str] = set()


def _evict_workspace_caches_locked(keep_identity: str) -> None:
    """Bound analysis memory when many preview workspaces are active."""

    while len(_analysis_cache) >= _MAX_CACHED_WORKSPACES:
        oldest = next(
            (identity for identity in _analysis_cache if identity != keep_identity),
            None,
        )
        if oldest is None:
            break
        del _analysis_cache[oldest]


class RequestSizeLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = MAX_SNAPSHOT_BYTES if path == "/api/v1/source/snapshot" else 1_048_576
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length:
            try:
                if int(content_length) > limit:
                    await JSONResponse(
                        {"detail": "Размер тела запроса превышает допустимый предел"},
                        status_code=413,
                    )(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse(
                    {"detail": "Некорректный Content-Length"}, status_code=400
                )(scope, receive, send)
                return

        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > limit:
                await JSONResponse(
                    {"detail": "Размер тела запроса превышает допустимый предел"},
                    status_code=413,
                )(scope, receive, send)
                return
            more_body = message.get("more_body", False)

        sent = False

        async def replay_body() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay_body, send)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path == "/api/v1/docs":
            content_security_policy = (
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            )
        else:
            content_security_policy = (
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
                "form-action 'self'; frame-ancestors 'none'"
            )

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers.extend(
                    [
                        (
                            b"content-security-policy",
                            content_security_policy.encode("ascii"),
                        ),
                        (b"x-content-type-options", b"nosniff"),
                        (b"x-frame-options", b"DENY"),
                        (b"referrer-policy", b"no-referrer"),
                        (
                            b"permissions-policy",
                            b"camera=(), microphone=(), geolocation=()",
                        ),
                    ]
                )
                status = int(message.get("status", 0))
                if path.startswith("/api/v1/") or path in {"/", "/login", "/metrics"}:
                    response_headers.extend(
                        [
                            (b"cache-control", b"no-store"),
                            (b"pragma", b"no-cache"),
                        ]
                    )
                elif 200 <= status < 300 and path.startswith("/static/app/assets/"):
                    # Vite emits content-hashed filenames below this prefix.
                    response_headers.append(
                        (
                            b"cache-control",
                            b"public, max-age=31536000, immutable",
                        )
                    )
                elif 200 <= status < 300 and path.startswith(
                    ("/static/fonts/", "/static/vendor/")
                ):
                    response_headers.append(
                        (b"cache-control", b"public, max-age=604800")
                    )
                message["headers"] = response_headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


def _initialize_database() -> None:
    init_db()
    with db() as connection:
        ensure_alert_tables(connection)
        ensure_realtime_tables(connection)


def _ensure_workspace_initialized(workspace_file: str) -> Path:
    """Create/seed one registered user's isolated demo database."""

    path = _workspace_path(workspace_file)
    if workspace_file in _initialized_workspace_files and path.is_file():
        return path
    with _workspace_initialization_lock:
        if workspace_file in _initialized_workspace_files and path.is_file():
            return path
        DEMO_WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        with use_sqlite_database(path):
            _initialize_database()
        _initialized_workspace_files.add(workspace_file)
    return path


@asynccontextmanager
async def lifespan(_: FastAPI):
    await asyncio.to_thread(_initialize_database)
    if not os.getenv("ADMIN_PASSWORD"):
        logger.warning(
            "ADMIN_PASSWORD is not configured; login will remain unavailable"
        )
    try:
        yield
    finally:
        await asyncio.to_thread(stop_all_simulators)
        try:
            await asyncio.to_thread(checkpoint_database)
        except DatabaseError:
            logger.warning("Database checkpoint failed during shutdown", exc_info=True)
        close_database_pools()


app = FastAPI(
    title="Churn Risk API",
    version="2.0.0",
    description="Объяснимая аналитика риска оттока клиентов",
    docs_url=None,
    openapi_url="/api/v1/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(RequestSizeLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/v1/docs", include_in_schema=False)
async def swagger_docs():
    return get_swagger_ui_html(
        openapi_url=app.openapi_url or "/api/v1/openapi.json",
        title=f"{app.title} — Swagger UI",
        swagger_js_url="/static/vendor/swagger-ui/swagger-ui-bundle.js",
        swagger_css_url="/static/vendor/swagger-ui/swagger-ui.css",
        swagger_favicon_url="/static/vendor/swagger-ui/favicon-32x32.png",
    )


@dataclass(frozen=True)
class _AuthContext:
    username: str
    auth_kind: str = "admin"
    workspace_file: str | None = None
    target: Any = None

    @property
    def demo(self) -> bool:
        return self.auth_kind == "demo"


def _workspace_path(workspace_file: str) -> Path:
    safe_name = Path(workspace_file).name
    if safe_name != workspace_file or not safe_name.endswith(".db"):
        raise HTTPException(status_code=401, detail="Некорректная сессия")
    return DEMO_WORKSPACE_DIR / safe_name


def _workspace_target(workspace_file: str | None) -> Any:
    if not workspace_file:
        return None
    return sqlite_database_target(_workspace_path(workspace_file))


def _auth_context_for_token_sync(token: str | None) -> _AuthContext:
    if not token:
        raise HTTPException(status_code=401, detail="Требуется вход")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with registry_db() as connection:
        ensure_auth_schema(connection)
        row = connection.execute(
            "SELECT username, expires_at, auth_kind, workspace_file "
            "FROM sessions WHERE token_hash=?",
            (token_hash,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Сессия не найдена")
        expires = datetime.fromisoformat(row["expires_at"])
        if expires <= utcnow():
            raise HTTPException(status_code=401, detail="Сессия истекла")
    workspace_file = row["workspace_file"]
    workspace_file = str(workspace_file) if workspace_file else None
    return _AuthContext(
        username=str(row["username"]),
        auth_kind=str(row["auth_kind"] or "admin"),
        workspace_file=workspace_file,
        target=_workspace_target(workspace_file),
    )


def _username_for_token_sync(token: str | None) -> str:
    return _auth_context_for_token_sync(token).username


async def _username_for_token(token: str | None) -> str:
    return await asyncio.to_thread(_username_for_token_sync, token)


async def _auth_context_for_token(token: str | None) -> _AuthContext:
    return await asyncio.to_thread(_auth_context_for_token_sync, token)


async def _current_auth_context(
    request: Request, token: str | None = Security(session_cookie)
) -> _AuthContext:
    basic_username = await _basic_auth_username(request)
    if basic_username is not None:
        return _AuthContext(username=basic_username, auth_kind="admin")
    context = await _auth_context_for_token(token)
    if context.target is not None:
        # The endpoint and its thread workers inherit this task context,
        # so all ordinary storage calls now address the demo workspace.
        set_active_database_target(context.target)
    return context


CurrentAuthContext = Annotated[_AuthContext, Depends(_current_auth_context)]


async def _basic_auth_username(request: Request) -> str | None:
    """Optional HTTP Basic fallback (API clients, collectors).

    Returns the admin name when a valid ``Authorization: Basic`` header
    is present, None when there is no Basic header, and raises 401 for
    a malformed/wrong one so a bad credential never falls through to a
    cookie session.
    """
    header = request.headers.get("authorization", "")
    scheme, _, credentials = header.partition(" ")
    if scheme.casefold() != "basic" or not credentials:
        return None
    try:
        decoded = base64.b64decode(credentials, validate=True).decode("utf-8")
        username, _, password = decoded.partition(":")
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(
            status_code=401, detail="Некорректный заголовок Basic-авторизации"
        ) from None
    if not await asyncio.to_thread(verify_admin, username, password):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    return os.getenv("ADMIN_USERNAME", "admin").strip()


async def current_user(
    request: Request, token: str | None = Security(session_cookie)
) -> str:
    return (await _current_auth_context(request, token)).username


def _public_customer(customer: dict[str, Any]) -> dict[str, Any]:
    allowed_service_fields = (
        "id",
        "name",
        "status",
        "price",
        "paymentTerm",
        "autoprolong",
        "expiresAt",
        "deletedAt",
    )
    return {
        "id": customer["id"],
        "email": customer["email"],
        "balance": customer["balance"],
        "availableBalance": customer.get("availableBalance"),
        "totalReplenished": customer["totalReplenished"],
        "score": customer["score"],
        "riskLevel": customer["riskLevel"],
        "reasons": customer["reasons"],
        "services": [
            {key: service[key] for key in allowed_service_fields if key in service}
            for service in customer.get("services", [])
        ],
        "features": customer.get("features", {}),
        "estimatedLoss": customer["estimatedLoss"],
        "monthlyRevenue": customer["monthlyRevenue"],
        "daysToExpiry": customer.get("daysToExpiry"),
    }


def _sync_realtime_alerts(
    customers: list[dict[str, Any]], aggregate: dict[str, Any]
) -> None:
    """Best-effort monitor sync; analytics must not fail because alerts did."""
    try:
        sync_alerts(customers, aggregate)
    except Exception:
        logger.exception("Realtime risk monitor sync failed")


def _read_analysis_versions() -> tuple[str, int, int]:
    with db() as connection:
        identity = connection.identity
        versions = connection.execute(
            "SELECT key, value FROM metadata WHERE key IN ('snapshot_version', 'model_version')"
        ).fetchall()
    version_map = {row["key"]: int(row["value"]) for row in versions}
    return (
        identity,
        version_map.get("snapshot_version", 0),
        version_map.get("model_version", 0),
    )


def _prepared_source(identity: str, snapshot_version: int) -> PreparedSource:
    with _prepared_cache_lock:
        cached = _prepared_cache.get(identity)
        if cached is not None and cached[0] == snapshot_version:
            return cached[1]
        with db() as connection:
            if connection.identity != identity:
                raise DatabaseError("Prepared source requested for another workspace")
            source = load_prepared_source(connection)
        if identity not in _prepared_cache:
            while len(_prepared_cache) >= _MAX_CACHED_WORKSPACES:
                oldest = next(
                    (key for key in _prepared_cache if key != identity), None
                )
                if oldest is None:
                    break
                del _prepared_cache[oldest]
        _prepared_cache[identity] = (snapshot_version, source)
        return source


def _compute_analysis(
    key: tuple[str, int, int], *, refresh_after: float | None = None
) -> _AnalysisCacheEntry:
    identity = key[0]
    with _analysis_compute_lock:
        with _analysis_state_lock:
            cached = _analysis_cache.get(identity)
        if (
            cached is not None
            and cached.key == key
            and (refresh_after is None or cached.computed_at > refresh_after)
        ):
            return cached

        if refresh_after is not None:
            # A background refresh can be queued behind a synchronous
            # snapshot/weight change.  Never let that now-obsolete key
            # overwrite the newer entry; refresh the current version instead.
            current_key = _read_analysis_versions()
            if current_key != key:
                if current_key[0] != identity:
                    raise DatabaseError("Analysis refresh crossed workspaces")
                if cached is not None and cached.key == current_key:
                    return cached
                key = current_key

        accounts, services_by_account, transactions_by_account = _prepared_source(
            identity, key[1]
        )
        with db() as connection:
            weights = get_weights(connection)
        generated_at = utcnow()
        customers = analyze_prepared(
            accounts,
            services_by_account,
            transactions_by_account,
            weights,
            now=generated_at,
        )
        aggregate = summary(customers, now=generated_at)
        entry = _AnalysisCacheEntry(
            key=key,
            computed_at=time.monotonic(),
            generated_at=generated_at,
            customers=customers,
            aggregate=aggregate,
            weights=dict(weights),
        )
        with _analysis_state_lock:
            if identity not in _analysis_cache:
                _evict_workspace_caches_locked(identity)
            _analysis_cache[identity] = entry
        _sync_realtime_alerts(customers, aggregate)
        return entry


def _refresh_analysis(
    key: tuple[str, int, int], refresh_after: float, target: Any
) -> None:
    try:
        with use_database_target(target):
            _compute_analysis(key, refresh_after=refresh_after)
    except Exception:
        logger.exception("Background analysis refresh failed")
    finally:
        with _analysis_refresh_lock:
            _analysis_refresh_running.discard(key[0])


def _schedule_analysis_refresh(
    key: tuple[str, int, int], refresh_after: float
) -> None:
    identity = key[0]
    target = active_database_target()
    with _analysis_refresh_lock:
        if identity in _analysis_refresh_running:
            return
        _analysis_refresh_running.add(identity)
    try:
        Thread(
            target=_refresh_analysis,
            args=(key, refresh_after, target),
            daemon=True,
            name="kontur-analysis-refresh",
        ).start()
    except RuntimeError:
        with _analysis_refresh_lock:
            _analysis_refresh_running.discard(identity)
        logger.warning("Could not start the background analysis refresh", exc_info=True)


def _analysis_entry() -> _AnalysisCacheEntry:
    key = _read_analysis_versions()
    with _analysis_state_lock:
        cached = _analysis_cache.get(key[0])
    if cached is not None and cached.key == key:
        if time.monotonic() - cached.computed_at < ANALYSIS_CACHE_TTL_SECONDS:
            return cached
        # Time-dependent rules need periodic refresh, but callers can use
        # the last complete portfolio while one background worker rebuilds it.
        _schedule_analysis_refresh(key, cached.computed_at)
        return cached
    return _compute_analysis(key)


def _analyzed_data() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    entry = _analysis_entry()
    return entry.customers, entry.aggregate


async def _analysis_entry_async() -> _AnalysisCacheEntry:
    return await asyncio.to_thread(_analysis_entry)


def _timeline_for(entry: _AnalysisCacheEntry) -> dict[str, Any]:
    with entry._derived_lock:
        if entry._timeline is None:
            entry._timeline = churn_timeline(entry.customers, now=entry.generated_at)
        return entry._timeline


def _rescue_queue_for(
    entry: _AnalysisCacheEntry, *, limit: int, minimum_score: int
) -> dict[str, Any]:
    cache_key = (limit, minimum_score)
    with entry._derived_lock:
        cached = entry._rescue_cache.get(cache_key)
        if cached is None:
            cached = rescue_queue(
                entry.customers,
                weights=entry.weights,
                now=entry.generated_at,
                limit=limit,
                minimum_score=minimum_score,
            )
            if len(entry._rescue_cache) >= 16:
                entry._rescue_cache.clear()
            entry._rescue_cache[cache_key] = cached
        return cached


def _customer_sort_key(customer: dict[str, Any], sort: str) -> Any:
    value = customer[sort]
    if sort == "id":
        try:
            return (0, Decimal(str(value)))
        except InvalidOperation:
            return (1, str(value).casefold())
    if sort == "email":
        return str(value).casefold()
    return value if value is not None else 0


def _sorted_customers_for(
    entry: _AnalysisCacheEntry,
    *,
    risk: str | None,
    sort: str,
    order: str,
) -> list[dict[str, Any]]:
    cache_key = (risk or "", sort, order)
    with entry._derived_lock:
        cached = entry._sorted_cache.get(cache_key)
        if cached is not None:
            return cached
        items = (
            entry.customers
            if risk is None
            else [
                customer
                for customer in entry.customers
                if customer["riskLevel"] == risk
            ]
        )
        rated = [customer for customer in items if customer[sort] is not None]
        unrated = [customer for customer in items if customer[sort] is None]
        rated.sort(
            key=lambda customer: _customer_sort_key(customer, sort),
            reverse=order == "desc",
        )
        sorted_items = rated + unrated
        if len(entry._sorted_cache) >= 8:
            entry._sorted_cache.clear()
        entry._sorted_cache[cache_key] = sorted_items
        return sorted_items


def _frontend_response(legacy_path) -> FileResponse:
    """Serve the React (Framer Motion) bundle when it has been built.

    The bundle is emitted to ``static/app`` by ``npm run build`` in
    ``frontend/`` and committed for the Python-only Docker image.
    When it is absent (fresh checkout without a Node toolchain) the
    legacy vanilla pages are served unchanged, so the product and the
    API test-suite keep working without a frontend build.
    """
    built_index = STATIC_DIR / "app" / "index.html"
    if built_index.is_file():
        return FileResponse(built_index)
    return FileResponse(legacy_path)


@app.get("/", include_in_schema=False)
async def index(request: Request):
    try:
        await _username_for_token(request.cookies.get("churn_session"))
    except HTTPException:
        return RedirectResponse("/login", status_code=303)
    return _frontend_response(TEMPLATES_DIR / "index.html")


@app.get("/login", include_in_schema=False)
async def login_page(request: Request):
    try:
        await _username_for_token(request.cookies.get("churn_session"))
    except HTTPException:
        return _frontend_response(STATIC_DIR / "login.html")
    return RedirectResponse("/", status_code=303)


def _create_session(
    username: str,
    *,
    auth_kind: str = "admin",
    workspace_file: str | None = None,
) -> tuple[str, datetime]:
    """Create a server-side session in the registry database.

    Password, OIDC and registered-preview login all share this path;
    only preview sessions carry a workspace file.
    """
    token = secrets.token_urlsafe(36)
    expires_at = utcnow() + timedelta(days=SESSION_DAYS)
    with registry_db() as connection:
        ensure_auth_schema(connection)
        connection.execute(
            "DELETE FROM sessions WHERE expires_at < ?", (iso(utcnow()),)
        )
        connection.execute(
            "INSERT INTO sessions "
            "(token_hash, username, expires_at, auth_kind, workspace_file) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                hashlib.sha256(token.encode("utf-8")).hexdigest(),
                username,
                iso(expires_at),
                auth_kind,
                workspace_file,
            ),
        )
    return token, expires_at


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        "churn_session",
        token,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false").strip().casefold() == "true",
        samesite="lax",
        max_age=SESSION_DAYS * 86400,
        path="/",
    )


def _oidc_redirect_uri(request: Request, config) -> str:
    return config.redirect_uri or str(request.url_for("oidc_callback"))


def _store_oidc_state(
    state_hash: str, nonce: str, verifier: str, expires_at: datetime
) -> None:
    with registry_db() as connection:
        connection.execute(
            "DELETE FROM oidc_states WHERE expires_at < ?", (iso(utcnow()),)
        )
        connection.execute(
            "INSERT INTO oidc_states (state_hash, nonce, code_verifier, expires_at)"
            " VALUES (?, ?, ?, ?)",
            (state_hash, nonce, verifier, iso(expires_at)),
        )


def _pop_oidc_state(state_hash: str):
    with registry_db() as connection:
        row = connection.execute(
            "SELECT nonce, code_verifier, expires_at FROM oidc_states"
            " WHERE state_hash=?",
            (state_hash,),
        ).fetchone()
        connection.execute("DELETE FROM oidc_states WHERE state_hash=?", (state_hash,))
    return row


@app.get("/api/v1/auth/providers", response_model=AuthProvidersResponse)
async def auth_providers():
    """Public: which login methods the panel should offer."""
    config = oidc_service.load_config()
    return {
        "password": bool(os.getenv("ADMIN_PASSWORD")) or PUBLIC_REGISTRATION_ENABLED,
        "registration": {
            "enabled": PUBLIC_REGISTRATION_ENABLED,
            "demo": True,
        },
        "oidc": {
            "enabled": config is not None,
            "name": config.provider_name if config else None,
            "loginUrl": "/api/v1/auth/oidc/login" if config else None,
        },
    }


@app.get("/api/v1/auth/oidc/login", include_in_schema=True)
async def oidc_login(request: Request):
    config = oidc_service.load_config()
    if config is None:
        raise HTTPException(status_code=503, detail="OIDC не настроен")
    try:
        discovery = await asyncio.to_thread(oidc_service.discover, config.issuer)
    except oidc_service.OidcError:
        raise HTTPException(
            status_code=502, detail="OIDC провайдер недоступен"
        ) from None
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = oidc_service.code_verifier()
    expires_at = utcnow() + timedelta(minutes=10)
    await asyncio.to_thread(
        _store_oidc_state,
        hashlib.sha256(state.encode("utf-8")).hexdigest(),
        nonce,
        verifier,
        expires_at,
    )
    url = oidc_service.build_authorize_url(
        config,
        discovery,
        state=state,
        nonce=nonce,
        challenge=oidc_service.code_challenge(verifier),
        redirect_uri=_oidc_redirect_uri(request, config),
    )
    return RedirectResponse(url, status_code=302)


@app.get("/api/v1/auth/oidc/callback", include_in_schema=True)
async def oidc_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
):
    config = oidc_service.load_config()
    if config is None:
        raise HTTPException(status_code=503, detail="OIDC не настроен")
    if error or not code or not state:
        return RedirectResponse("/login?oidc_error=1", status_code=303)
    state_hash = hashlib.sha256(state.encode("utf-8")).hexdigest()
    row = await asyncio.to_thread(_pop_oidc_state, state_hash)
    if row is None or datetime.fromisoformat(row["expires_at"]) <= utcnow():
        return RedirectResponse("/login?oidc_error=1", status_code=303)
    try:
        discovery = await asyncio.to_thread(oidc_service.discover, config.issuer)
        claims = await asyncio.to_thread(
            oidc_service.exchange_and_verify,
            config,
            discovery,
            code=code,
            verifier=str(row["code_verifier"]),
            nonce=str(row["nonce"]),
            redirect_uri=_oidc_redirect_uri(request, config),
        )
        if not oidc_service.is_allowed(config, claims):
            return RedirectResponse("/login?oidc_error=1", status_code=303)
        username = oidc_service.identity_from_claims(claims)
    except oidc_service.OidcError:
        logger.warning("OIDC callback rejected", exc_info=True)
        return RedirectResponse("/login?oidc_error=1", status_code=303)
    token, _expires = await asyncio.to_thread(_create_session, username)
    response = RedirectResponse("/", status_code=303)
    _set_session_cookie(response, token)
    return response


_RESERVED_USERNAMES = {
    "admin",
    "administrator",
    "root",
    "support",
    "system",
    "aeza",
    "kontur",
}


def _auth_rate_key(request: Request, purpose: str = "login") -> str:
    remote_host = request.client.host if request.client else "unknown"
    raw = remote_host if purpose == "login" else f"{purpose}:{remote_host}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _remove_workspace_files(workspace_file: str) -> None:
    try:
        path = _workspace_path(workspace_file)
    except HTTPException:
        return
    _initialized_workspace_files.discard(workspace_file)
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            Path(f"{path}{suffix}").unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove a failed demo workspace", exc_info=True)


def _authenticate_password_sync(
    username: str, password: str
) -> _AuthContext | None:
    if verify_admin(username, password):
        admin_username, _admin_password = configured_admin()
        return _AuthContext(username=admin_username, auth_kind="admin")

    normalized = username.strip().casefold()
    user = get_registered_user(normalized)
    if user is None or not verify_password(password, str(user["passwordHash"])):
        return None
    workspace_file = str(user["workspaceFile"])
    _ensure_workspace_initialized(workspace_file)
    touch_registered_user_login(str(user["id"]))
    return _AuthContext(
        username=str(user["username"]),
        auth_kind="demo",
        workspace_file=workspace_file,
        target=_workspace_target(workspace_file),
    )


def _register_user_sync(username: str, password: str) -> _AuthContext:
    if not PUBLIC_REGISTRATION_ENABLED:
        raise HTTPException(status_code=403, detail="Регистрация отключена")
    display_username = username.strip()
    normalized = display_username.casefold()
    admin_username, _admin_password = configured_admin()
    if normalized in _RESERVED_USERNAMES or normalized == admin_username.casefold():
        raise HTTPException(status_code=422, detail="Этот логин зарезервирован")
    if get_registered_user(normalized) is not None:
        raise HTTPException(status_code=409, detail="Такой логин уже занят")
    if count_registered_users() >= MAX_REGISTERED_USERS:
        raise HTTPException(
            status_code=403,
            detail="Лимит демонстрационных аккаунтов исчерпан",
        )

    user_id = uuid.uuid4().hex
    workspace_file = f"{user_id}.db"
    try:
        user = create_registered_user(
            user_id=user_id,
            username=display_username,
            username_normalized=normalized,
            password_hash_value=password_hash(password),
            workspace_file=workspace_file,
        )
    except RegisteredUserExistsError:
        raise HTTPException(status_code=409, detail="Такой логин уже занят") from None
    except DatabaseError:
        if get_registered_user(normalized) is not None:
            raise HTTPException(
                status_code=409, detail="Такой логин уже занят"
            ) from None
        raise

    try:
        _ensure_workspace_initialized(workspace_file)
    except Exception as error:
        delete_registered_user(user_id)
        _remove_workspace_files(workspace_file)
        logger.exception("Could not initialize a registered demo workspace")
        raise HTTPException(
            status_code=503,
            detail="Не удалось создать демонстрационное рабочее пространство",
        ) from error

    touch_registered_user_login(user_id)
    return _AuthContext(
        username=str(user["username"]),
        auth_kind="demo",
        workspace_file=workspace_file,
        target=_workspace_target(workspace_file),
    )


@app.post(
    "/api/v1/auth/register",
    response_model=LoginResponse,
    status_code=201,
)
async def register(payload: RegisterRequest, request: Request, response: Response):
    """Create an isolated, pre-seeded preview account and sign it in."""

    rate_key = _auth_rate_key(request, "register")
    limited, retry_after = await asyncio.to_thread(login_rate_limited, rate_key)
    if limited:
        raise HTTPException(
            status_code=429,
            detail="Слишком много попыток регистрации. Повторите позже.",
            headers={"Retry-After": str(retry_after)},
        )
    # Count every registration attempt, not only failures: creating a
    # workspace is intentionally more expensive than a normal login.
    await asyncio.to_thread(record_login_failure, rate_key)
    identity = await asyncio.to_thread(
        _register_user_sync, payload.username, payload.password
    )
    token, expires_at = await asyncio.to_thread(
        _create_session,
        identity.username,
        auth_kind=identity.auth_kind,
        workspace_file=identity.workspace_file,
    )
    _set_session_cookie(response, token)
    return {
        "username": identity.username,
        "expiresAt": iso(expires_at),
        "demo": True,
    }


@app.post("/api/v1/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, response: Response):
    rate_key = _auth_rate_key(request)
    limited, retry_after = await asyncio.to_thread(login_rate_limited, rate_key)
    if limited:
        raise HTTPException(
            status_code=429,
            detail="Слишком много попыток входа. Повторите позже.",
            headers={"Retry-After": str(retry_after)},
        )

    identity = await asyncio.to_thread(
        _authenticate_password_sync, payload.username, payload.password
    )
    if identity is None:
        await asyncio.to_thread(record_login_failure, rate_key)
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    await asyncio.to_thread(clear_login_failures, rate_key)
    token, expires_at = await asyncio.to_thread(
        _create_session,
        identity.username,
        auth_kind=identity.auth_kind,
        workspace_file=identity.workspace_file,
    )
    _set_session_cookie(response, token)
    return {
        "username": identity.username,
        "expiresAt": iso(expires_at),
        "demo": identity.demo,
    }


@app.get("/api/v1/auth/me")
async def me(context: CurrentAuthContext):
    return {
        "username": context.username,
        "authKind": context.auth_kind,
        "demo": context.demo,
    }


def _delete_session(token: str) -> None:
    with registry_db() as connection:
        connection.execute(
            "DELETE FROM sessions WHERE token_hash=?",
            (hashlib.sha256(token.encode("utf-8")).hexdigest(),),
        )


@app.post("/api/v1/auth/logout")
async def logout(response: Response, request: Request, _: str = Depends(current_user)):
    token = request.cookies.get("churn_session", "")
    await asyncio.to_thread(_delete_session, token)
    response.delete_cookie("churn_session", path="/")
    return {"ok": True}


@app.get("/api/v1/customers", response_model=CustomerListResponse)
async def customers(
    risk: Literal["high", "medium", "low", "unrated"] | None = None,
    sort: Literal["id", "email", "balance", "totalReplenished", "score"] = "score",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _: str = Depends(current_user),
):
    entry = await _analysis_entry_async()
    sorted_items = await asyncio.to_thread(
        _sorted_customers_for,
        entry,
        risk=risk,
        sort=sort,
        order=order,
    )
    page = [
        _public_customer(customer) for customer in sorted_items[offset : offset + limit]
    ]
    return {"items": page, "total": len(sorted_items)}


@app.get("/api/v1/customers/{customer_id}", response_model=CustomerResponse)
async def customer_detail(customer_id: str, _: str = Depends(current_user)):
    entry = await _analysis_entry_async()
    customer = entry.by_id.get(customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return _public_customer(customer)


@app.get("/api/v1/analytics/summary", response_model=AnalyticsSummary)
async def analytics_summary(_: str = Depends(current_user)):
    entry = await _analysis_entry_async()
    return {**entry.aggregate, "currency": "EUR", "unit": "eurocents"}


@app.get(
    "/api/v1/analytics/churn-timeline", response_model=ChurnTimelineResponse
)
async def analytics_churn_timeline(_: str = Depends(current_user)):
    entry = await _analysis_entry_async()
    return await asyncio.to_thread(_timeline_for, entry)


@app.get("/api/v1/analytics/rescue-queue", response_model=RescueQueueResponse)
async def analytics_rescue_queue(
    limit: int = Query(default=10, ge=1, le=100),
    minimum_score: int = Query(default=65, ge=0, le=100),
    _: str = Depends(current_user),
):
    entry = await _analysis_entry_async()
    return await asyncio.to_thread(
        _rescue_queue_for,
        entry,
        limit=limit,
        minimum_score=minimum_score,
    )


@app.get("/api/v1/notifications", response_model=NotificationListResponse)
async def get_notifications(
    limit: int = Query(default=30, ge=1, le=100),
    unread_only: bool = False,
    read_only: bool = False,
    _: str = Depends(current_user),
):
    # Touch the analysis first so a cold panel sees the monitor's current
    # episodes instead of an empty table until some other endpoint runs.
    await _analysis_entry_async()
    return await asyncio.to_thread(
        list_notifications,
        limit=limit,
        unread_only=unread_only,
        read_only=read_only,
    )


@app.post(
    "/api/v1/notifications/read-all", response_model=NotificationReadResponse
)
async def read_all_notifications(_: str = Depends(current_user)):
    updated = await asyncio.to_thread(mark_all_notifications_read)
    unread, _critical = await asyncio.to_thread(notification_counts)
    return {"ok": True, "updatedCount": updated, "unreadCount": unread}


@app.post(
    "/api/v1/notifications/{notification_id}/read",
    response_model=NotificationReadResponse,
)
async def read_notification(
    notification_id: int, _: str = Depends(current_user)
):
    notification = await asyncio.to_thread(
        mark_notification_read, notification_id
    )
    if notification is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    unread, _critical = await asyncio.to_thread(notification_counts)
    return {
        "ok": True,
        "notification": notification,
        "updatedCount": 1,
        "unreadCount": unread,
    }


@app.post(
    "/api/v1/notifications/{notification_id}/unread",
    response_model=NotificationReadResponse,
)
async def unread_notification(
    notification_id: int, _: str = Depends(current_user)
):
    notification = await asyncio.to_thread(
        mark_notification_unread, notification_id
    )
    if notification is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    unread, _critical = await asyncio.to_thread(notification_counts)
    return {
        "ok": True,
        "notification": notification,
        "updatedCount": 1,
        "unreadCount": unread,
    }


def _sse_event(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/api/v1/events/stream")
async def events_stream(request: Request, _: str = Depends(current_user)):
    """Server-Sent Events feed for newly detected risk episodes.

    The stream emits one compact snapshot on connect, then only new
    notifications.  A heartbeat comment keeps proxies from closing an
    otherwise idle connection; no portfolio payload is resent every tick.
    """

    workspace_target = active_database_target()

    async def generate():
        set_active_database_target(workspace_target)
        await asyncio.to_thread(_analyzed_data)
        last_id = await asyncio.to_thread(latest_event_id)
        snapshot = await asyncio.to_thread(list_notifications, 12, False)
        yield _sse_event(
            "snapshot",
            {
                "unreadCount": snapshot["unreadCount"],
                "criticalCount": snapshot["criticalCount"],
                "items": snapshot["items"],
            },
        )
        heartbeat_ticks = 0
        while not await request.is_disconnected():
            await asyncio.to_thread(_analyzed_data)
            fresh = await asyncio.to_thread(events_after, last_id)
            for event in fresh:
                last_id = max(last_id, int(event["id"]))
                yield _sse_event("notification", event)
            heartbeat_ticks += 1
            if heartbeat_ticks >= 8:
                heartbeat_ticks = 0
                yield ": heartbeat\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/v1/realtime/status", response_model=RealtimeStatusResponse)
async def get_realtime_status(_: str = Depends(current_user)):
    entry = await _analysis_entry_async()
    return await asyncio.to_thread(realtime_status, entry.customers)


@app.post("/api/v1/demo/generate", response_model=RealtimeEvent)
async def generate_demo_event(
    payload: DemoGenerateRequest, _: str = Depends(current_user)
):
    entry = await _analysis_entry_async()
    try:
        return await asyncio.to_thread(
            process_demo_event,
            entry.customers,
            scenario=payload.scenario,
            customer_id=payload.customerId,
            event_id=payload.eventId,
        )
    except RuntimeError as error:
        if str(error) == "rate_limited":
            raise HTTPException(
                status_code=429, detail="Слишком много событий за минуту"
            ) from error
        raise
    except ValueError as error:
        status = 404 if "не найден" in str(error) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error


@app.post(
    "/api/v1/demo/simulator/start", response_model=SimulatorActionResponse
)
async def start_demo_simulator(
    payload: SimulatorStartRequest, _: str = Depends(current_user)
):
    status = simulator_for().start(
        interval_seconds=payload.intervalSeconds,
        scenario=payload.scenario,
        customers_provider=lambda: _analyzed_data()[0],
    )
    return {"ok": True, "simulator": status}


@app.post(
    "/api/v1/demo/simulator/stop", response_model=SimulatorActionResponse
)
async def stop_demo_simulator(_: str = Depends(current_user)):
    # stop() briefly joins the simulator thread; keep that wait off the loop.
    simulator = simulator_for()
    return {"ok": True, "simulator": await asyncio.to_thread(simulator.stop)}


@app.post("/api/v1/demo/reset", response_model=DemoResetResponse)
async def reset_demo(_: str = Depends(current_user)):
    deleted = await asyncio.to_thread(reset_demo_data)
    return {"ok": True, "deleted": deleted}


@app.get("/api/v1/realtime/events", response_model=RealtimeEventListResponse)
async def get_realtime_events(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    severity: Literal["critical", "warning", "info"] | None = None,
    event_type: str | None = Query(default=None, max_length=80),
    customer_id: str | None = Query(default=None, max_length=160),
    mode: Literal["DEMO", "LIVE"] | None = None,
    source: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=160),
    _: str = Depends(current_user),
):
    return await asyncio.to_thread(
        list_realtime_events,
        limit=limit,
        offset=offset,
        severity=severity,
        event_type=event_type,
        customer_id=customer_id,
        mode=mode,
        source=source,
        query=q,
    )


@app.get(
    "/api/v1/realtime/customers/{customer_id}/history",
    response_model=CustomerRealtimeHistoryResponse,
)
async def get_customer_realtime_history(
    customer_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    _: str = Depends(current_user),
):
    return await asyncio.to_thread(customer_realtime_history, customer_id, limit)


@app.get(
    "/api/v1/realtime/dashboard", response_model=RealtimeDashboardResponse
)
async def get_realtime_dashboard(
    hours: int = Query(default=24, ge=1, le=720),
    _: str = Depends(current_user),
):
    entry = await _analysis_entry_async()
    return await asyncio.to_thread(realtime_dashboard, entry.customers, hours)


@app.get(
    "/api/v1/realtime/templates", response_model=ReactionTemplateListResponse
)
async def get_realtime_templates(_: str = Depends(current_user)):
    return {"items": await asyncio.to_thread(list_reaction_templates)}


@app.patch(
    "/api/v1/realtime/templates/{template_id}", response_model=ReactionTemplate
)
async def patch_realtime_template(
    template_id: str,
    payload: ReactionTemplatePatch,
    _: str = Depends(current_user),
):
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Нет изменений шаблона")
    template = await asyncio.to_thread(update_reaction_template, template_id, changes)
    if template is None:
        raise HTTPException(status_code=404, detail="Шаблон реакции не найден")
    return template


@app.get("/api/v1/realtime/outbox", response_model=ReactionOutboxResponse)
async def get_realtime_outbox(
    limit: int = Query(default=50, ge=1, le=200),
    _: str = Depends(current_user),
):
    return {"items": await asyncio.to_thread(list_reaction_outbox, limit)}


def _sse_realtime_event(event: dict[str, Any]) -> str:
    return (
        f"id: {int(event['id'])}\n"
        f"event: realtime_event\n"
        f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    )


@app.get("/api/v1/realtime/stream")
async def realtime_stream(
    request: Request,
    last_event_id: int = Query(default=0, ge=0),
    _: str = Depends(current_user),
):
    """Replayable SSE feed for persisted DEMO/LIVE realtime events."""
    try:
        header_cursor = int(request.headers.get("last-event-id", "0"))
    except (TypeError, ValueError):
        header_cursor = 0
    initial_cursor = max(last_event_id, header_cursor)
    workspace_target = active_database_target()

    async def generate():
        set_active_database_target(workspace_target)
        cursor = initial_cursor
        if cursor == 0:
            cursor = await asyncio.to_thread(latest_realtime_event_id)
            yield _sse_event("ready", {"lastEventId": cursor, "mode": "replayable"})
        else:
            replay = await asyncio.to_thread(realtime_events_after, cursor)
            for event in replay:
                cursor = max(cursor, int(event["id"]))
                yield _sse_realtime_event(event)
        heartbeat_ticks = 0
        while not await request.is_disconnected():
            fresh = await asyncio.to_thread(realtime_events_after, cursor)
            for event in fresh:
                cursor = max(cursor, int(event["id"]))
                yield _sse_realtime_event(event)
            heartbeat_ticks += 1
            if heartbeat_ticks >= 15:
                heartbeat_ticks = 0
                yield ": heartbeat\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _get_weights_sync() -> dict[str, float]:
    with db() as connection:
        return get_weights(connection)


def _update_weights_sync(weights: dict[str, float]) -> dict[str, float]:
    with db() as connection:
        return update_weights(connection, weights)


def _replace_snapshot_sync(payload: SnapshotRequest) -> int:
    with db() as connection:
        return replace_snapshot(
            connection,
            payload.model_dump(),
            already_normalized=True,
        )


@app.get("/api/v1/model/settings", response_model=ModelSettingsResponse)
async def get_settings(_: str = Depends(current_user)):
    weights = await asyncio.to_thread(_get_weights_sync)
    return {
        "weights": weights,
        "features": FEATURE_LABELS,
        "thresholds": RISK_THRESHOLDS,
        "horizonMonths": 3,
    }


@app.patch("/api/v1/model/settings", response_model=ModelSettingsResponse)
async def patch_settings(payload: SettingsPatch, _: str = Depends(current_user)):
    unknown = set(payload.weights) - set(DEFAULT_WEIGHTS)
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Неизвестные признаки: {', '.join(sorted(unknown))}",
        )
    weights = await asyncio.to_thread(_update_weights_sync, payload.weights)
    return {
        "weights": weights,
        "features": FEATURE_LABELS,
        "thresholds": RISK_THRESHOLDS,
        "horizonMonths": 3,
    }


@app.put("/api/v1/source/snapshot", response_model=SnapshotResponse)
async def put_snapshot(payload: SnapshotRequest, _: str = Depends(current_user)):
    try:
        count = await asyncio.to_thread(_replace_snapshot_sync, payload)
    except SnapshotValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    logger.info("Source snapshot replaced; accounts=%s", count)
    return {"ok": True, "accountCount": count}


def _metrics_text() -> str:
    entry = _analysis_entry()
    customers = entry.customers
    data = entry.aggregate
    timeline = _timeline_for(entry)
    timeline_totals = timeline["totals"]
    rated_scores = [
        customer["score"] for customer in customers if customer["score"] is not None
    ]
    average_score = (
        sum(rated_scores) / len(rated_scores) if rated_scores else 0.0
    )
    unread_alerts, critical_alerts = notification_counts()
    rescue_totals = _rescue_queue_for(entry, limit=1000, minimum_score=65)[
        "totals"
    ]
    realtime_metrics = realtime_metric_counts()
    lines = [
        "# HELP churn_customers_total Customers by churn risk level",
        "# TYPE churn_customers_total gauge",
        f'churn_customers_total{{risk="high"}} {data["highRisk"]}',
        f'churn_customers_total{{risk="medium"}} {data["mediumRisk"]}',
        f'churn_customers_total{{risk="low"}} {data["lowRisk"]}',
        f'churn_customers_total{{risk="unrated"}} {data["unratedCount"]}',
        "# HELP churn_estimated_loss_eur Potential three-month revenue loss in euros",
        "# TYPE churn_estimated_loss_eur gauge",
        f"churn_estimated_loss_eur {data['estimatedLoss'] / 100:.2f}",
        "# HELP churn_monthly_revenue_at_risk_eur Risk-weighted monthly revenue in euros",
        "# TYPE churn_monthly_revenue_at_risk_eur gauge",
        f"churn_monthly_revenue_at_risk_eur {data['monthlyRevenueAtRisk'] / 100:.2f}",
        "# HELP churn_average_score Mean risk score of rated customers",
        "# TYPE churn_average_score gauge",
        f"churn_average_score {average_score:.2f}",
        "# HELP churn_services_at_risk Services awaiting payment or expiring without autoprolong",
        "# TYPE churn_services_at_risk gauge",
        f"churn_services_at_risk {data['atRiskServices']}",
        "# HELP churn_services_at_risk_30d Services at risk in the next 30 days (timeline forecast)",
        "# TYPE churn_services_at_risk_30d gauge",
        f"churn_services_at_risk_30d {timeline_totals['servicesAtRisk30d']}",
        "# HELP churn_expected_nonrenewals_30d Risk-weighted expected non-renewals in 30 days",
        "# TYPE churn_expected_nonrenewals_30d gauge",
        f"churn_expected_nonrenewals_30d {timeline_totals['expectedNonRenewals30d']:.2f}",
        "# HELP churn_deleted_services_90d Services deleted in the last 90 days (timeline fact)",
        "# TYPE churn_deleted_services_90d gauge",
        f"churn_deleted_services_90d {timeline_totals['deleted90d']}",
        "# HELP churn_forecast_services Services expected to churn by horizon day N",
        "# TYPE churn_forecast_services gauge",
        *[
            f'churn_forecast_services{{horizon_days="{day}"}} {count}'
            for day, count in zip(
                data["churnForecast"]["days"], data["churnForecast"]["counts"]
            )
        ],
        "# HELP churn_unread_alerts Unread realtime risk notifications",
        "# TYPE churn_unread_alerts gauge",
        f"churn_unread_alerts {unread_alerts}",
        "# HELP churn_critical_alerts Unread active critical risk notifications",
        "# TYPE churn_critical_alerts gauge",
        f"churn_critical_alerts {critical_alerts}",
        "# HELP churn_rescue_value_eur Expected value of the current rescue queue in euros",
        "# TYPE churn_rescue_value_eur gauge",
        f"churn_rescue_value_eur {rescue_totals['rescueValue'] / 100:.2f}",
        "# HELP churn_realtime_events_total Persisted realtime events by mode",
        "# TYPE churn_realtime_events_total gauge",
        f'churn_realtime_events_total{{mode="DEMO"}} {realtime_metrics["demo_events"]}',
        f'churn_realtime_events_total{{mode="LIVE"}} {realtime_metrics["live_events"]}',
        "# HELP churn_demo_simulator_running Whether the DEMO event simulator is running",
        "# TYPE churn_demo_simulator_running gauge",
        f'churn_demo_simulator_running {realtime_metrics["simulator_running"]}',
        "# HELP churn_reaction_outbox Reaction outbox messages by delivery status",
        "# TYPE churn_reaction_outbox gauge",
        f'churn_reaction_outbox{{status="simulated_sent"}} {realtime_metrics["simulated_sent"]}',
        f'churn_reaction_outbox{{status="queued"}} {realtime_metrics["queued"]}',
        f'churn_reaction_outbox{{status="no_channel"}} {realtime_metrics["no_channel"]}',
        "",
    ]
    return "\n".join(lines)


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(
        await asyncio.to_thread(_metrics_text),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


@app.get("/health", include_in_schema=False)
async def health():
    try:
        await asyncio.to_thread(_database_healthcheck)
    except DatabaseError:
        logger.exception("Health check failed while reading the database")
        raise HTTPException(
            status_code=503, detail="Хранилище временно недоступно"
        ) from None
    return {"status": "ok"}
