from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from threading import RLock
from typing import Any, Literal

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
    events_after,
    latest_event_id,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    notification_counts,
    sync_alerts,
)
from .config import (
    MAX_SNAPSHOT_BYTES,
    SESSION_DAYS,
    STATIC_DIR,
    TEMPLATES_DIR,
)
from .domain import (
    DEFAULT_WEIGHTS,
    FEATURE_LABELS,
    RISK_THRESHOLDS,
    analyze,
    churn_timeline,
    iso,
    rescue_queue,
    summary,
    utcnow,
)
from .realtime import (
    customer_realtime_history,
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
    update_reaction_template,
)
from .realtime import (
    simulator as demo_simulator,
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
    RescueQueueResponse,
    SettingsPatch,
    SimulatorActionResponse,
    SimulatorStartRequest,
    SnapshotRequest,
    SnapshotResponse,
)
from .security import verify_admin
from .storage import (
    SnapshotValidationError,
    clear_login_failures,
    db,
    get_weights,
    init_db,
    load_source,
    login_rate_limited,
    record_login_failure,
    replace_snapshot,
    update_weights,
)

logger = logging.getLogger("churnrisk")
session_cookie = APIKeyCookie(
    name="churn_session", auto_error=False, scheme_name="AdminSession"
)
_analysis_cache_lock = RLock()
_analysis_cache: (
    tuple[tuple[int, int], float, list[dict[str, Any]], dict[str, Any]] | None
) = None


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
                if path.startswith("/api/v1/") or path in {"/", "/login", "/metrics"}:
                    response_headers.extend(
                        [
                            (b"cache-control", b"no-store"),
                            (b"pragma", b"no-cache"),
                        ]
                    )
                message["headers"] = response_headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if not os.getenv("ADMIN_PASSWORD"):
        logger.warning(
            "ADMIN_PASSWORD is not configured; login will remain unavailable"
        )
    yield


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


async def _username_for_token(token: str | None) -> str:
    if not token:
        raise HTTPException(status_code=401, detail="Требуется вход")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with db() as connection:
        row = connection.execute(
            "SELECT username, expires_at FROM sessions WHERE token_hash=?",
            (token_hash,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Сессия не найдена")
        expires = datetime.fromisoformat(row["expires_at"])
        if expires <= utcnow():
            raise HTTPException(status_code=401, detail="Сессия истекла")
    return str(row["username"])


def _basic_auth_username(request: Request) -> str | None:
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
    if not verify_admin(username, password):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    return os.getenv("ADMIN_USERNAME", "admin").strip()


async def current_user(
    request: Request, token: str | None = Security(session_cookie)
) -> str:
    basic_username = _basic_auth_username(request)
    if basic_username is not None:
        return basic_username
    return await _username_for_token(token)


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


def _analyzed_data() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    global _analysis_cache
    with db() as connection:
        versions = connection.execute(
            "SELECT key, value FROM metadata WHERE key IN ('snapshot_version', 'model_version')"
        ).fetchall()
        version_map = {row["key"]: int(row["value"]) for row in versions}
        cache_key = (
            version_map.get("snapshot_version", 0),
            version_map.get("model_version", 0),
        )
        now = time.monotonic()
        with _analysis_cache_lock:
            cached = _analysis_cache
            if cached and cached[0] == cache_key and now - cached[1] < 10:
                return cached[2], cached[3]
        customers = analyze(load_source(connection), get_weights(connection))
    aggregate = summary(customers)
    with _analysis_cache_lock:
        _analysis_cache = (cache_key, now, customers, aggregate)
    _sync_realtime_alerts(customers, aggregate)
    return customers, aggregate


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


def _create_session(username: str) -> tuple[str, datetime]:
    """Create a server-side session; shared by password and OIDC login."""
    token = secrets.token_urlsafe(36)
    expires_at = utcnow() + timedelta(days=SESSION_DAYS)
    with db() as connection:
        connection.execute(
            "DELETE FROM sessions WHERE expires_at < ?", (iso(utcnow()),)
        )
        connection.execute(
            "INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)",
            (
                hashlib.sha256(token.encode("utf-8")).hexdigest(),
                username,
                iso(expires_at),
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


@app.get("/api/v1/auth/providers", response_model=AuthProvidersResponse)
async def auth_providers():
    """Public: which login methods the panel should offer."""
    config = oidc_service.load_config()
    return {
        "password": bool(os.getenv("ADMIN_PASSWORD")),
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
        discovery = oidc_service.discover(config.issuer)
    except oidc_service.OidcError:
        raise HTTPException(
            status_code=502, detail="OIDC провайдер недоступен"
        ) from None
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = oidc_service.code_verifier()
    expires_at = utcnow() + timedelta(minutes=10)
    with db() as connection:
        connection.execute(
            "DELETE FROM oidc_states WHERE expires_at < ?", (iso(utcnow()),)
        )
        connection.execute(
            "INSERT INTO oidc_states (state_hash, nonce, code_verifier, expires_at)"
            " VALUES (?, ?, ?, ?)",
            (
                hashlib.sha256(state.encode("utf-8")).hexdigest(),
                nonce,
                verifier,
                iso(expires_at),
            ),
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
    with db() as connection:
        row = connection.execute(
            "SELECT nonce, code_verifier, expires_at FROM oidc_states"
            " WHERE state_hash=?",
            (state_hash,),
        ).fetchone()
        connection.execute("DELETE FROM oidc_states WHERE state_hash=?", (state_hash,))
    if row is None or datetime.fromisoformat(row["expires_at"]) <= utcnow():
        return RedirectResponse("/login?oidc_error=1", status_code=303)
    try:
        discovery = oidc_service.discover(config.issuer)
        claims = oidc_service.exchange_and_verify(
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
    token, _expires = _create_session(username)
    response = RedirectResponse("/", status_code=303)
    _set_session_cookie(response, token)
    return response


@app.post("/api/v1/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, response: Response):
    remote_host = request.client.host if request.client else "unknown"
    rate_key = hashlib.sha256(remote_host.encode("utf-8")).hexdigest()
    limited, retry_after = login_rate_limited(rate_key)
    if limited:
        raise HTTPException(
            status_code=429,
            detail="Слишком много попыток входа. Повторите позже.",
            headers={"Retry-After": str(retry_after)},
        )

    if not verify_admin(payload.username, payload.password):
        record_login_failure(rate_key)
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    clear_login_failures(rate_key)
    username = os.getenv("ADMIN_USERNAME", "admin").strip()
    token, expires_at = _create_session(username)
    _set_session_cookie(response, token)
    return {"username": username, "expiresAt": iso(expires_at)}


@app.get("/api/v1/auth/me")
async def me(username: str = Depends(current_user)):
    return {"username": username}


@app.post("/api/v1/auth/logout")
async def logout(response: Response, request: Request, _: str = Depends(current_user)):
    token = request.cookies.get("churn_session", "")
    with db() as connection:
        connection.execute(
            "DELETE FROM sessions WHERE token_hash=?",
            (hashlib.sha256(token.encode("utf-8")).hexdigest(),),
        )
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
    items, _ = _analyzed_data()
    if risk is not None:
        items = [customer for customer in items if customer["riskLevel"] == risk]

    def key(customer: dict[str, Any]) -> Any:
        value = customer[sort]
        if sort == "id":
            from decimal import Decimal, InvalidOperation

            try:
                return (0, Decimal(str(value)))
            except InvalidOperation:
                return (1, str(value).casefold())
        if sort == "email":
            return str(value).casefold()
        return value if value is not None else 0

    rated = [customer for customer in items if customer[sort] is not None]
    unrated = [customer for customer in items if customer[sort] is None]
    rated.sort(key=key, reverse=order == "desc")
    sorted_items = rated + unrated
    page = [
        _public_customer(customer) for customer in sorted_items[offset : offset + limit]
    ]
    return {"items": page, "total": len(sorted_items)}


@app.get("/api/v1/customers/{customer_id}", response_model=CustomerResponse)
async def customer_detail(customer_id: str, _: str = Depends(current_user)):
    items, _ = _analyzed_data()
    for customer in items:
        if customer["id"] == customer_id:
            return _public_customer(customer)
    raise HTTPException(status_code=404, detail="Клиент не найден")


@app.get("/api/v1/analytics/summary", response_model=AnalyticsSummary)
async def analytics_summary(_: str = Depends(current_user)):
    _, data = _analyzed_data()
    return {**data, "currency": "EUR", "unit": "eurocents"}


@app.get(
    "/api/v1/analytics/churn-timeline", response_model=ChurnTimelineResponse
)
async def analytics_churn_timeline(_: str = Depends(current_user)):
    customers, _data = _analyzed_data()
    return churn_timeline(customers)


@app.get("/api/v1/analytics/rescue-queue", response_model=RescueQueueResponse)
async def analytics_rescue_queue(
    limit: int = Query(default=10, ge=1, le=100),
    minimum_score: int = Query(default=65, ge=0, le=100),
    _: str = Depends(current_user),
):
    customers, _data = _analyzed_data()
    with db() as connection:
        weights = get_weights(connection)
    return rescue_queue(
        customers, weights=weights, limit=limit, minimum_score=minimum_score
    )


@app.get("/api/v1/notifications", response_model=NotificationListResponse)
async def get_notifications(
    limit: int = Query(default=30, ge=1, le=100),
    unread_only: bool = False,
    _: str = Depends(current_user),
):
    # Touch the analysis first so a cold panel sees the monitor's current
    # episodes instead of an empty table until some other endpoint runs.
    _analyzed_data()
    return list_notifications(limit=limit, unread_only=unread_only)


@app.post(
    "/api/v1/notifications/read-all", response_model=NotificationReadResponse
)
async def read_all_notifications(_: str = Depends(current_user)):
    updated = mark_all_notifications_read()
    unread, _critical = notification_counts()
    return {"ok": True, "updatedCount": updated, "unreadCount": unread}


@app.post(
    "/api/v1/notifications/{notification_id}/read",
    response_model=NotificationReadResponse,
)
async def read_notification(
    notification_id: int, _: str = Depends(current_user)
):
    notification = mark_notification_read(notification_id)
    if notification is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    unread, _critical = notification_counts()
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

    async def generate():
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
    customers, _data = _analyzed_data()
    return await asyncio.to_thread(realtime_status, customers)


@app.post("/api/v1/demo/generate", response_model=RealtimeEvent)
async def generate_demo_event(
    payload: DemoGenerateRequest, _: str = Depends(current_user)
):
    customers, _data = _analyzed_data()
    try:
        return await asyncio.to_thread(
            process_demo_event,
            customers,
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
    status = demo_simulator.start(
        interval_seconds=payload.intervalSeconds,
        scenario=payload.scenario,
        customers_provider=lambda: _analyzed_data()[0],
    )
    return {"ok": True, "simulator": status}


@app.post(
    "/api/v1/demo/simulator/stop", response_model=SimulatorActionResponse
)
async def stop_demo_simulator(_: str = Depends(current_user)):
    return {"ok": True, "simulator": demo_simulator.stop()}


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
    customers, _data = _analyzed_data()
    return await asyncio.to_thread(realtime_dashboard, customers, hours)


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

    async def generate():
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


@app.get("/api/v1/model/settings", response_model=ModelSettingsResponse)
async def get_settings(_: str = Depends(current_user)):
    with db() as connection:
        weights = get_weights(connection)
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
    with db() as connection:
        weights = update_weights(connection, payload.weights)
    return {
        "weights": weights,
        "features": FEATURE_LABELS,
        "thresholds": RISK_THRESHOLDS,
        "horizonMonths": 3,
    }


@app.put("/api/v1/source/snapshot", response_model=SnapshotResponse)
async def put_snapshot(payload: SnapshotRequest, _: str = Depends(current_user)):
    try:
        with db() as connection:
            count = replace_snapshot(connection, payload.model_dump())
    except SnapshotValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    logger.info("Source snapshot replaced; accounts=%s", count)
    return {"ok": True, "accountCount": count}


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    customers, data = _analyzed_data()
    timeline = churn_timeline(customers)
    timeline_totals = timeline["totals"]
    rated_scores = [
        customer["score"] for customer in customers if customer["score"] is not None
    ]
    average_score = (
        sum(rated_scores) / len(rated_scores) if rated_scores else 0.0
    )
    unread_alerts, critical_alerts = notification_counts()
    with db() as connection:
        rescue_totals = rescue_queue(
            customers, weights=get_weights(connection), limit=1000
        )["totals"]
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
    return PlainTextResponse(
        "\n".join(lines), media_type="text/plain; version=0.0.4; charset=utf-8"
    )


@app.get("/health", include_in_schema=False)
async def health():
    try:
        with db() as connection:
            connection.execute("SELECT 1").fetchone()
    except sqlite3.Error:
        logger.exception("Health check failed while reading the database")
        raise HTTPException(
            status_code=503, detail="Хранилище временно недоступно"
        ) from None
    return {"status": "ok"}
