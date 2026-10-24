from __future__ import annotations

import hashlib
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
)
from fastapi.security import APIKeyCookie
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

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
    iso,
    summary,
    utcnow,
)
from .schemas import (
    AnalyticsSummary,
    CustomerListResponse,
    CustomerResponse,
    LoginRequest,
    LoginResponse,
    ModelSettingsResponse,
    SettingsPatch,
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


async def current_user(token: str | None = Security(session_cookie)) -> str:
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
    response.set_cookie(
        "churn_session",
        token,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false").strip().casefold() == "true",
        samesite="lax",
        max_age=SESSION_DAYS * 86400,
        path="/",
    )
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
    _, data = _analyzed_data()
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
