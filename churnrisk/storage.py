from __future__ import annotations

import json
import math
import re
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

from .config import (
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_WINDOW_SECONDS,
    MAX_ACCOUNTS,
    MAX_SERVICES,
    MAX_TRANSACTIONS,
)
from .database import Connection, acquire_schema_lock, database_connection
from .domain import (
    DEFAULT_WEIGHTS,
    ServiceFact,
    TransactionFact,
    build_service_fact,
    iso,
    parse_date,
    utcnow,
)

# Kept as the storage module's public connection factory for existing
# imports.  The implementation now lives in churnrisk.database and may
# return either SQLite or pooled PostgreSQL connections.  Ordinary
# ``db()`` calls follow the active per-request workspace; ``registry_db``
# always addresses the configured main database that owns accounts,
# sessions and login rate limits.
db = database_connection
registry_db = partial(database_connection, ignore_active=True)


class SnapshotValidationError(ValueError):
    """The uploaded snapshot cannot be stored without losing or misreading data."""


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


_TRUE_VALUES = {
    "true",
    "t",
    "1",
    "yes",
    "y",
    "on",
    "enabled",
    "enable",
    "active",
    "activated",
    "available",
    "connected",
    "participating",
    "participant",
    "member",
    "subscribed",
    "opted in",
    "opt in",
    "has bonus",
    "bonus active",
    "bonus enabled",
    "allowed",
    "allow",
    "auto",
    "automatic",
    "ok",
    "present",
    "да",
    "есть",
    "истина",
    "авто",
    "автоматически",
    "включено",
    "включен",
    "включена",
    "включены",
    "активен",
    "активна",
    "активно",
    "активный",
    "активная",
    "активное",
    "активные",
    "активирован",
    "активирована",
    "активировано",
    "активированы",
    "подключен",
    "подключена",
    "подключено",
    "подключены",
    "доступен",
    "доступна",
    "доступно",
    "доступны",
    "участвует",
    "разрешен",
    "разрешена",
    "разрешено",
    "разрешены",
}
_FALSE_VALUES = {
    "false",
    "f",
    "0",
    "no",
    "n",
    "off",
    "disabled",
    "disable",
    "inactive",
    "deactivated",
    "unavailable",
    "disconnected",
    "not active",
    "not enabled",
    "not available",
    "opted out",
    "opt out",
    "denied",
    "deny",
    "manual",
    "none",
    "null",
    "nil",
    "missing",
    "absent",
    "-",
    "нет",
    "ложь",
    "вручную",
    "ручное",
    "выключено",
    "выключен",
    "выключена",
    "выключены",
    "неактивен",
    "неактивна",
    "неактивно",
    "неактивный",
    "неактивная",
    "неактивное",
    "неактивные",
    "деактивирован",
    "деактивирована",
    "деактивировано",
    "деактивированы",
    "отключен",
    "отключена",
    "отключено",
    "отключены",
    "недоступен",
    "недоступна",
    "недоступно",
    "недоступны",
    "не участвует",
    "нет бонуса",
    "запрещен",
    "запрещена",
    "запрещено",
    "запрещены",
    "",
}
_FALSE_STEMS = (
    "неактив",
    "не актив",
    "не включ",
    "не подключ",
    "недоступ",
    "не доступ",
    "отключ",
    "выключ",
    "деактив",
    "inactive",
    "disabled",
    "disconnected",
    "unavailable",
    "not active",
    "not enabled",
    "not available",
)
_TRUE_STEMS = (
    "актив",
    "включ",
    "подключ",
    "доступ",
    "участв",
    "разреш",
    "active",
    "enabled",
    "available",
    "connected",
    "participat",
    "subscribed",
    "allowed",
)


def _parse_boolean(value: Any) -> bool | None:
    """Best-effort parse of the flag spellings found in billing exports."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0 if math.isfinite(value) else None
    if isinstance(value, str):
        normalized = value.strip().strip("\"'").casefold().replace("ё", "е")
        normalized = re.sub(r"[\s_-]+", " ", normalized).strip(" .;")
        if normalized in _TRUE_VALUES:
            return True
        if normalized in _FALSE_VALUES:
            return False
        if re.fullmatch(r"[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)", normalized):
            return float(normalized.replace(",", ".")) != 0
        if any(stem in normalized for stem in _FALSE_STEMS):
            return False
        if any(stem in normalized for stem in _TRUE_STEMS):
            return True
        return None
    if isinstance(value, dict):
        if not value:
            return False
        lowered = {
            re.sub(
                r"[^0-9a-zа-я]+",
                "",
                str(key).strip().casefold().replace("ё", "е"),
            ): item
            for key, item in value.items()
        }
        # MongoDB Extended JSON wrappers used by canonical exports.
        for key in ("boolean", "numberint", "numberlong", "numberdouble", "numberdecimal"):
            if key in lowered:
                return _parse_boolean(lowered[key])
        for key in (
            "active",
            "isactive",
            "enabled",
            "isenabled",
            "bonusstate",
            "bonusactive",
            "bonusenabled",
            "isbonusactive",
            "state",
            "status",
            "value",
            "current",
            "flag",
            "on",
        ):
            if key in lowered:
                parsed = _parse_boolean(lowered[key])
                if parsed is not None:
                    return parsed
        for key, item in lowered.items():
            if any(marker in key for marker in ("active", "enabled", "актив", "включ")):
                parsed = _parse_boolean(item)
                if parsed is not None:
                    return parsed
        for key in ("percent", "percentage", "rate", "amount", "balance"):
            if key in lowered:
                parsed = _parse_boolean(lowered[key])
                if parsed is not None:
                    return parsed
        return None
    if isinstance(value, (list, tuple, set)):
        if not value:
            return False
        parsed_values = [_parse_boolean(item) for item in value]
        if any(item is True for item in parsed_values):
            return True
        if any(item is False for item in parsed_values):
            return False
    return None


def _boolean(value: Any, field: str, *, default: bool | None = None) -> bool:
    """Normalize an export flag to a real bool.

    The domain intentionally checks ``bonusState is True``; normalization
    is therefore the one place where strings such as ``"active"``,
    ``"подключена"``, ``"1.0"``, Mongo wrappers and small status objects
    become a bool. Optional flags pass ``default=False``: an
    uninterpretable spelling must not reject the whole snapshot upload,
    it simply does not count as switched on.
    """
    parsed = _parse_boolean(value)
    if parsed is not None:
        return parsed
    if default is not None:
        return default
    raise SnapshotValidationError(
        f"{field}: ожидается true или false, получено {value!r:.80}"
    )


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
            # An unknown bonus-programme spelling must never block the
            # whole snapshot: bonuses are counted only for a recognised
            # "on" value, everything else normalizes to False.
            account["bonusState"] = _boolean(
                account["bonusState"], f"accounts[{index}].bonusState", default=False
            )
        normalized.append(account)
    return normalized, identifiers


def _related_rows(
    rows: Any,
    table: str,
    account_ids: set[str],
    encoded: list[str] | None = None,
) -> list[dict[str, Any]]:
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
                    item["autoprolong"],
                    f"services[{index}].autoprolong",
                    default=False,
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
            encoded_item = json.dumps(item, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            raise SnapshotValidationError(
                f"{table}[{index}] содержит неподдерживаемые значения"
            ) from None
        if encoded is not None:
            encoded.append(encoded_item)
        normalized.append(item)
    return normalized


def _encode_account(row: dict[str, Any], index: int) -> str:
    try:
        return json.dumps(row, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        raise SnapshotValidationError(
            f"accounts[{index}] содержит неподдерживаемые значения"
        ) from None


def _validated_snapshot(
    snapshot: dict[str, Any],
    *,
    already_normalized: bool = False,
    encoded_out: dict[str, list[str]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    if already_normalized:
        if not isinstance(snapshot, dict):
            raise SnapshotValidationError("Снимок должен быть объектом")
        source = {
            "accounts": snapshot.get("accounts", []),
            "services": snapshot.get("services", []),
            "transactions": snapshot.get("transactions", []),
        }
    else:
        from .snapshot import normalize_snapshot

        try:
            source = normalize_snapshot(snapshot)
        except (ValueError, TypeError) as error:
            raise SnapshotValidationError(str(error)) from error

    accounts, account_ids = _account_rows(source["accounts"])
    encoded_services: list[str] | None = [] if encoded_out is not None else None
    encoded_transactions: list[str] | None = [] if encoded_out is not None else None
    services = _related_rows(
        source["services"], "services", account_ids, encoded_services
    )
    transactions = _related_rows(
        source.get("transactions", []),
        "transactions",
        account_ids,
        encoded_transactions,
    )
    if encoded_out is not None:
        encoded_out["accounts"] = [
            _encode_account(row, index) for index, row in enumerate(accounts)
        ]
        encoded_out["services"] = encoded_services or []
        encoded_out["transactions"] = encoded_transactions or []
    return {"accounts": accounts, "services": services, "transactions": transactions}


def validate_snapshot(
    snapshot: dict[str, Any], *, already_normalized: bool = False
) -> dict[str, list[dict[str, Any]]]:
    return _validated_snapshot(snapshot, already_normalized=already_normalized)


def replace_snapshot(
    connection: Connection,
    snapshot: dict[str, Any],
    *,
    already_normalized: bool = False,
) -> int:
    encoded: dict[str, list[str]] = {}
    normalized = _validated_snapshot(
        snapshot,
        already_normalized=already_normalized,
        encoded_out=encoded,
    )
    service_facts = [build_service_fact(row) for row in normalized["services"]]

    # Every row is validated and JSON-encoded before the first DELETE, so
    # a bad value can never leave a half-replaced snapshot behind.
    connection.execute("DELETE FROM services")
    connection.execute("DELETE FROM transactions")
    connection.execute("DELETE FROM accounts")
    connection.executemany(
        "INSERT INTO accounts (id, data) VALUES (?, ?)",
        (
            (row["id"], encoded_row)
            for row, encoded_row in zip(
                normalized["accounts"], encoded["accounts"], strict=True
            )
        ),
    )
    connection.executemany(
        """
        INSERT INTO services (
            id, account_id, data, status, price_cents, monthly_revenue_cents,
            autoprolong, expires_at_ts, deleted_at_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                row["id"],
                row["accountId"],
                encoded_row,
                fact.status,
                round(fact.price),
                fact.monthly_revenue,
                int(fact.autoprolong),
                fact.expires_ts,
                fact.deleted_ts,
            )
            for row, encoded_row, fact in zip(
                normalized["services"],
                encoded["services"],
                service_facts,
                strict=True,
            )
        ),
    )
    connection.executemany(
        "INSERT INTO transactions (id, account_id, data, status) VALUES (?, ?, ?, ?)",
        (
            (row["id"], row["accountId"], encoded_row, row["status"])
            for row, encoded_row in zip(
                normalized["transactions"],
                encoded["transactions"],
                strict=True,
            )
        ),
    )
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('snapshot_version', '2') "
        "ON CONFLICT(key) DO UPDATE SET value=CAST(metadata.value AS INTEGER)+1"
    )
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('snapshot_initialized', '1') "
        "ON CONFLICT(key) DO UPDATE SET value='1'"
    )
    return len(normalized["accounts"])


def load_source(connection: Connection) -> dict[str, list[dict[str, Any]]]:
    source: dict[str, list[dict[str, Any]]] = {}
    for table in ("accounts", "services", "transactions"):
        source[table] = [
            json.loads(row[0])
            for row in connection.execute(f"SELECT data FROM {table}")
        ]
    return source


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def load_account(
    connection: Connection, account_id: str
) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT data FROM accounts WHERE id=?", (account_id,)
    ).fetchone()
    return _json_object(row[0]) if row is not None else None


def load_prepared_source(
    connection: Connection,
) -> tuple[
    list[dict[str, Any]],
    dict[str, tuple[list[dict[str, Any]], list[ServiceFact]]],
    dict[str, TransactionFact],
]:
    """Load a snapshot grouped for analysis.

    Services still carry their raw JSON because the customer detail and
    rescue views need names/dates, but scoring facts come from typed
    columns materialized at snapshot ingest.  Transactions are reduced
    in SQL to the only aggregates the rule model uses, so a million-row
    transaction export is not JSON-parsed on every analysis refresh.
    """

    accounts = [
        _json_object(row[0])
        for row in connection.execute("SELECT data FROM accounts")
    ]

    services_by_account: dict[
        str, tuple[list[dict[str, Any]], list[ServiceFact]]
    ] = {}
    service_rows = connection.execute(
        """
        SELECT account_id, data, status, price_cents, monthly_revenue_cents,
               autoprolong, expires_at_ts, deleted_at_ts
        FROM services
        """
    )
    for row in service_rows:
        account_id = str(row["account_id"])
        raw = _json_object(row["data"])
        status = str(row["status"] or "")
        if status:
            expires_ts = row["expires_at_ts"]
            deleted_ts = row["deleted_at_ts"]
            fact = ServiceFact(
                status=status,
                billable=status in {"active", "suspended"},
                price=float(row["price_cents"] or 0),
                monthly_revenue=float(row["monthly_revenue_cents"] or 0),
                autoprolong=bool(row["autoprolong"]),
                expires_ts=float(expires_ts) if expires_ts is not None else None,
                deleted_ts=float(deleted_ts) if deleted_ts is not None else None,
            )
        else:
            fact = build_service_fact(raw)
        prepared = services_by_account.get(account_id)
        if prepared is None:
            prepared = ([], [])
            services_by_account[account_id] = prepared
        prepared[0].append(raw)
        prepared[1].append(fact)

    transactions_by_account: dict[str, TransactionFact] = {}
    transaction_rows = connection.execute(
        """
        SELECT account_id, COUNT(*) AS total_count,
               SUM(CASE WHEN status='not_performed' THEN 1 ELSE 0 END) AS failed_count
        FROM transactions
        GROUP BY account_id
        """
    )
    for row in transaction_rows:
        transactions_by_account[str(row["account_id"])] = TransactionFact(
            total=int(row["total_count"] or 0),
            has_failed=int(row["failed_count"] or 0) > 0,
        )

    return accounts, services_by_account, transactions_by_account


def get_weights(connection: Connection) -> dict[str, float]:
    row = connection.execute(
        "SELECT value FROM settings WHERE key='weights'"
    ).fetchone()
    stored = json.loads(row[0]) if row else {}
    return {**DEFAULT_WEIGHTS, **stored}


def update_weights(
    connection: Connection, changes: dict[str, float]
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
        "ON CONFLICT(key) DO UPDATE SET value=CAST(metadata.value AS INTEGER)+1"
    )
    return weights


def _rate_key_attempts(connection: Connection, key: str) -> tuple[bool, int]:
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
    with registry_db() as connection:
        return _rate_key_attempts(connection, key)


def record_login_failure(key: str) -> None:
    now = utcnow().timestamp()
    with registry_db() as connection:
        connection.execute(
            "DELETE FROM login_attempts WHERE window_started<?",
            (now - LOGIN_WINDOW_SECONDS,),
        )
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
    with registry_db() as connection:
        connection.execute("DELETE FROM login_attempts WHERE key=?", (key,))


def _table_columns(connection: Connection, table: str) -> set[str]:
    if connection.dialect == "sqlite":
        return {
            str(row[1])
            for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
    return {
        str(row[0])
        for row in connection.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema=current_schema() AND table_name=?",
            (table,),
        ).fetchall()
    }


class RegisteredUserExistsError(ValueError):
    """The normalized preview username is already taken."""


def ensure_auth_schema(connection: Connection) -> None:
    """Create the public-preview account registry and session columns.

    Accounts and sessions live in the configured main database.  A
    registered session additionally stores the file name of that
    user's isolated demo workspace; the administrator/OIDC session
    keeps ``workspace_file`` empty and therefore uses the main data.
    """

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS registered_users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            username_normalized TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            workspace_file TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_login_at TEXT
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS registered_users_created_idx "
        "ON registered_users(created_at)"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )
    existing = _table_columns(connection, "sessions")
    if "auth_kind" not in existing:
        connection.execute(
            "ALTER TABLE sessions ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'admin'"
        )
    if "workspace_file" not in existing:
        connection.execute(
            "ALTER TABLE sessions ADD COLUMN workspace_file TEXT"
        )


def _registered_user_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "username": str(row["username"]),
        "usernameNormalized": str(row["username_normalized"]),
        "passwordHash": str(row["password_hash"]),
        "workspaceFile": str(row["workspace_file"]),
        "createdAt": str(row["created_at"]),
        "lastLoginAt": (
            str(row["last_login_at"]) if row["last_login_at"] is not None else None
        ),
    }


def count_registered_users() -> int:
    with registry_db() as connection:
        ensure_auth_schema(connection)
        row = connection.execute(
            "SELECT COUNT(*) AS total FROM registered_users"
        ).fetchone()
    return int(row["total"] or 0) if row is not None else 0


def get_registered_user(username_normalized: str) -> dict[str, Any] | None:
    with registry_db() as connection:
        ensure_auth_schema(connection)
        row = connection.execute(
            "SELECT id, username, username_normalized, password_hash, "
            "workspace_file, created_at, last_login_at "
            "FROM registered_users WHERE username_normalized=?",
            (username_normalized,),
        ).fetchone()
    return _registered_user_dict(row) if row is not None else None


def create_registered_user(
    *,
    user_id: str,
    username: str,
    username_normalized: str,
    password_hash_value: str,
    workspace_file: str,
) -> dict[str, Any]:
    created_at = iso(utcnow())
    with registry_db() as connection:
        ensure_auth_schema(connection)
        existing = connection.execute(
            "SELECT 1 FROM registered_users WHERE username_normalized=?",
            (username_normalized,),
        ).fetchone()
        if existing is not None:
            raise RegisteredUserExistsError(username_normalized)
        connection.execute(
            """
            INSERT INTO registered_users (
                id, username, username_normalized, password_hash,
                workspace_file, created_at, last_login_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                user_id,
                username,
                username_normalized,
                password_hash_value,
                workspace_file,
                created_at,
            ),
        )
    return {
        "id": user_id,
        "username": username,
        "usernameNormalized": username_normalized,
        "passwordHash": password_hash_value,
        "workspaceFile": workspace_file,
        "createdAt": created_at,
        "lastLoginAt": None,
    }


def delete_registered_user(user_id: str) -> None:
    with registry_db() as connection:
        ensure_auth_schema(connection)
        connection.execute(
            "DELETE FROM registered_users WHERE id=?", (user_id,)
        )


def touch_registered_user_login(user_id: str) -> None:
    with registry_db() as connection:
        ensure_auth_schema(connection)
        connection.execute(
            "UPDATE registered_users SET last_login_at=? WHERE id=?",
            (iso(utcnow()), user_id),
        )


def _ensure_snapshot_fact_columns(connection: Connection) -> None:
    """Add and backfill typed snapshot facts on pre-stage-1 databases."""

    columns_by_table: dict[str, dict[str, str]] = {
        "services": {
            "status": "TEXT NOT NULL DEFAULT ''",
            "price_cents": "BIGINT NOT NULL DEFAULT 0",
            "monthly_revenue_cents": "DOUBLE PRECISION NOT NULL DEFAULT 0",
            "autoprolong": "INTEGER NOT NULL DEFAULT 0",
            "expires_at_ts": "DOUBLE PRECISION",
            "deleted_at_ts": "DOUBLE PRECISION",
        },
        "transactions": {
            "status": "TEXT NOT NULL DEFAULT ''",
        },
    }
    for table, columns in columns_by_table.items():
        existing = _table_columns(connection, table)
        for name, definition in columns.items():
            if name not in existing:
                connection.execute(
                    f"ALTER TABLE {table} ADD COLUMN {name} {definition}"
                )

    for statement in (
        (
            "CREATE INDEX IF NOT EXISTS services_account_status_idx "
            "ON services(account_id, status)"
        ),
        "CREATE INDEX IF NOT EXISTS services_expires_idx ON services(expires_at_ts)",
        (
            "CREATE INDEX IF NOT EXISTS transactions_account_status_idx "
            "ON transactions(account_id, status)"
        ),
    ):
        connection.execute(statement)

    version_row = connection.execute(
        "SELECT value FROM metadata WHERE key='snapshot_facts_version'"
    ).fetchone()
    if version_row is not None and str(version_row[0]) == "1":
        return

    service_rows = connection.execute("SELECT id, data FROM services").fetchall()
    service_updates: list[tuple[Any, ...]] = []
    for row in service_rows:
        fact = build_service_fact(_json_object(row["data"]))
        service_updates.append(
            (
                fact.status,
                round(fact.price),
                fact.monthly_revenue,
                int(fact.autoprolong),
                fact.expires_ts,
                fact.deleted_ts,
                row["id"],
            )
        )
        if len(service_updates) >= 5000:
            connection.executemany(
                """
                UPDATE services
                SET status=?, price_cents=?, monthly_revenue_cents=?,
                    autoprolong=?, expires_at_ts=?, deleted_at_ts=?
                WHERE id=?
                """,
                service_updates,
            )
            service_updates.clear()
    if service_updates:
        connection.executemany(
            """
            UPDATE services
            SET status=?, price_cents=?, monthly_revenue_cents=?,
                autoprolong=?, expires_at_ts=?, deleted_at_ts=?
            WHERE id=?
            """,
            service_updates,
        )

    transaction_rows = connection.execute(
        "SELECT id, data FROM transactions"
    ).fetchall()
    transaction_updates: list[tuple[Any, ...]] = []
    for row in transaction_rows:
        status = str(_json_object(row["data"]).get("status", "")).strip().casefold()
        transaction_updates.append((status, row["id"]))
        if len(transaction_updates) >= 5000:
            connection.executemany(
                "UPDATE transactions SET status=? WHERE id=?", transaction_updates
            )
            transaction_updates.clear()
    if transaction_updates:
        connection.executemany(
            "UPDATE transactions SET status=? WHERE id=?", transaction_updates
        )

    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('snapshot_facts_version', '1') "
        "ON CONFLICT(key) DO UPDATE SET value='1'"
    )


def init_db() -> None:
    with db() as connection:
        acquire_schema_lock(connection)
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS services (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            data TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT '',
            price_cents BIGINT NOT NULL DEFAULT 0,
            monthly_revenue_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
            autoprolong INTEGER NOT NULL DEFAULT 0,
            expires_at_ts DOUBLE PRECISION,
            deleted_at_ts DOUBLE PRECISION
        );
        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            data TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, auth_kind TEXT NOT NULL DEFAULT 'admin', workspace_file TEXT);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, window_started REAL NOT NULL, attempts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oidc_states (state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at TEXT NOT NULL);
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
        CREATE TABLE IF NOT EXISTS risk_monitor_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS services_account_id_idx ON services(account_id);
        CREATE INDEX IF NOT EXISTS transactions_account_id_idx ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS oidc_states_expires_idx ON oidc_states(expires_at);
        CREATE INDEX IF NOT EXISTS login_attempts_window_idx ON login_attempts(window_started);
        """)
        _ensure_snapshot_fact_columns(connection)
        ensure_auth_schema(connection)
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
