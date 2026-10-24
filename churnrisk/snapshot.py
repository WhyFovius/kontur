from __future__ import annotations

from typing import Any

COLLECTION_ALIASES = {
    "accounts": ("accounts", "users", "customers", "clients"),
    "services": ("services", "subscriptions"),
    "transactions": ("transactions", "payments"),
}
FIELD_ALIASES = {
    "id": ("id", "_id"),
    "email": ("email", "email_address"),
    "accountId": ("accountId", "account_id", "userId", "user_id", "customerId", "customer_id", "client_id"),
    "withdrawBalance": ("withdrawBalance", "withdraw_balance"),
    "bonusBalance": ("bonusBalance", "bonus_balance"),
    "bonusState": (
        "bonusState",
        "bonus_state",
        "bonusStatus",
        "bonus_status",
        "bonusActive",
        "bonus_active",
        "bonusEnabled",
        "bonus_enabled",
    ),
    "totalReplenished": ("totalReplenished", "total_replenished"),
    "paymentTerm": ("paymentTerm", "payment_term", "billing_period"),
    "autoprolong": ("autoprolong", "auto_renew", "autoRenew"),
    "expiresAt": ("expiresAt", "expires_at", "expiration_date"),
    "deletedAt": ("deletedAt", "deleted_at", "removedAt", "removed_at"),
}


def _pick(source: dict[str, Any], aliases: tuple[str, ...], path: str) -> Any:
    present = [key for key in aliases if key in source]
    if len(present) > 1:
        raise ValueError(f"{path}: ambiguous fields: {', '.join(present)}")
    return source[present[0]] if present else None


def _rows(value: Any, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError(f"{path}: expected an array of objects")
    return value


def _fields(row: dict[str, Any], path: str) -> dict[str, Any]:
    result = dict(row)
    for field, aliases in FIELD_ALIASES.items():
        if any(alias in row for alias in aliases):
            result[field] = _pick(row, aliases, f"{path}.{field}")
            for alias in aliases:
                if alias != field:
                    result.pop(alias, None)
    return result


def normalize_snapshot(value: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise TypeError("Snapshot must be a JSON object")
    source = value
    collection_keys = {alias for aliases in COLLECTION_ALIASES.values() for alias in aliases}
    wrappers = [key for key in ("data", "snapshot") if key in source]
    if wrappers:
        if len(wrappers) != 1 or collection_keys.intersection(source):
            raise ValueError("Ambiguous snapshot envelope")
        source = source[wrappers[0]]
        if not isinstance(source, dict):
            raise ValueError("Snapshot envelope must contain a JSON object")
    if not any(key in source for key in COLLECTION_ALIASES["accounts"]):
        raise ValueError("Missing accounts collection: use accounts, users, customers or clients")

    result: dict[str, list[dict[str, Any]]] = {}
    for table, aliases in COLLECTION_ALIASES.items():
        records = _pick(source, aliases, table) if any(alias in source for alias in aliases) else []
        result[table] = [
            _fields(row, f"{table}[{index}]")
            for index, row in enumerate(_rows(records, table))
        ]
    for index, account in enumerate(result["accounts"]):
        for table in ("services", "transactions"):
            aliases = COLLECTION_ALIASES[table]
            if not any(alias in account for alias in aliases):
                continue
            path = f"accounts[{index}].{table}"
            nested = _rows(_pick(account, aliases, path), path)
            owner = account.get("id")
            if owner is None:
                raise ValueError(f"accounts[{index}]: nested records require an account id")
            for nested_index, row in enumerate(nested):
                item = _fields(row, f"{path}[{nested_index}]")
                if "accountId" in item:
                    raise ValueError(f"{path}[{nested_index}]: owner is already defined by nesting")
                item["accountId"] = owner
                result[table].append(item)
            for alias in aliases:
                account.pop(alias, None)
    return result
