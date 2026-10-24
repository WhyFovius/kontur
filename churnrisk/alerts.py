from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from .database import (
    Connection,
    Row,
    acquire_schema_lock,
    mark_schema_ready,
    schema_is_ready,
)
from .domain import RISK_THRESHOLDS, alert_candidates, customer_risk_state, iso, utcnow
from .storage import db

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}
_MAX_NEW_ALERTS_PER_SYNC = 25


def ensure_alert_tables(connection: Connection) -> None:
    if schema_is_ready(connection, "alerts"):
        return
    acquire_schema_lock(connection)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS risk_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            episode_key TEXT NOT NULL,
            customer_id TEXT,
            event_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            score INTEGER,
            estimated_loss INTEGER NOT NULL DEFAULT 0,
            payload TEXT NOT NULL DEFAULT '{}',
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            read_at TEXT,
            resolved_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS risk_events_active_episode_idx
            ON risk_events(episode_key) WHERE resolved_at IS NULL;
        CREATE INDEX IF NOT EXISTS risk_events_first_seen_idx
            ON risk_events(first_seen_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS risk_events_unread_idx
            ON risk_events(first_seen_at DESC, id DESC) WHERE read_at IS NULL;
        CREATE INDEX IF NOT EXISTS risk_events_read_idx
            ON risk_events(first_seen_at DESC, id DESC) WHERE read_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS risk_events_customer_idx
            ON risk_events(customer_id, id DESC);
        CREATE TABLE IF NOT EXISTS risk_monitor_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    mark_schema_ready(connection, "alerts")


def _serialize(row: Row) -> dict[str, Any]:
    raw_payload = row["payload"]
    if isinstance(raw_payload, dict):
        payload = raw_payload
    else:
        try:
            payload = json.loads(raw_payload or "{}")
        except (json.JSONDecodeError, TypeError):
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "id": int(row["id"]),
        "episodeKey": row["episode_key"],
        "customerId": row["customer_id"],
        "customerEmail": payload.get("customerEmail"),
        "type": row["event_type"],
        "severity": row["severity"],
        "title": row["title"],
        "message": row["message"],
        "score": row["score"],
        "riskLevel": payload.get("riskLevel"),
        "estimatedLoss": int(row["estimated_loss"] or 0),
        "daysToExpiry": payload.get("daysToExpiry"),
        "requiredTopUp": payload.get("requiredTopUp"),
        "source": payload.get("source", "snapshot"),
        "mode": payload.get("mode", "LIVE"),
        "eventId": payload.get("eventId"),
        "previousScore": payload.get("previousScore"),
        "riskDelta": payload.get("riskDelta"),
        "firstSeenAt": row["first_seen_at"],
        "lastSeenAt": row["last_seen_at"],
        "readAt": row["read_at"],
        "resolvedAt": row["resolved_at"],
        "isRead": row["read_at"] is not None,
    }


def _load_state(connection: Connection) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT state FROM risk_monitor_state WHERE id=1"
    ).fetchone()
    if row is None:
        return None
    try:
        state = json.loads(row["state"])
    except (json.JSONDecodeError, TypeError):
        return None
    return state if isinstance(state, dict) else None


def _save_state(
    connection: Connection, state: dict[str, Any], now: datetime
) -> None:
    connection.execute(
        "INSERT INTO risk_monitor_state (id, state, updated_at) VALUES (1, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
        (json.dumps(state, ensure_ascii=False), iso(now)),
    )


def _insert_event(
    connection: Connection,
    *,
    episode_key: str,
    customer_id: str | None,
    event_type: str,
    severity: str,
    title: str,
    message: str,
    score: int | None,
    estimated_loss: int,
    payload: dict[str, Any],
    now: datetime,
    resolved: bool = False,
) -> dict[str, Any] | None:
    timestamp = iso(now)
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO risk_events (
            episode_key, customer_id, event_type, severity, title, message,
            score, estimated_loss, payload, first_seen_at, last_seen_at,
            read_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        """,
        (
            episode_key,
            customer_id,
            event_type,
            severity,
            title,
            message,
            score,
            estimated_loss,
            json.dumps(payload, ensure_ascii=False),
            timestamp,
            timestamp,
            timestamp if resolved else None,
        ),
    )
    if cursor.rowcount == 0 or cursor.lastrowid is None:
        return None
    row = connection.execute(
        "SELECT * FROM risk_events WHERE id=?", (cursor.lastrowid,)
    ).fetchone()
    return _serialize(row) if row else None


def _event_matches(
    existing: Row, candidate: dict[str, Any], payload_json: str
) -> bool:
    return (
        str(existing["severity"]) == str(candidate["severity"])
        and str(existing["title"]) == str(candidate["title"])
        and str(existing["message"]) == str(candidate["message"])
        and existing["score"] == candidate.get("score")
        and int(existing["estimated_loss"] or 0)
        == int(candidate.get("estimatedLoss") or 0)
        and str(existing["payload"] or "{}") == payload_json
    )


def _last_seen_is_fresh(existing: Row, moment: datetime) -> bool:
    try:
        last_seen = datetime.fromisoformat(str(existing["last_seen_at"]))
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=UTC)
        current = moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment
        return 0 <= (current - last_seen).total_seconds() < 60
    except (TypeError, ValueError):
        return False


def sync_alerts(
    customers: list[dict[str, Any]],
    aggregate: dict[str, Any],
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Persist new/escalated risk episodes and resolve disappeared ones.

    The monitor compares a compact previous customer state with the fresh
    analysis.  Active conditions are stored once per episode; score and
    portfolio jumps are stored as one-off historical events.  This gives
    the SSE stream real changes to publish without spamming the operator
    every polling interval.
    """
    moment = now or utcnow()
    timestamp = iso(moment)
    candidates = alert_candidates(customers, moment)
    current_state = {
        "customers": customer_risk_state(customers),
        "summary": {
            "estimatedLoss": round(float(aggregate.get("estimatedLoss") or 0)),
            "highRisk": int(aggregate.get("highRisk") or 0),
        },
    }
    inserted: list[dict[str, Any]] = []

    with db() as connection:
        ensure_alert_tables(connection)
        previous = _load_state(connection)
        previous_customers: dict[str, Any] = (
            previous.get("customers", {}) if previous else {}
        )
        active_rows = connection.execute(
            "SELECT * FROM risk_events WHERE resolved_at IS NULL"
        ).fetchall()
        active = {str(row["episode_key"]): row for row in active_rows}
        current_episodes: set[str] = set()

        for candidate in candidates:
            episode = str(candidate["episodeKey"])
            current_episodes.add(episode)
            payload = {
                "customerEmail": candidate.get("customerEmail"),
                "riskLevel": candidate.get("riskLevel"),
                "daysToExpiry": candidate.get("daysToExpiry"),
                "requiredTopUp": candidate.get("requiredTopUp"),
            }
            existing = active.get(episode)
            if existing is not None:
                payload_json = json.dumps(payload, ensure_ascii=False)
                if _event_matches(existing, candidate, payload_json):
                    if _last_seen_is_fresh(existing, moment):
                        continue
                    connection.execute(
                        "UPDATE risk_events SET last_seen_at=? WHERE id=?",
                        (timestamp, existing["id"]),
                    )
                    continue
                escalated = _SEVERITY_RANK.get(candidate["severity"], 9) < _SEVERITY_RANK.get(
                    str(existing["severity"]), 9
                )
                connection.execute(
                    """
                    UPDATE risk_events
                    SET severity=?, title=?, message=?, score=?, estimated_loss=?,
                        payload=?, last_seen_at=?, read_at=?
                    WHERE id=?
                    """,
                    (
                        candidate["severity"],
                        candidate["title"],
                        candidate["message"],
                        candidate.get("score"),
                        int(candidate.get("estimatedLoss") or 0),
                        payload_json,
                        timestamp,
                        None if escalated else existing["read_at"],
                        existing["id"],
                    ),
                )
                continue
            if len(inserted) >= _MAX_NEW_ALERTS_PER_SYNC:
                continue
            event = _insert_event(
                connection,
                episode_key=episode,
                customer_id=str(candidate["customerId"]),
                event_type=str(candidate["type"]),
                severity=str(candidate["severity"]),
                title=str(candidate["title"]),
                message=str(candidate["message"]),
                score=candidate.get("score"),
                estimated_loss=int(candidate.get("estimatedLoss") or 0),
                payload=payload,
                now=moment,
            )
            if event is not None:
                inserted.append(event)

        for episode, row in active.items():
            if episode not in current_episodes:
                connection.execute(
                    "UPDATE risk_events SET resolved_at=?, last_seen_at=? WHERE id=?",
                    (timestamp, timestamp, row["id"]),
                )

        if previous:
            current_customers = current_state["customers"]
            customers_by_id = {
                str(customer["id"]): customer for customer in customers
            }
            for customer_id, current in current_customers.items():
                previous_customer = previous_customers.get(customer_id)
                if not isinstance(previous_customer, dict):
                    continue
                previous_score = previous_customer.get("score")
                current_score = current.get("score")
                if not isinstance(previous_score, (int, float)) or not isinstance(
                    current_score, (int, float)
                ):
                    continue
                customer = customers_by_id.get(customer_id)
                if customer is None:
                    continue
                payload = {
                    "customerEmail": customer.get("email"),
                    "riskLevel": current.get("riskLevel"),
                    "daysToExpiry": customer.get("daysToExpiry"),
                    "requiredTopUp": None,
                    "previousScore": int(previous_score),
                }
                if previous_score < RISK_THRESHOLDS["high"] <= current_score:
                    event = _insert_event(
                        connection,
                        episode_key=(
                            f"{customer_id}:entered_high_risk:"
                            f"{int(previous_score)}->{int(current_score)}"
                        ),
                        customer_id=customer_id,
                        event_type="entered_high_risk",
                        severity="critical" if current_score >= 80 else "warning",
                        title="Клиент перешёл в высокий риск",
                        message=(
                            f"Скор вырос с {int(previous_score)} до {int(current_score)}. "
                            "Клиент только что пересёк порог высокого риска."
                        ),
                        score=int(current_score),
                        estimated_loss=int(current.get("estimatedLoss") or 0),
                        payload=payload,
                        now=moment,
                        resolved=True,
                    )
                    if event is not None:
                        inserted.append(event)
                elif current_score - previous_score >= 15:
                    event = _insert_event(
                        connection,
                        episode_key=(
                            f"{customer_id}:score_spike:"
                            f"{int(previous_score)}->{int(current_score)}"
                        ),
                        customer_id=customer_id,
                        event_type="score_spike",
                        severity="warning",
                        title="Резкий рост риск-скора",
                        message=(
                            f"Скор вырос с {int(previous_score)} до {int(current_score)} "
                            "между проверками монитора."
                        ),
                        score=int(current_score),
                        estimated_loss=int(current.get("estimatedLoss") or 0),
                        payload=payload,
                        now=moment,
                        resolved=True,
                    )
                    if event is not None:
                        inserted.append(event)

            previous_summary = previous.get("summary", {}) if previous else {}
            previous_loss = int(previous_summary.get("estimatedLoss") or 0)
            current_loss = int(current_state["summary"]["estimatedLoss"])
            if (
                previous_loss > 0
                and current_loss - previous_loss >= 10_000
                and current_loss >= previous_loss * 1.2
            ):
                event = _insert_event(
                    connection,
                    episode_key=f"portfolio:loss_spike:{previous_loss}->{current_loss}",
                    customer_id=None,
                    event_type="portfolio_loss_spike",
                    severity="critical",
                    title="Выручка под риском резко выросла",
                    message=(
                        "Портфельная оценка потерь выросла минимум на 20% "
                        "между проверками. Стоит открыть очередь спасения."
                    ),
                    score=None,
                    estimated_loss=current_loss,
                    payload={"previousEstimatedLoss": previous_loss},
                    now=moment,
                    resolved=True,
                )
                if event is not None:
                    inserted.append(event)

        if previous != current_state:
            _save_state(connection, current_state, moment)

    inserted.sort(
        key=lambda item: (
            _SEVERITY_RANK.get(str(item["severity"]), 9),
            -int(item["estimatedLoss"]),
            -int(item["id"]),
        )
    )
    return inserted


def list_notifications(
    limit: int = 30, unread_only: bool = False, read_only: bool = False
) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 100))
    with db() as connection:
        ensure_alert_tables(connection)
        if unread_only and read_only:
            condition = "1=0"
        elif unread_only:
            condition = "read_at IS NULL"
        elif read_only:
            condition = "read_at IS NOT NULL"
        else:
            condition = "1=1"
        where = "" if condition == "1=1" else f"WHERE {condition}"
        rows = connection.execute(
            f"SELECT * FROM risk_events {where} "
            "ORDER BY first_seen_at DESC, id DESC LIMIT ?",
            (bounded_limit,),
        ).fetchall()
        counts = connection.execute(
            f"""
            SELECT
                SUM(CASE WHEN {condition} THEN 1 ELSE 0 END) AS filtered_count,
                SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
                SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count,
                SUM(
                    CASE WHEN read_at IS NULL AND severity='critical'
                         AND resolved_at IS NULL THEN 1 ELSE 0 END
                ) AS critical_count
            FROM risk_events
            """
        ).fetchone()
        total = int(counts["filtered_count"] or 0)
        unread = int(counts["unread_count"] or 0)
        read = int(counts["read_count"] or 0)
        critical = int(counts["critical_count"] or 0)
    return {
        "items": [_serialize(row) for row in rows],
        "total": total,
        "unreadCount": unread,
        "readCount": read,
        "criticalCount": critical,
        "generatedAt": iso(utcnow()),
    }


def notification_counts() -> tuple[int, int]:
    with db() as connection:
        ensure_alert_tables(connection)
        counts = connection.execute(
            """
            SELECT
                SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
                SUM(
                    CASE WHEN read_at IS NULL AND severity='critical'
                         AND resolved_at IS NULL THEN 1 ELSE 0 END
                ) AS critical_count
            FROM risk_events
            """
        ).fetchone()
    return int(counts["unread_count"] or 0), int(counts["critical_count"] or 0)


def mark_notification_read(notification_id: int) -> dict[str, Any] | None:
    with db() as connection:
        ensure_alert_tables(connection)
        cursor = connection.execute(
            "UPDATE risk_events SET read_at=COALESCE(read_at, ?) WHERE id=?",
            (iso(utcnow()), notification_id),
        )
        if cursor.rowcount == 0:
            return None
        row = connection.execute(
            "SELECT * FROM risk_events WHERE id=?", (notification_id,)
        ).fetchone()
    return _serialize(row) if row else None


def mark_notification_unread(notification_id: int) -> dict[str, Any] | None:
    with db() as connection:
        ensure_alert_tables(connection)
        cursor = connection.execute(
            "UPDATE risk_events SET read_at=NULL WHERE id=?",
            (notification_id,),
        )
        if cursor.rowcount == 0:
            return None
        row = connection.execute(
            "SELECT * FROM risk_events WHERE id=?", (notification_id,)
        ).fetchone()
    return _serialize(row) if row else None


def mark_all_notifications_read() -> int:
    with db() as connection:
        ensure_alert_tables(connection)
        cursor = connection.execute(
            "UPDATE risk_events SET read_at=? WHERE read_at IS NULL",
            (iso(utcnow()),),
        )
        return int(cursor.rowcount or 0)


def latest_event_id() -> int:
    with db() as connection:
        ensure_alert_tables(connection)
        row = connection.execute(
            "SELECT COALESCE(MAX(id), 0) FROM risk_events"
        ).fetchone()
    return int(row[0] or 0)


def events_after(event_id: int, limit: int = 50) -> list[dict[str, Any]]:
    with db() as connection:
        ensure_alert_tables(connection)
        rows = connection.execute(
            "SELECT * FROM risk_events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (event_id, max(1, min(limit, 100))),
        ).fetchall()
    return [_serialize(row) for row in rows]
