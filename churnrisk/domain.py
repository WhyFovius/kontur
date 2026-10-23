from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True)
class Feature:
    key: str
    label: str
    default_weight: int
    active: Callable[[dict[str, Any]], bool]
    explanation: Callable[[dict[str, Any]], str]


def _is_billable(service: dict[str, Any]) -> bool:
    return str(service.get("status", "")).lower() in {"active", "suspended"}


def _ending_soon(context: dict[str, Any]) -> bool:
    now = context["now"]
    return any(
        _is_billable(service)
        and not service.get("autoprolong", False)
        and (expires := parse_date(service.get("expiresAt"))) is not None
        and 0 <= (expires - now).total_seconds() <= 14 * 86400
        for service in context["services"]
    )


def _due_soon(service: dict[str, Any], now: datetime) -> bool:
    if str(service.get("status", "")).lower() == "prolong_wait":
        return True
    expires = parse_date(service.get("expiresAt"))
    return (
        _is_billable(service)
        and expires is not None
        and 0 <= (expires - now).total_seconds() <= 30 * 86400
    )


def _insufficient_funds(context: dict[str, Any]) -> bool:
    due = [
        service for service in context["services"] if _due_soon(service, context["now"])
    ]
    return bool(due) and context["available_balance"] < sum(
        _number(service.get("price")) for service in due
    )


def _has_prolong_wait(context: dict[str, Any]) -> bool:
    return any(
        str(service.get("status", "")).lower() == "prolong_wait"
        for service in context["services"]
    )


def _has_failed_transaction(context: dict[str, Any]) -> bool:
    return any(
        str(transaction.get("status", "")).lower() == "not_performed"
        for transaction in context["transactions"]
    )


def _deleted_share(context: dict[str, Any]) -> bool:
    services = context["services"]
    return (
        bool(services)
        and sum(
            str(service.get("status", "")).lower() == "deleted" for service in services
        )
        / len(services)
        >= 0.3
    )


def _balance_pressure(context: dict[str, Any]) -> bool:
    return (
        context["monthly_revenue"] > 0
        and context["available_balance"] < context["monthly_revenue"] * 2
    )


FEATURES: tuple[Feature, ...] = (
    Feature(
        "expiring_without_autoprolong",
        "Скорое окончание без автопродления",
        25,
        _ending_soon,
        lambda _: (
            "Есть оплачиваемая услуга без автопродления со сроком окончания в ближайшие 14 дней."
        ),
    ),
    Feature(
        "insufficient_funds",
        "Не хватает средств на продление",
        25,
        _insufficient_funds,
        lambda context: (
            "На продления в ближайшие 30 дней не хватает "
            f"{_money_cents(max(0, context['due_amount'] - context['available_balance']))}."
        ),
    ),
    Feature(
        "prolong_wait",
        "Услуга ожидает оплаты",
        25,
        _has_prolong_wait,
        lambda _: "Услуга ожидает оплаты в течение пятидневного льготного периода.",
    ),
    Feature(
        "failed_transactions",
        "Незавершённые платежи",
        12,
        _has_failed_transaction,
        lambda _: "В снимке есть незавершённые транзакции.",
    ),
    Feature(
        "deleted_services",
        "Удалённые услуги",
        8,
        _deleted_share,
        lambda context: (
            "Удалено не менее 30% услуг аккаунта "
            f"({sum(str(service.get('status', '')).lower() == 'deleted' for service in context['services'])} "
            f"из {len(context['services'])})."
        ),
    ),
    Feature(
        "balance_pressure",
        "Высокая нагрузка на баланс",
        5,
        _balance_pressure,
        lambda _: "Доступного баланса меньше двух месяцев текущих платежей.",
    ),
)
DEFAULT_WEIGHTS = {feature.key: feature.default_weight for feature in FEATURES}
FEATURE_LABELS = {feature.key: feature.label for feature in FEATURES}
RISK_FACTORS = {"high": 0.80, "medium": 0.45, "low": 0.15}
RISK_THRESHOLDS = {"medium": 35, "high": 65}
PAYMENT_PERIODS_PER_MONTH = {
    "hour": 730.5,
    "week": 365.25 / 7 / 12,
    "month": 1.0,
    "quarter_year": 1 / 3,
    "half_year": 1 / 6,
    "year": 1 / 12,
}


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.isoformat()


def parse_date(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        value = value.get("$date", value.get("$numberLong"))
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            seconds = (
                float(value) / 1000
                if abs(float(value)) > 100_000_000_000
                else float(value)
            )
            return datetime.fromtimestamp(seconds, UTC)
        result = datetime.fromisoformat(str(value))
        return (
            result.replace(tzinfo=UTC)
            if result.tzinfo is None
            else result.astimezone(UTC)
        )
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def payment_period(term: str) -> float:
    return PAYMENT_PERIODS_PER_MONTH.get(term, 1.0)


def _number(value: Any) -> float:
    try:
        number = float(value or 0)
        return max(number, 0.0) if math.isfinite(number) else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _money_cents(value: float) -> str:
    return f"{value / 100:,.2f}".replace(",", " ").replace(".", ",") + " €"


def analyze(
    source: dict[str, list[dict[str, Any]]], weights: dict[str, float]
) -> list[dict[str, Any]]:
    service_map: dict[str, list[dict[str, Any]]] = {}
    transaction_map: dict[str, list[dict[str, Any]]] = {}
    for service in source["services"]:
        owner = str(
            service.get(
                "accountId", service.get("userId", service.get("account_id", ""))
            )
        )
        service_map.setdefault(owner, []).append(service)
    for transaction in source["transactions"]:
        owner = str(
            transaction.get(
                "accountId",
                transaction.get("userId", transaction.get("account_id", "")),
            )
        )
        transaction_map.setdefault(owner, []).append(transaction)

    now = utcnow()
    results: list[dict[str, Any]] = []
    normalized_weights = {
        key: max(_number(weights.get(key, feature.default_weight)), 0.0)
        for feature in FEATURES
        for key in (feature.key,)
    }
    total_weight = sum(normalized_weights.values())

    for account in source["accounts"]:
        identifier = str(account.get("id", account.get("_id", "")))
        services = service_map.get(identifier, [])
        transactions = transaction_map.get(identifier, [])
        balance = _number(account.get("balance"))
        bonus = (
            _number(account.get("bonusBalance"))
            if account.get("bonusState") is True
            else 0.0
        )
        available_balance = balance + bonus

        if not services and not transactions:
            results.append(
                {
                    "id": identifier,
                    "email": account.get("email") or "—",
                    "balance": balance,
                    "availableBalance": available_balance,
                    "totalReplenished": _number(account.get("totalReplenished")),
                    "score": None,
                    "riskLevel": "unrated",
                    "reasons": [
                        "Недостаточно данных: у аккаунта нет услуг и транзакций."
                    ],
                    "services": [],
                    "features": {},
                    "estimatedLoss": 0,
                    "monthlyRevenue": 0,
                    "daysToExpiry": None,
                }
            )
            continue

        monthly_services = [service for service in services if _is_billable(service)]
        monthly_revenue = sum(
            _number(service.get("price"))
            * payment_period(str(service.get("paymentTerm", "month")))
            for service in monthly_services
        )
        due_services = [service for service in services if _due_soon(service, now)]
        due_amount = sum(_number(service.get("price")) for service in due_services)
        context: dict[str, Any] = {
            "account": account,
            "services": services,
            "transactions": transactions,
            "now": now,
            "available_balance": available_balance,
            "monthly_revenue": monthly_revenue,
            "due_amount": due_amount,
        }
        signals = {feature.key: feature.active(context) for feature in FEATURES}
        weighted_score = sum(
            normalized_weights[feature.key]
            for feature in FEATURES
            if signals[feature.key]
        )
        score = round(100 * weighted_score / total_weight) if total_weight else 0
        risk_level = "high" if score >= 65 else "medium" if score >= 35 else "low"
        reasons = [
            feature.explanation(context) for feature in FEATURES if signals[feature.key]
        ]
        if not reasons:
            reasons = ["Критические сигналы риска не обнаружены."]

        horizon_revenue = monthly_revenue * 3
        loss = max(0.0, horizon_revenue - available_balance) * RISK_FACTORS[risk_level]
        expiring_dates = [
            (parse_date(service.get("expiresAt")) - now).total_seconds() / 86400
            for service in monthly_services
            if parse_date(service.get("expiresAt")) is not None
        ]
        results.append(
            {
                "id": identifier,
                "email": account.get("email") or "—",
                "balance": balance,
                "availableBalance": available_balance,
                "totalReplenished": _number(account.get("totalReplenished")),
                "score": score,
                "riskLevel": risk_level,
                "reasons": reasons,
                "services": services,
                "features": signals,
                "estimatedLoss": round(loss),
                "monthlyRevenue": round(monthly_revenue),
                "daysToExpiry": round(min(expiring_dates), 1)
                if expiring_dates
                else None,
            }
        )
    return results


def summary(customers: list[dict[str, Any]]) -> dict[str, Any]:
    now = utcnow()
    at_risk_services = 0
    waiting_services = 0
    expiring_days: list[float] = []
    for customer in customers:
        for service in customer.get("services", []):
            status = str(service.get("status", "")).lower()
            expires = parse_date(service.get("expiresAt"))
            days = (expires - now).total_seconds() / 86400 if expires else None
            expiring = (
                status in {"active", "suspended"}
                and days is not None
                and 0 <= days <= 14
                and not service.get("autoprolong", False)
            )
            at_risk_services += int(status == "prolong_wait" or expiring)
            waiting_services += int(status == "prolong_wait")
            if (
                status in {"active", "suspended"}
                and not service.get("autoprolong", False)
                and days is not None
                and 0 <= days <= 30
            ):
                expiring_days.append(days)

    forecast = [
        waiting_services + sum(day <= horizon for day in expiring_days)
        for horizon in (0, 7, 14, 21, 30)
    ]
    return {
        "customerCount": len(customers),
        "ratedCount": sum(customer["score"] is not None for customer in customers),
        "unratedCount": sum(customer["score"] is None for customer in customers),
        "highRisk": sum(customer["riskLevel"] == "high" for customer in customers),
        "mediumRisk": sum(customer["riskLevel"] == "medium" for customer in customers),
        "lowRisk": sum(customer["riskLevel"] == "low" for customer in customers),
        "estimatedLoss": round(
            sum(customer["estimatedLoss"] for customer in customers)
        ),
        "monthlyRevenueAtRisk": round(
            sum(
                customer["monthlyRevenue"] * RISK_FACTORS.get(customer["riskLevel"], 0)
                for customer in customers
            )
        ),
        "atRiskServices": at_risk_services,
        "churnForecast": {"days": [0, 7, 14, 21, 30], "counts": forecast},
    }
