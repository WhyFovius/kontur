from __future__ import annotations

import json
import math
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from .config import (
    DATABASE_PATH,
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_WINDOW_SECONDS,
    MAX_ACCOUNTS,
    MAX_SERVICES,
    MAX_TRANSACTIONS,
)
from .domain import DEFAULT_WEIGHTS, iso, parse_date, utcnow


class SnapshotValidationError(ValueError):
    """The uploaded snapshot cannot be stored without losing or misreading data."""


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """Open a short-lived SQLite connection and always close it after use."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _seed_snapshot() -> dict[str, list[dict[str, Any]]]:
    now = utcnow()
    accounts = [
        {
            "id": 10482,
            "email": "maria.volkova@example.com",
            "balance": 850,
            "withdrawBalance": 1200,
            "bonusBalance": 0,
            "bonusState": False,
            "totalReplenished": 18400,
        },
        {
            "id": 10817,
            "email": "alexey.smirnov@example.com",
            "balance": 7200,
            "withdrawBalance": 0,
            "bonusBalance": 900,
            "bonusState": True,
            "totalReplenished": 52800,
        },
        {
            "id": 10931,
            "email": "daria.ivanova@example.com",
            "balance": 90,
            "withdrawBalance": 0,
            "bonusBalance": 0,
            "bonusState": False,
            "totalReplenished": 3200,
        },
        {
            "id": 11004,
            "email": "nikita.petrov@example.com",
            "balance": 16400,
            "withdrawBalance": 600,
            "bonusBalance": 1400,
            "bonusState": True,
            "totalReplenished": 94300,
        },
        {
            "id": 11276,
            "email": "elena.orlova@example.com",
            "balance": 2100,
            "withdrawBalance": 0,
            "bonusBalance": 350,
            "bonusState": True,
            "totalReplenished": 26100,
        },
        {
            "id": 11509,
            "email": "igor.sokolov@example.com",
            "balance": 0,
            "withdrawBalance": 800,
            "bonusBalance": 0,
            "bonusState": False,
            "totalReplenished": 7900,
        },
        {
            "id": 11642,
            "email": "olga.kuznetsova@example.com",
            "balance": 4850,
            "withdrawBalance": 0,
            "bonusBalance": 1200,
            "bonusState": True,
            "totalReplenished": 67100,
        },
        {
            "id": 11803,
            "email": "pavel.morozov@example.com",
            "balance": 360,
            "withdrawBalance": 0,
            "bonusBalance": 100,
            "bonusState": True,
            "totalReplenished": 11600,
        },
    ]
    plans = [
        [("active", 2400, "month", False, 2), ("active", 900, "month", True, 34)],
        [
            ("active", 1800, "month", True, 25),
            ("active", 4200, "quarter_year", True, 70),
        ],
        [
            ("prolong_wait", 1600, "month", False, -2),
            ("active", 650, "month", False, 9),
        ],
        [("active", 2200, "month", True, 50), ("active", 6000, "year", True, 140)],
        [("active", 3100, "month", False, 6), ("deleted", 850, "month", False, -50)],
        [("prolong_wait", 2800, "month", False, -4)],
        [("active", 1200, "month", True, 19), ("active", 3800, "half_year", True, 105)],
        [("active", 950, "month", False, 3), ("deleted", 400, "week", False, -35)],
    ]
    services: list[dict[str, Any]] = []
    transactions: list[dict[str, Any]] = []
    for account, plan in zip(accounts, plans):
        for index, (status, price, term, autoprolong, days) in enumerate(plan):
            services.append(
                {
                    "id": f"svc-{account['id']}-{index + 1}",
                    "accountId": account["id"],
                    "name": [
                        "Виртуальный сервер",
                        "Резервное копирование",
                        "Домашний сервер",
                    ][index % 3],
                    "status": status,
                    "price": price,
                    "paymentTerm": term,
                    "autoprolong": autoprolong,
                    "expiresAt": iso(now + timedelta(days=days)),
                }
            )
        transactions.append(
            {
                "id": f"pay-{account['id']}",
                "accountId": account["id"],
                "status": "not_performed"
                if account["id"] in (10482, 10931, 11509)
                else "performed",
                "type": "prolong",
                "amount": 2400,
            }
        )
    return {"accounts": accounts, "services": services, "transactions": transactions}


def _identifier(value: Any, field: str) -> str:
    if isinstance(value, dict):
        value = value.get("$oid", value.get("$numberLong", value.get("$numberInt")))
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise SnapshotValidationError(
            f"{field}: ожидается непустая строка или целое число"
        )
    result = str(value).strip()
    if not result or len(result) > 200:
        raise SnapshotValidationError(
            f"{field}: длина должна быть от 1 до 200 символов"
        )
    return result


def _money(value: Any, field: str) -> int:
    if isinstance(value, dict):
        value = value.get(
            "$numberLong", value.get("$numberInt", value.get("$numberDouble"))
        )
    if isinstance(value, bool) or value is None:
        raise SnapshotValidationError(
            f"{field}: ожидается неотрицательная сумма в евроцентах"
        )
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise SnapshotValidationError(f"{field}: ожидается число") from None
    if (
        not math.isfinite(number)
        or number < 0
        or number > 1_000_000_000_000_000
        or not number.is_integer()
    ):
        raise SnapshotValidationError(
            f"{field}: сумма должна быть целым числом евроцентов в допустимом диапазоне"
        )
    return int(number)


def _boolean(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    raise SnapshotValidationError(f"{field}: ожидается true или false")


def _account_rows(rows: Any) -> tuple[list[dict[str, Any]], set[str]]:
    if not isinstance(rows, list) or len(rows) > MAX_ACCOUNTS:
        raise SnapshotValidationError(
            f"accounts должен быть списком не более {MAX_ACCOUNTS} записей"
        )
    normalized: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, source in enumerate(rows):
        if not isinstance(source, dict):
            raise SnapshotValidationError(f"accounts[{index}] должен быть объектом")
        account = dict(source)
        identifier = _identifier(
            account.get("id", account.get("_id")), f"accounts[{index}].id"
        )
        if identifier in identifiers:
            raise SnapshotValidationError(f"Повторяется id аккаунта: {identifier}")
        identifiers.add(identifier)
        account["id"] = identifier
        account.pop("_id", None)
        email = account.get("email")
        if email is not None and (
            not isinstance(email, str)
            or len(email) > 320
            or any(character.isspace() for character in email)
            or email.count("@") != 1
        ):
            raise SnapshotValidationError(
                f"accounts[{index}].email должен быть корректным адресом электронной почты"
            )
        for field in ("balance", "withdrawBalance", "bonusBalance", "totalReplenished"):
            if field in account:
                account[field] = _money(account[field], f"accounts[{index}].{field}")
        if "bonusState" in account:
            account["bonusState"] = _boolean(
                account["bonusState"], f"accounts[{index}].bonusState"
            )
        normalized.append(account)
    return normalized, identifiers


def _related_rows(rows: Any, table: str, account_ids: set[str]) -> list[dict[str, Any]]:
    max_rows = MAX_SERVICES if table == "services" else MAX_TRANSACTIONS
    if not isinstance(rows, list) or len(rows) > max_rows:
        raise SnapshotValidationError(
            f"{table} должен быть списком не более {max_rows} записей"
        )
    normalized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    statuses = (
        {"active", "suspended", "prolong_wait", "deleted", "blocked"}
        if table == "services"
        else {"performed", "not_performed"}
    )
    for index, source in enumerate(rows):
        if not isinstance(source, dict):
            raise SnapshotValidationError(f"{table}[{index}] должен быть объектом")
        item = dict(source)
        identifier = _identifier(
            item.get("id", item.get("_id", f"{table}-{index}")), f"{table}[{index}].id"
        )
        if identifier in seen_ids:
            raise SnapshotValidationError(f"Повторяется id в {table}: {identifier}")
        seen_ids.add(identifier)
        owner_value = item.get("accountId", item.get("userId", item.get("account_id")))
        owner = _identifier(owner_value, f"{table}[{index}].accountId")
        if owner not in account_ids:
            raise SnapshotValidationError(
                f"{table}[{index}] ссылается на отсутствующий аккаунт {owner}"
            )
        status = str(item.get("status", "")).strip().casefold()
        if status not in statuses:
            raise SnapshotValidationError(
                f"{table}[{index}].status имеет неизвестное значение"
            )
        item["id"] = identifier
        item["accountId"] = owner
        item["status"] = status
        item.pop("_id", None)
        item.pop("userId", None)
        item.pop("account_id", None)
        if "price" in item:
            item["price"] = _money(item["price"], f"{table}[{index}].price")
        if "amount" in item:
            item["amount"] = _money(item["amount"], f"{table}[{index}].amount")
        if table == "services":
            term = str(item.get("paymentTerm", "month")).strip().casefold()
            if term not in {
                "hour",
                "week",
                "month",
                "quarter_year",
                "half_year",
                "year",
            }:
                raise SnapshotValidationError(
                    f"services[{index}].paymentTerm имеет неизвестное значение"
                )
            item["paymentTerm"] = term
            if "autoprolong" in item:
                item["autoprolong"] = _boolean(
                    item["autoprolong"], f"services[{index}].autoprolong"
                )
            expiration = item.get("expiresAt")
            if expiration not in (None, ""):
                if parse_date(expiration) is None:
                    raise SnapshotValidationError(
                        f"services[{index}].expiresAt должен быть датой ISO 8601"
                    )
                if isinstance(expiration, datetime):
                    item["expiresAt"] = iso(expiration.astimezone(UTC))
        else:
            transaction_type = str(item.get("type", "")).strip().casefold()
            if transaction_type not in {"prolong", "order"}:
                raise SnapshotValidationError(
                    f"transactions[{index}].type должен быть prolong или order"
                )
            item["type"] = transaction_type
        try:
            json.dumps(item, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            raise SnapshotValidationError(
                f"{table}[{index}] содержит неподдерживаемые значения"
            ) from None
        normalized.append(item)
    return normalized


def validate_snapshot(snapshot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    from .snapshot import normalize_snapshot

    try:
        snapshot = normalize_snapshot(snapshot)
    except ValueError as error:
        raise SnapshotValidationError(str(error)) from error
    accounts, account_ids = _account_rows(snapshot["accounts"])
    services = _related_rows(snapshot["services"], "services", account_ids)
    transactions = _related_rows(
        snapshot.get("transactions", []), "transactions", account_ids
    )
    return {"accounts": accounts, "services": services, "transactions": transactions}


def replace_snapshot(connection: sqlite3.Connection, snapshot: dict[str, Any]) -> int:
    normalized = validate_snapshot(snapshot)
    connection.execute("DELETE FROM services")
    connection.execute("DELETE FROM transactions")
    connection.execute("DELETE FROM accounts")
    connection.executemany(
        "INSERT INTO accounts (id, data) VALUES (?, ?)",
        (
            (row["id"], json.dumps(row, ensure_ascii=False, allow_nan=False))
            for row in normalized["accounts"]
        ),
    )
    connection.executemany(
        "INSERT INTO services (id, account_id, data) VALUES (?, ?, ?)",
        (
            (
                row["id"],
                row["accountId"],
                json.dumps(row, ensure_ascii=False, allow_nan=False),
            )
            for row in normalized["services"]
        ),
    )
    connection.executemany(
        "INSERT INTO transactions (id, account_id, data) VALUES (?, ?, ?)",
        (
            (
                row["id"],
                row["accountId"],
                json.dumps(row, ensure_ascii=False, allow_nan=False),
            )
            for row in normalized["transactions"]
        ),
    )
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('snapshot_version', '2') "
        "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1"
    )
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('snapshot_initialized', '1') "
        "ON CONFLICT(key) DO UPDATE SET value='1'"
    )
    return len(normalized["accounts"])


def load_source(connection: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    source: dict[str, list[dict[str, Any]]] = {}
    for table in ("accounts", "services", "transactions"):
        source[table] = [
            json.loads(row[0])
            for row in connection.execute(f"SELECT data FROM {table}")
        ]
    return source


def get_weights(connection: sqlite3.Connection) -> dict[str, float]:
    row = connection.execute(
        "SELECT value FROM settings WHERE key='weights'"
    ).fetchone()
    stored = json.loads(row[0]) if row else {}
    return {**DEFAULT_WEIGHTS, **stored}


def update_weights(
    connection: sqlite3.Connection, changes: dict[str, float]
) -> dict[str, float]:
    weights = get_weights(connection)
    weights.update(changes)
    connection.execute(
        "INSERT INTO settings (key, value) VALUES ('weights', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(weights, allow_nan=False),),
    )
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('model_version', '1') "
        "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1"
    )
    return weights


def _rate_key_attempts(connection: sqlite3.Connection, key: str) -> tuple[bool, int]:
    now = utcnow().timestamp()
    row = connection.execute(
        "SELECT window_started, attempts FROM login_attempts WHERE key=?", (key,)
    ).fetchone()
    if row is None:
        return False, 0
    started, attempts = float(row["window_started"]), int(row["attempts"])
    if now - started >= LOGIN_WINDOW_SECONDS:
        connection.execute("DELETE FROM login_attempts WHERE key=?", (key,))
        return False, 0
    retry_after = max(1, int(LOGIN_WINDOW_SECONDS - (now - started)))
    return attempts >= LOGIN_ATTEMPT_LIMIT, retry_after


def login_rate_limited(key: str) -> tuple[bool, int]:
    with db() as connection:
        return _rate_key_attempts(connection, key)


def record_login_failure(key: str) -> None:
    now = utcnow().timestamp()
    with db() as connection:
        row = connection.execute(
            "SELECT window_started, attempts FROM login_attempts WHERE key=?", (key,)
        ).fetchone()
        if row is None or now - float(row["window_started"]) >= LOGIN_WINDOW_SECONDS:
            connection.execute(
                "INSERT INTO login_attempts (key, window_started, attempts) VALUES (?, ?, 1) "
                "ON CONFLICT(key) DO UPDATE SET window_started=excluded.window_started, attempts=1",
                (key, now),
            )
        else:
            connection.execute(
                "UPDATE login_attempts SET attempts=attempts+1 WHERE key=?", (key,)
            )


def clear_login_failures(key: str) -> None:
    with db() as connection:
        connection.execute("DELETE FROM login_attempts WHERE key=?", (key,))


def init_db() -> None:
    with db() as connection:
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, window_started REAL NOT NULL, attempts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oidc_states (state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS services_account_id_idx ON services(account_id);
        CREATE INDEX IF NOT EXISTS transactions_account_id_idx ON transactions(account_id);
        """)
        connection.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('weights', ?)",
            (json.dumps(DEFAULT_WEIGHTS),),
        )
        connection.execute(
            "INSERT OR IGNORE INTO metadata (key, value) VALUES ('snapshot_version', '1')"
        )
        connection.execute(
            "INSERT OR IGNORE INTO metadata (key, value) VALUES ('model_version', '1')"
        )

        initialized = connection.execute(
            "SELECT value FROM metadata WHERE key='snapshot_initialized'"
        ).fetchone()
        existing_accounts = connection.execute(
            "SELECT 1 FROM accounts LIMIT 1"
        ).fetchone()
        snapshot_version = int(
            connection.execute(
                "SELECT value FROM metadata WHERE key='snapshot_version'"
            ).fetchone()[0]
        )
        if initialized is None:
            if existing_accounts is None and snapshot_version <= 1:
                replace_snapshot(connection, _seed_snapshot())
            connection.execute(
                "INSERT OR IGNORE INTO metadata (key, value) VALUES ('snapshot_initialized', '1')"
            )
