from __future__ import annotations

import json
import os
import random
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any, Protocol

from .alerts import _insert_event, ensure_alert_tables
from .database import (
    Connection,
    DatabaseError,
    Row,
    acquire_schema_lock,
    mark_schema_ready,
    schema_is_ready,
)
from .domain import RISK_THRESHOLDS, iso, parse_date, rescue_queue, utcnow
from .storage import db, load_account

DEMO_SCENARIOS = (
    "NORMAL_ACTIVITY",
    "ACTIVITY_DROP",
    "CHURN_RISK_SPIKE",
    "HIGH_RISK_THRESHOLD",
    "CUSTOMER_RECOVERY",
    "NEW_CUSTOMER_ACTIVITY",
)
SCENARIO_LABELS = {
    "NORMAL_ACTIVITY": "Обычная активность",
    "ACTIVITY_DROP": "Резкое падение активности",
    "CHURN_RISK_SPIKE": "Скачок риска оттока",
    "HIGH_RISK_THRESHOLD": "Пересечение порога высокого риска",
    "CUSTOMER_RECOVERY": "Восстановление клиента",
    "NEW_CUSTOMER_ACTIVITY": "Активность нового клиента",
    "MIXED": "Chaos Mix — случайный сценарий",
}
CRITICAL_SCORE = 80
SIGNIFICANT_DELTA = 10
NOTIFICATION_COOLDOWN_SECONDS = 300
MAX_EVENTS_PER_MINUTE = 120
_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}
_rng = random.SystemRandom()


class SourceUnavailable(RuntimeError):
    """Raised by prepared but not configured live source adapters."""


class EventSourceAdapter(Protocol):
    name: str

    def status(self) -> dict[str, Any]:
        ...

    def poll(self) -> list[dict[str, Any]]:
        ...


class DemoEventSource:
    name = "demo"

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": "DEMO generator",
            "configured": True,
            "available": True,
            "mode": "DEMO",
            "message": "Искусственные события проходят полный backend-путь и помечены DEMO.",
        }

    def poll(self) -> list[dict[str, Any]]:
        return []


class ApiEventSource:
    name = "api"

    def status(self) -> dict[str, Any]:
        configured = bool(os.getenv("REALTIME_API_URL", "").strip())
        return {
            "name": self.name,
            "label": "External/internal API adapter",
            "configured": configured,
            "available": False,
            "mode": "LIVE",
            "message": (
                "REALTIME_API_URL задан, но polling-адаптер ещё не включён."
                if configured
                else "REALTIME_API_URL не задан — LIVE API не подключён."
            ),
        }

    def poll(self) -> list[dict[str, Any]]:
        raise SourceUnavailable(self.status()["message"])


class StreamEventSource:
    name = "stream"

    def status(self) -> dict[str, Any]:
        configured = bool(os.getenv("REALTIME_STREAM_URL", "").strip())
        return {
            "name": self.name,
            "label": "Event stream adapter",
            "configured": configured,
            "available": False,
            "mode": "LIVE",
            "message": (
                "REALTIME_STREAM_URL задан, но stream-адаптер ещё не включён."
                if configured
                else "REALTIME_STREAM_URL не задан — LIVE stream не подключён."
            ),
        }

    def poll(self) -> list[dict[str, Any]]:
        raise SourceUnavailable(self.status()["message"])


SOURCE_ADAPTERS: tuple[EventSourceAdapter, ...] = (
    DemoEventSource(),
    ApiEventSource(),
    StreamEventSource(),
)


def ensure_realtime_tables(connection: Connection) -> None:
    if schema_is_ready(connection, "realtime"):
        return
    acquire_schema_lock(connection)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS demo_customer_state (
            customer_id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            is_demo_customer INTEGER NOT NULL DEFAULT 0,
            activity_index REAL NOT NULL,
            sessions_7d REAL NOT NULL,
            risk_modifier REAL NOT NULL DEFAULT 0,
            contacts TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS realtime_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            source TEXT NOT NULL,
            mode TEXT NOT NULL,
            scenario TEXT,
            customer_id TEXT,
            customer_email TEXT,
            timestamp TEXT NOT NULL,
            severity TEXT NOT NULL,
            previous_risk_score REAL,
            risk_score REAL NOT NULL,
            risk_percent INTEGER NOT NULL,
            risk_level TEXT NOT NULL,
            risk_delta REAL NOT NULL,
            reason TEXT NOT NULL,
            reasons TEXT NOT NULL DEFAULT '[]',
            details TEXT NOT NULL DEFAULT '{}',
            processed INTEGER NOT NULL DEFAULT 1,
            notification_created INTEGER NOT NULL DEFAULT 0,
            notification_id INTEGER,
            suppressed_reason TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS realtime_events_customer_idx
            ON realtime_events(customer_id, id DESC);
        CREATE INDEX IF NOT EXISTS realtime_events_created_idx
            ON realtime_events(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS realtime_events_mode_created_idx
            ON realtime_events(mode, created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS risk_calculations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            customer_id TEXT NOT NULL,
            base_score REAL,
            demo_modifier REAL NOT NULL DEFAULT 0,
            previous_risk_score REAL,
            risk_score REAL NOT NULL,
            risk_percent INTEGER NOT NULL,
            risk_level TEXT NOT NULL,
            risk_delta REAL NOT NULL,
            reasons TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL,
            mode TEXT NOT NULL,
            is_demo INTEGER NOT NULL DEFAULT 1,
            calculated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS risk_calculations_customer_idx
            ON risk_calculations(customer_id, id DESC);
        CREATE INDEX IF NOT EXISTS risk_calculations_calculated_idx
            ON risk_calculations(calculated_at, id);
        CREATE TABLE IF NOT EXISTS reaction_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            trigger_types TEXT NOT NULL,
            min_severity TEXT NOT NULL,
            channel_strategy TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            cooldown_seconds INTEGER NOT NULL DEFAULT 3600,
            priority INTEGER NOT NULL DEFAULT 100,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reaction_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            template_id TEXT NOT NULL,
            customer_id TEXT,
            channel TEXT NOT NULL,
            recipient TEXT,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            mode TEXT NOT NULL,
            created_at TEXT NOT NULL,
            sent_at TEXT,
            error TEXT,
            UNIQUE(event_id, template_id, channel)
        );
        CREATE INDEX IF NOT EXISTS reaction_outbox_created_idx
            ON reaction_outbox(created_at DESC, id DESC);
        """
    )
    _seed_templates(connection)
    mark_schema_ready(connection, "realtime")


def _seed_templates(connection: Connection) -> None:
    now = iso(utcnow())
    templates = [
        (
            "payment_reminder",
            "Напоминание о списании и пополнении",
            ["high_risk_threshold_crossed", "churn_risk_increased", "activity_drop"],
            "warning",
            "social_first",
            "Скоро списание Aéza: не дайте услуге остановиться",
            "Здравствуйте! Заметили риск по аккаунту {email}: сейчас {risk_percent} из 100. {action_hint} Если нужна помощь с оплатой или автопродлением — ответьте на это сообщение, и мы подскажем следующий шаг.",
            10,
        ),
        (
            "activity_winback",
            "Мягкий winback при падении активности",
            ["activity_drop"],
            "warning",
            "social_first",
            "Мы заметили, что вы стали реже заходить",
            "Здравствуйте! Активность аккаунта {email} заметно снизилась. Подсказать, как быстро проверить услуги, баланс и автопродление, чтобы ничего не остановилось в неудобный момент?",
            20,
        ),
        (
            "recovery_checkin",
            "Поддержка после восстановления",
            ["customer_recovered"],
            "info",
            "social_first",
            "Рады, что вы снова с нами",
            "Здравствуйте! Видим, что активность аккаунта {email} восстановилась, а риск снизился до {risk_percent}. Если хотите, поможем включить автопродление и убрать рутину с оплатами.",
            30,
        ),
        (
            "new_customer_welcome",
            "Приветствие нового клиента",
            ["new_customer_activity"],
            "info",
            "social_first",
            "Добро пожаловать в Aéza",
            "Здравствуйте! Увидели первую активность аккаунта {email}. Помочь настроить автопродление и уведомления о балансе, чтобы услуги не прерывались?",
            40,
        ),
    ]
    for template_id, name, triggers, severity, strategy, subject, body, priority in templates:
        connection.execute(
            """
            INSERT OR IGNORE INTO reaction_templates (
                id, name, trigger_types, min_severity, channel_strategy,
                subject, body, enabled, cooldown_seconds, priority, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 3600, ?, ?)
            """,
            (
                template_id,
                name,
                json.dumps(triggers),
                severity,
                strategy,
                subject,
                body,
                priority,
                now,
            ),
        )


def _json(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    try:
        parsed = json.loads(value or "")
    except (json.JSONDecodeError, TypeError):
        return fallback
    return parsed


def _serialize_event(row: Row, actions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "eventId": row["event_id"],
        "type": row["type"],
        "source": row["source"],
        "mode": row["mode"],
        "scenario": row["scenario"],
        "customerId": row["customer_id"],
        "customerEmail": row["customer_email"],
        "timestamp": row["timestamp"],
        "severity": row["severity"],
        "previousRiskScore": row["previous_risk_score"],
        "riskScore": row["risk_score"],
        "riskPercent": int(row["risk_percent"]),
        "riskLevel": row["risk_level"],
        "riskDelta": row["risk_delta"],
        "reason": row["reason"],
        "reasons": _json(row["reasons"], []),
        "details": _json(row["details"], {}),
        "processed": bool(row["processed"]),
        "notificationCreated": bool(row["notification_created"]),
        "notificationId": row["notification_id"],
        "suppressedReason": row["suppressed_reason"],
        "actions": actions or [],
        "createdAt": row["created_at"],
    }


def _serialize_template(row: Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "triggerTypes": _json(row["trigger_types"], []),
        "minSeverity": row["min_severity"],
        "channelStrategy": row["channel_strategy"],
        "subject": row["subject"],
        "body": row["body"],
        "enabled": bool(row["enabled"]),
        "cooldownSeconds": int(row["cooldown_seconds"]),
        "priority": int(row["priority"]),
        "updatedAt": row["updated_at"],
    }


def _serialize_outbox(row: Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "eventId": row["event_id"],
        "templateId": row["template_id"],
        "customerId": row["customer_id"],
        "channel": row["channel"],
        "recipient": row["recipient"],
        "subject": row["subject"],
        "body": row["body"],
        "status": row["status"],
        "mode": row["mode"],
        "createdAt": row["created_at"],
        "sentAt": row["sent_at"],
        "error": row["error"],
    }


def _contacts_from_account(account: dict[str, Any] | None, email: str | None) -> dict[str, str]:
    contacts: dict[str, str] = {}
    if account:
        socials = account.get("socials") if isinstance(account.get("socials"), dict) else {}
        candidates = {
            "email": account.get("email"),
            "telegram": account.get("telegram") or socials.get("telegram"),
            "whatsapp": account.get("whatsapp") or socials.get("whatsapp"),
            "vk": account.get("vk") or socials.get("vk"),
        }
        for key, value in candidates.items():
            if isinstance(value, str) and value.strip():
                contacts[key] = value.strip()
    if email and "email" not in contacts and "@" in email:
        contacts["email"] = email
    return contacts


def _source_account(
    connection: Connection, account_id: str
) -> dict[str, Any] | None:
    try:
        return load_account(connection, account_id)
    except (OSError, ValueError, DatabaseError):
        return None


def _risk_level(percent: int) -> str:
    if percent >= RISK_THRESHOLDS["high"]:
        return "high"
    if percent >= RISK_THRESHOLDS["medium"]:
        return "medium"
    return "low"


def _scenario_event_type(scenario: str) -> str:
    return {
        "NORMAL_ACTIVITY": "activity_observed",
        "ACTIVITY_DROP": "activity_drop",
        "CHURN_RISK_SPIKE": "churn_risk_increased",
        "HIGH_RISK_THRESHOLD": "high_risk_threshold_crossed",
        "CUSTOMER_RECOVERY": "customer_recovered",
        "NEW_CUSTOMER_ACTIVITY": "new_customer_activity",
    }[scenario]


def _rate_limited(connection: Connection, now: datetime) -> bool:
    since = iso(now - timedelta(minutes=1))
    count = connection.execute(
        "SELECT COUNT(*) FROM realtime_events WHERE created_at >= ?", (since,)
    ).fetchone()[0]
    return int(count) >= MAX_EVENTS_PER_MINUTE


def _notification_on_cooldown(
    connection: Connection,
    customer_id: str | None,
    event_type: str,
    now: datetime,
) -> bool:
    if not customer_id:
        return False
    since = iso(now - timedelta(seconds=NOTIFICATION_COOLDOWN_SECONDS))
    row = connection.execute(
        """
        SELECT 1 FROM realtime_events
        WHERE customer_id=? AND type=? AND notification_created=1 AND created_at>=?
        LIMIT 1
        """,
        (customer_id, event_type, since),
    ).fetchone()
    return row is not None


def _render_template(text: str, context: dict[str, Any]) -> str:
    result = text
    for key, value in context.items():
        result = result.replace("{" + key + "}", str(value))
    return result


def _choose_channel(strategy: str, contacts: dict[str, str]) -> tuple[str, str | None]:
    social_order = ("telegram", "whatsapp", "vk")
    if strategy == "social_first":
        for channel in social_order:
            if contacts.get(channel):
                return channel, contacts[channel]
    if contacts.get("email"):
        return "email", contacts["email"]
    for channel in social_order:
        if contacts.get(channel):
            return channel, contacts[channel]
    return "none", None


def _create_reactions(
    connection: Connection,
    *,
    event_id: str,
    event_type: str,
    severity: str,
    customer_id: str | None,
    contacts: dict[str, str],
    context: dict[str, Any],
    mode: str,
    now: datetime,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT * FROM reaction_templates WHERE enabled=1 ORDER BY priority ASC"
    ).fetchall()
    for row in rows:
        template = _serialize_template(row)
        if event_type not in template["triggerTypes"]:
            continue
        if _SEVERITY_RANK.get(severity, 9) > _SEVERITY_RANK.get(template["minSeverity"], 9):
            continue
        if customer_id:
            since = iso(now - timedelta(seconds=template["cooldownSeconds"]))
            recent = connection.execute(
                """
                SELECT 1 FROM reaction_outbox
                WHERE customer_id=? AND template_id=? AND created_at>=? LIMIT 1
                """,
                (customer_id, template["id"], since),
            ).fetchone()
            if recent:
                return []
        channel, recipient = _choose_channel(template["channelStrategy"], contacts)
        status = "simulated_sent" if mode == "DEMO" and recipient else "queued"
        if not recipient:
            status = "no_channel"
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO reaction_outbox (
                event_id, template_id, customer_id, channel, recipient,
                subject, body, status, mode, created_at, sent_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                event_id,
                template["id"],
                customer_id,
                channel,
                recipient,
                _render_template(template["subject"], context),
                _render_template(template["body"], context),
                status,
                mode,
                iso(now),
                iso(now) if status == "simulated_sent" else None,
            ),
        )
        if cursor.rowcount and cursor.lastrowid:
            outbox = connection.execute(
                "SELECT * FROM reaction_outbox WHERE id=?", (cursor.lastrowid,)
            ).fetchone()
            return [_serialize_outbox(outbox)] if outbox else []
        return []
    return []


def process_demo_event(
    customers: list[dict[str, Any]],
    *,
    scenario: str,
    customer_id: str | None = None,
    event_id: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Validate, score, persist and optionally notify one DEMO event.

    DEMO activity lives in demo_customer_state. The real snapshot and
    model settings are read-only here, so reset can never touch live data.
    """
    if scenario not in DEMO_SCENARIOS:
        raise ValueError(f"Неизвестный DEMO-сценарий: {scenario}")
    moment = now or utcnow()
    generated_event_id = (event_id or f"evt_demo_{uuid.uuid4().hex[:16]}").strip()
    if not generated_event_id or len(generated_event_id) > 120:
        raise ValueError("event_id должен содержать от 1 до 120 символов")

    with db() as connection:
        ensure_realtime_tables(connection)
        ensure_alert_tables(connection)
        duplicate = connection.execute(
            "SELECT * FROM realtime_events WHERE event_id=?", (generated_event_id,)
        ).fetchone()
        if duplicate is not None:
            actions = [
                _serialize_outbox(row)
                for row in connection.execute(
                    "SELECT * FROM reaction_outbox WHERE event_id=? ORDER BY id",
                    (generated_event_id,),
                ).fetchall()
            ]
            return {**_serialize_event(duplicate, actions), "duplicate": True}
        if _rate_limited(connection, moment):
            raise RuntimeError("rate_limited")

        is_new_customer = scenario == "NEW_CUSTOMER_ACTIVITY" and not customer_id
        selected_id = customer_id
        base_customer: dict[str, Any] | None = None
        if is_new_customer:
            suffix = uuid.uuid4().hex[:8]
            selected_id = f"demo-{suffix}"
        elif selected_id:
            base_customer = next(
                (
                    customer
                    for customer in customers
                    if str(customer["id"]) == selected_id
                ),
                None,
            )
        else:
            rated = [c for c in customers if c.get("score") is not None]
            pool = rated or customers
            if not pool:
                raise ValueError("Нет клиентов для DEMO-события")
            base_customer = _rng.choice(pool)
            selected_id = str(base_customer["id"])
        assert selected_id is not None
        state_row = connection.execute(
            "SELECT * FROM demo_customer_state WHERE customer_id=?", (selected_id,)
        ).fetchone()
        if base_customer is None and state_row is None and not selected_id.startswith("demo-"):
            raise ValueError("Клиент для DEMO-события не найден")

        if base_customer is not None:
            email = str(base_customer.get("email") or "—")
            base_score = base_customer.get("score")
            base_percent = int(base_score) if base_score is not None else 30
            base_reasons = list(base_customer.get("reasons") or [])
            estimated_loss = round(float(base_customer.get("estimatedLoss") or 0))
            days_to_expiry = base_customer.get("daysToExpiry")
            contacts = _contacts_from_account(
                _source_account(connection, selected_id), email
            )
        else:
            email = str(state_row["email"]) if state_row else f"new.{selected_id}@example.test"
            base_percent = 28
            base_reasons = ["DEMO-профиль: live-услуг пока нет, оценка предварительная."]
            estimated_loss = 0
            days_to_expiry = None
            contacts = (
                _json(state_row["contacts"], {}) if state_row else {
                    "email": email,
                    "telegram": f"@{selected_id.replace('-', '_')}",
                }
            )

        if state_row is None:
            activity_before = 0.0 if is_new_customer else max(35.0, min(100.0, 110.0 - base_percent))
            sessions_before = 0.0 if is_new_customer else round(activity_before / 5, 1)
            modifier_before = 0.0
            connection.execute(
                """
                INSERT INTO demo_customer_state (
                    customer_id, email, is_demo_customer, activity_index,
                    sessions_7d, risk_modifier, contacts, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    selected_id,
                    email,
                    1 if base_customer is None else 0,
                    activity_before,
                    sessions_before,
                    json.dumps(contacts, ensure_ascii=False),
                    iso(moment),
                    iso(moment),
                ),
            )
        else:
            activity_before = float(state_row["activity_index"])
            sessions_before = float(state_row["sessions_7d"])
            modifier_before = float(state_row["risk_modifier"])
            stored_contacts = _json(state_row["contacts"], {})
            if stored_contacts:
                contacts = {**contacts, **stored_contacts}

        previous_calc = connection.execute(
            """
            SELECT risk_percent FROM risk_calculations
            WHERE customer_id=? ORDER BY id DESC LIMIT 1
            """,
            (selected_id,),
        ).fetchone()
        previous_percent = int(previous_calc[0]) if previous_calc else base_percent

        activity_after = activity_before
        sessions_after = sessions_before
        modifier_delta = 0.0
        reason = scenario.lower()
        event_reasons: list[str] = []
        details_extra: dict[str, Any] = {}
        if scenario == "NORMAL_ACTIVITY":
            activity_after = min(100.0, activity_before + 6)
            sessions_after = sessions_before * 1.1 + 1
            modifier_delta = -3
            event_reasons.append("DEMO: активность стабильна, демо-модификатор немного снижен.")
        elif scenario == "ACTIVITY_DROP":
            activity_after = max(5.0, activity_before - 55)
            sessions_after = sessions_before * 0.4
            modifier_delta = 24
            event_reasons.append("DEMO: активность резко упала, число сессий сократилось.")
        elif scenario == "CHURN_RISK_SPIKE":
            activity_after = max(5.0, activity_before - 35)
            sessions_after = sessions_before * 0.55
            modifier_delta = 34
            details_extra["failed_payment_signal"] = True
            event_reasons.append("DEMO: падение активности усилено сигналом незавершённого платежа.")
        elif scenario == "HIGH_RISK_THRESHOLD":
            activity_after = max(5.0, activity_before - 45)
            sessions_after = sessions_before * 0.45
            modifier_delta = max(18.0, 82 - previous_percent + 4)
            event_reasons.append("DEMO: сценарий доводит оценку через критический порог 80.")
        elif scenario == "CUSTOMER_RECOVERY":
            activity_after = min(100.0, activity_before + 48)
            sessions_after = sessions_before * 1.7 + 2
            modifier_delta = -32
            event_reasons.append("DEMO: активность и сессии восстановились.")
        elif scenario == "NEW_CUSTOMER_ACTIVITY":
            activity_after = 65.0
            sessions_after = 5.0
            modifier_delta = -4
            event_reasons.append("DEMO: первая активность нового клиента, live-истории ещё нет.")

        modifier_after = max(-35.0, min(70.0, modifier_before + modifier_delta))
        if scenario == "HIGH_RISK_THRESHOLD":
            # This scenario is the deterministic critical-path fixture: it
            # must cross 80 even when the live base score is currently low.
            target_percent = max(86, min(96, previous_percent + 20))
            modifier_after = float(target_percent - base_percent)
        risk_percent = max(0, min(100, round(base_percent + modifier_after)))
        risk_score = round(risk_percent / 100, 3)
        previous_score = round(previous_percent / 100, 3)
        risk_delta = round(risk_score - previous_score, 3)
        risk_level = _risk_level(risk_percent)
        event_type = _scenario_event_type(scenario)
        crossed_high = previous_percent < RISK_THRESHOLDS["high"] <= risk_percent
        crossed_critical = previous_percent < CRITICAL_SCORE <= risk_percent
        recovered = previous_percent >= RISK_THRESHOLDS["high"] > risk_percent or risk_delta <= -0.15
        activity_change = round(activity_after - activity_before, 1)
        if crossed_critical or risk_percent >= CRITICAL_SCORE:
            severity = "critical"
        elif crossed_high or risk_delta >= 0.15 or activity_change <= -40:
            severity = "warning"
        elif recovered or scenario in {"NORMAL_ACTIVITY", "NEW_CUSTOMER_ACTIVITY"}:
            severity = "info"
        else:
            severity = "warning" if abs(risk_delta) >= SIGNIFICANT_DELTA / 100 else "info"

        significant = bool(
            crossed_high
            or crossed_critical
            or abs(risk_delta) >= SIGNIFICANT_DELTA / 100
            or activity_change <= -40
            or recovered
        )
        suppressed_reason = None
        notify = significant
        if notify and _notification_on_cooldown(connection, selected_id, event_type, moment):
            notify = False
            suppressed_reason = f"cooldown_{NOTIFICATION_COOLDOWN_SECONDS}s"

        reasons = [*event_reasons, *base_reasons[:2]]
        details = {
            "activity_before": round(activity_before, 1),
            "activity_after": round(activity_after, 1),
            "activity_change": activity_change,
            "sessions_before": round(sessions_before, 1),
            "sessions_after": round(sessions_after, 1),
            "base_score": base_percent,
            "demo_modifier_before": modifier_before,
            "demo_modifier_after": modifier_after,
            "is_demo_customer": base_customer is None,
            **details_extra,
        }

        connection.execute(
            """
            UPDATE demo_customer_state
            SET email=?, activity_index=?, sessions_7d=?, risk_modifier=?, contacts=?, updated_at=?
            WHERE customer_id=?
            """,
            (
                email,
                activity_after,
                sessions_after,
                modifier_after,
                json.dumps(contacts, ensure_ascii=False),
                iso(moment),
                selected_id,
            ),
        )
        connection.execute(
            """
            INSERT INTO risk_calculations (
                event_id, customer_id, base_score, demo_modifier,
                previous_risk_score, risk_score, risk_percent, risk_level,
                risk_delta, reasons, source, mode, is_demo, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', 'DEMO', 1, ?)
            """,
            (
                generated_event_id,
                selected_id,
                base_percent,
                modifier_after,
                previous_score,
                risk_score,
                risk_percent,
                risk_level,
                risk_delta,
                json.dumps(reasons, ensure_ascii=False),
                iso(moment),
            ),
        )
        cursor = connection.execute(
            """
            INSERT INTO realtime_events (
                event_id, type, source, mode, scenario, customer_id,
                customer_email, timestamp, severity, previous_risk_score,
                risk_score, risk_percent, risk_level, risk_delta, reason,
                reasons, details, processed, notification_created,
                notification_id, suppressed_reason, created_at
            ) VALUES (?, ?, 'demo', 'DEMO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)
            """,
            (
                generated_event_id,
                event_type,
                scenario,
                selected_id,
                email,
                iso(moment),
                severity,
                previous_score,
                risk_score,
                risk_percent,
                risk_level,
                risk_delta,
                reason,
                json.dumps(reasons, ensure_ascii=False),
                json.dumps(details, ensure_ascii=False),
                suppressed_reason,
                iso(moment),
            ),
        )
        event_row_id = int(cursor.lastrowid or 0)

        required_top_up = None
        action_hint = "Проверьте баланс и автопродление в панели Aéza."
        if base_customer is not None:
            queue = rescue_queue([base_customer], now=moment, limit=1, minimum_score=0)
            if queue["items"]:
                rescue = queue["items"][0]
                required_top_up = rescue.get("requiredTopUp")
                if required_top_up:
                    action_hint = (
                        f"Для ближайших продлений не хватает {required_top_up / 100:.2f} € — "
                        "пополнение на эту сумму снимает главный сигнал."
                    )
                else:
                    action_hint = str(rescue.get("actionDetail") or action_hint)

        actions = _create_reactions(
            connection,
            event_id=generated_event_id,
            event_type=event_type,
            severity=severity,
            customer_id=selected_id,
            contacts=contacts,
            context={
                "email": email,
                "risk_percent": risk_percent,
                "previous_risk_percent": previous_percent,
                "action_hint": action_hint,
            },
            mode="DEMO",
            now=moment,
        )

        notification_id = None
        if notify:
            title = (
                "DEMO: клиент восстановлен"
                if recovered and risk_delta < 0
                else f"DEMO: риск {previous_percent} → {risk_percent}"
            )
            message = (
                f"{SCENARIO_LABELS[scenario]}. {reasons[0]} "
                f"Активность {activity_before:.0f} → {activity_after:.0f}."
            )
            notification = _insert_event(
                connection,
                episode_key=f"realtime:{generated_event_id}",
                customer_id=selected_id if base_customer is not None else None,
                event_type=event_type,
                severity=severity,
                title=title,
                message=message,
                score=risk_percent,
                estimated_loss=estimated_loss,
                payload={
                    "customerEmail": email,
                    "riskLevel": risk_level,
                    "daysToExpiry": days_to_expiry,
                    "requiredTopUp": required_top_up,
                    "source": "demo",
                    "mode": "DEMO",
                    "eventId": generated_event_id,
                    "previousScore": previous_percent,
                    "riskDelta": risk_delta,
                },
                now=moment,
                resolved=True,
            )
            notification_id = int(notification["id"]) if notification else None
            if notification_id:
                connection.execute(
                    "UPDATE realtime_events SET notification_created=1, notification_id=? WHERE id=?",
                    (notification_id, event_row_id),
                )

        row = connection.execute(
            "SELECT * FROM realtime_events WHERE id=?", (event_row_id,)
        ).fetchone()
        return {**_serialize_event(row, actions), "duplicate": False}


def list_realtime_events(
    *,
    limit: int = 50,
    offset: int = 0,
    severity: str | None = None,
    event_type: str | None = None,
    customer_id: str | None = None,
    mode: str | None = None,
    source: str | None = None,
    query: str | None = None,
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []
    for column, value in (
        ("severity", severity),
        ("type", event_type),
        ("customer_id", customer_id),
        ("mode", mode),
        ("source", source),
    ):
        if value:
            clauses.append(f"{column}=?")
            params.append(value)
    if query:
        clauses.append("(event_id LIKE ? OR customer_id LIKE ? OR customer_email LIKE ?)")
        needle = f"%{query}%"
        params.extend([needle, needle, needle])
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    bounded_limit = max(1, min(limit, 200))
    bounded_offset = max(0, offset)
    with db() as connection:
        ensure_realtime_tables(connection)
        total = int(
            connection.execute(
                f"SELECT COUNT(*) FROM realtime_events{where}", params
            ).fetchone()[0]
        )
        rows = connection.execute(
            f"SELECT * FROM realtime_events{where} ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, bounded_limit, bounded_offset],
        ).fetchall()
        latest = connection.execute(
            "SELECT COALESCE(MAX(id), 0) FROM realtime_events"
        ).fetchone()[0]
        actions_by_event: dict[str, list[dict[str, Any]]] = {}
        if rows:
            event_ids = [str(row["event_id"]) for row in rows]
            marks = ",".join("?" for _ in event_ids)
            for action in connection.execute(
                f"SELECT * FROM reaction_outbox WHERE event_id IN ({marks}) ORDER BY id",
                event_ids,
            ).fetchall():
                actions_by_event.setdefault(str(action["event_id"]), []).append(
                    _serialize_outbox(action)
                )
    return {
        "items": [
            _serialize_event(row, actions_by_event.get(str(row["event_id"]), []))
            for row in rows
        ],
        "total": total,
        "latestId": int(latest or 0),
        "generatedAt": iso(utcnow()),
    }


def realtime_events_after(row_id: int, limit: int = 100) -> list[dict[str, Any]]:
    with db() as connection:
        ensure_realtime_tables(connection)
        rows = connection.execute(
            "SELECT * FROM realtime_events WHERE id>? ORDER BY id ASC LIMIT ?",
            (row_id, max(1, min(limit, 200))),
        ).fetchall()
    return [_serialize_event(row) for row in rows]


def latest_realtime_event_id() -> int:
    with db() as connection:
        ensure_realtime_tables(connection)
        row = connection.execute("SELECT COALESCE(MAX(id),0) FROM realtime_events").fetchone()
    return int(row[0] or 0)


def customer_realtime_history(customer_id: str, limit: int = 100) -> dict[str, Any]:
    feed = list_realtime_events(customer_id=customer_id, limit=limit)
    with db() as connection:
        ensure_realtime_tables(connection)
        calculations = [
            {
                "eventId": row["event_id"],
                "baseScore": row["base_score"],
                "demoModifier": row["demo_modifier"],
                "previousRiskScore": row["previous_risk_score"],
                "riskScore": row["risk_score"],
                "riskPercent": int(row["risk_percent"]),
                "riskLevel": row["risk_level"],
                "riskDelta": row["risk_delta"],
                "reasons": _json(row["reasons"], []),
                "source": row["source"],
                "mode": row["mode"],
                "isDemo": bool(row["is_demo"]),
                "calculatedAt": row["calculated_at"],
            }
            for row in connection.execute(
                """
                SELECT * FROM risk_calculations WHERE customer_id=?
                ORDER BY id DESC LIMIT ?
                """,
                (customer_id, max(1, min(limit, 200))),
            ).fetchall()
        ]
    return {"customerId": customer_id, "events": feed["items"], "calculations": calculations}


def realtime_dashboard(customers: list[dict[str, Any]], hours: int = 24) -> dict[str, Any]:
    bounded_hours = max(1, min(hours, 24 * 30))
    since = utcnow() - timedelta(hours=bounded_hours)
    with db() as connection:
        ensure_realtime_tables(connection)
        latest_rows = connection.execute(
            """
            SELECT c.customer_id, c.risk_percent FROM risk_calculations c
            JOIN (
                SELECT customer_id, MAX(id) AS max_id FROM risk_calculations GROUP BY customer_id
            ) latest_calc ON latest_calc.max_id=c.id
            """
        ).fetchall()
        event_count, critical_count, improved_count = connection.execute(
            """
            SELECT COUNT(*),
                   SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END),
                   COUNT(DISTINCT CASE WHEN risk_delta<0 THEN customer_id END)
            FROM realtime_events WHERE created_at>=?
            """,
            (iso(since),),
        ).fetchone()
        demo_customers = int(
            connection.execute(
                "SELECT COUNT(*) FROM demo_customer_state WHERE is_demo_customer=1"
            ).fetchone()[0]
        )
        calc_rows = connection.execute(
            """
            SELECT calculated_at, risk_percent FROM risk_calculations
            WHERE calculated_at>=? ORDER BY id ASC
            """,
            (iso(since),),
        ).fetchall()
        event_rows = connection.execute(
            "SELECT created_at FROM realtime_events WHERE created_at>=? ORDER BY id ASC",
            (iso(since),),
        ).fetchall()

    latest_by_customer = {str(row["customer_id"]): int(row["risk_percent"]) for row in latest_rows}
    distribution = {"high": 0, "medium": 0, "low": 0}
    score_total = 0
    score_count = 0
    live_ids: set[str] = set()

    def add_score(score: int) -> None:
        nonlocal score_total, score_count
        distribution[_risk_level(score)] += 1
        score_total += score
        score_count += 1

    for customer in customers:
        customer_id = str(customer["id"])
        live_ids.add(customer_id)
        if customer_id in latest_by_customer:
            add_score(latest_by_customer[customer_id])
        elif customer.get("score") is not None:
            add_score(int(customer["score"]))
    for customer_id, score in latest_by_customer.items():
        if customer_id not in live_ids:
            add_score(score)

    def bucket_label(value: str) -> str:
        if len(value) >= 13 and value[10] in {"T", " "}:
            return f"{value[11:13]}:00"
        parsed = parse_date(value)
        return parsed.strftime("%H:00") if parsed else value[:13]

    risk_buckets: dict[str, list[int]] = {}
    for row in calc_rows:
        label = bucket_label(str(row["calculated_at"]))
        bucket = risk_buckets.setdefault(label, [0, 0])
        bucket[0] += int(row["risk_percent"])
        bucket[1] += 1
    event_buckets: dict[str, int] = {}
    for row in event_rows:
        label = bucket_label(str(row["created_at"]))
        event_buckets[label] = event_buckets.get(label, 0) + 1

    return {
        "generatedAt": iso(utcnow()),
        "periodHours": bounded_hours,
        "trackedCustomers": len(customers) + demo_customers,
        "highRiskCustomers": distribution["high"],
        "eventsInPeriod": int(event_count or 0),
        "criticalEvents": int(critical_count or 0),
        "averageRiskPercent": round(score_total / score_count, 1) if score_count else 0,
        "improvedCustomers": int(improved_count or 0),
        "distribution": distribution,
        "riskSeries": [
            {"label": label, "value": round(total / count, 1)}
            for label, (total, count) in list(risk_buckets.items())[-24:]
        ],
        "eventSeries": [
            {"label": label, "value": value}
            for label, value in list(event_buckets.items())[-24:]
        ],
        "method": "Текущий риск: live-скор существующей модели плюс отдельный DEMO-модификатор активности. Серии — фактические сохранённые расчёты и события, без выдуманной LIVE-истории.",
    }


def realtime_metric_counts() -> dict[str, int]:
    with db() as connection:
        ensure_realtime_tables(connection)
        demo_events, live_events = connection.execute(
            """
            SELECT
              SUM(CASE WHEN mode='DEMO' THEN 1 ELSE 0 END),
              SUM(CASE WHEN mode='LIVE' THEN 1 ELSE 0 END)
            FROM realtime_events
            """
        ).fetchone()
        outbox_rows = connection.execute(
            "SELECT status, COUNT(*) FROM reaction_outbox GROUP BY status"
        ).fetchall()
    counts = {
        "demo_events": int(demo_events or 0),
        "live_events": int(live_events or 0),
        "simulator_running": int(simulator.running),
        "simulated_sent": 0,
        "queued": 0,
        "no_channel": 0,
    }
    for status, count in outbox_rows:
        if str(status) in counts:
            counts[str(status)] = int(count or 0)
    return counts


def list_reaction_templates() -> list[dict[str, Any]]:
    with db() as connection:
        ensure_realtime_tables(connection)
        rows = connection.execute(
            "SELECT * FROM reaction_templates ORDER BY priority ASC"
        ).fetchall()
    return [_serialize_template(row) for row in rows]


def update_reaction_template(template_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {
        "enabled": "enabled",
        "subject": "subject",
        "body": "body",
        "cooldownSeconds": "cooldown_seconds",
        "channelStrategy": "channel_strategy",
    }
    assignments: list[str] = []
    params: list[Any] = []
    for key, column in allowed.items():
        if key in changes and changes[key] is not None:
            assignments.append(f"{column}=?")
            params.append(int(changes[key]) if column in {"enabled", "cooldown_seconds"} else changes[key])
    if not assignments:
        return None
    assignments.append("updated_at=?")
    params.extend([iso(utcnow()), template_id])
    with db() as connection:
        ensure_realtime_tables(connection)
        cursor = connection.execute(
            f"UPDATE reaction_templates SET {', '.join(assignments)} WHERE id=?", params
        )
        if cursor.rowcount == 0:
            return None
        row = connection.execute(
            "SELECT * FROM reaction_templates WHERE id=?", (template_id,)
        ).fetchone()
    return _serialize_template(row) if row else None


def list_reaction_outbox(limit: int = 50) -> list[dict[str, Any]]:
    with db() as connection:
        ensure_realtime_tables(connection)
        rows = connection.execute(
            "SELECT * FROM reaction_outbox ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 200)),),
        ).fetchall()
    return [_serialize_outbox(row) for row in rows]


def reset_demo_data() -> dict[str, int]:
    simulator.stop()
    with db() as connection:
        ensure_realtime_tables(connection)
        ensure_alert_tables(connection)
        counts = {}
        for table, where in (
            ("reaction_outbox", "mode='DEMO'"),
            ("realtime_events", "mode='DEMO'"),
            ("risk_calculations", "mode='DEMO'"),
            ("demo_customer_state", "1=1"),
            ("risk_events", "episode_key LIKE 'realtime:%'"),
        ):
            cursor = connection.execute(f"DELETE FROM {table} WHERE {where}")
            counts[table] = int(cursor.rowcount or 0)
    return counts


class DemoSimulator:
    """One daemon thread; database events are the source of truth."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._provider: Callable[[], list[dict[str, Any]]] | None = None
        self.interval_seconds = 5.0
        self.scenario = "MIXED"
        self.generated_count = 0
        self.last_event_id: str | None = None
        self.last_error: str | None = None
        self.started_at: str | None = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "intervalSeconds": self.interval_seconds,
            "scenario": self.scenario,
            "generatedCount": self.generated_count,
            "lastEventId": self.last_event_id,
            "lastError": self.last_error,
            "startedAt": self.started_at,
        }

    def start(
        self,
        *,
        interval_seconds: float,
        scenario: str,
        customers_provider: Callable[[], list[dict[str, Any]]],
    ) -> dict[str, Any]:
        with self._lock:
            if self.running:
                return self.status()
            self.interval_seconds = max(2.0, min(60.0, float(interval_seconds)))
            self.scenario = scenario if scenario == "MIXED" or scenario in DEMO_SCENARIOS else "MIXED"
            self._provider = customers_provider
            self._stop.clear()
            self.last_error = None
            self.started_at = iso(utcnow())
            self._thread = threading.Thread(target=self._run, name="demo-event-simulator", daemon=True)
            self._thread.start()
            return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            self._stop.set()
            thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=1.5)
        with self._lock:
            self._thread = None
            return self.status()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self._provider is None:
                    raise RuntimeError("customers provider is not configured")
                scenario = _rng.choice(DEMO_SCENARIOS) if self.scenario == "MIXED" else self.scenario
                event = process_demo_event(self._provider(), scenario=scenario)
                self.generated_count += 1
                self.last_event_id = str(event["eventId"])
                self.last_error = None
            except (OSError, RuntimeError, ValueError, DatabaseError) as error:
                # A simulator failure is visible in status and must not kill API.
                self.last_error = str(error)
            if self._stop.wait(self.interval_seconds):
                break


simulator = DemoSimulator()


def realtime_status(customers: list[dict[str, Any]]) -> dict[str, Any]:
    with db() as connection:
        ensure_realtime_tables(connection)
        counts = connection.execute(
            """
            SELECT COUNT(*) AS total_count,
                   SUM(CASE WHEN mode='DEMO' THEN 1 ELSE 0 END) AS demo_count,
                   SUM(CASE WHEN mode='LIVE' THEN 1 ELSE 0 END) AS live_count
            FROM realtime_events
            """
        ).fetchone()
        total_events = int(counts["total_count"] or 0)
        demo_events = int(counts["demo_count"] or 0)
        live_events = int(counts["live_count"] or 0)
    return {
        "generatedAt": iso(utcnow()),
        "sources": [adapter.status() for adapter in SOURCE_ADAPTERS],
        "simulator": simulator.status(),
        "scenarios": [
            {"id": scenario, "label": SCENARIO_LABELS[scenario]} for scenario in DEMO_SCENARIOS
        ],
        "thresholds": {
            "medium": RISK_THRESHOLDS["medium"],
            "high": RISK_THRESHOLDS["high"],
            "critical": CRITICAL_SCORE,
            "significantDelta": SIGNIFICANT_DELTA,
            "notificationCooldownSeconds": NOTIFICATION_COOLDOWN_SECONDS,
        },
        "eventCounts": {"total": total_events, "demo": demo_events, "live": live_events},
        "trackedCustomers": len(customers),
        "liveAvailable": any(
            adapter.status()["available"] for adapter in SOURCE_ADAPTERS if adapter.name != "demo"
        ),
    }
