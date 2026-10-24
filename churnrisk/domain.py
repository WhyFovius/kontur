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


# Buckets for the fact/forecast churn chart: historical deletions look
# back 90 days; the forecast looks forward 90 days.  Both series are
# derived from the same analysed customers, so the chart always agrees
# with the rating, the money estimate and /metrics.
PAST_BUCKETS: tuple[tuple[float, float, str], ...] = (
    (-90, -61, "90–61 дн. назад"),
    (-60, -31, "60–31 дн. назад"),
    (-30, -1, "30–1 дн. назад"),
)
FUTURE_BUCKETS: tuple[tuple[float, float, str], ...] = (
    (0, 7, "0–7 дн."),
    (8, 14, "8–14 дн."),
    (15, 30, "15–30 дн."),
    (31, 90, "31–90 дн."),
)


def _bucket_index(buckets, days: float) -> int | None:
    for index, (low, high, _label) in enumerate(buckets):
        if low <= days <= high:
            return index
    return None


def churn_timeline(
    customers: list[dict[str, Any]], now: datetime | None = None
) -> dict[str, Any]:
    """Historical deletions (fact) + expected non-renewals (forecast).

    Fact: services with status ``deleted`` bucketed by deletion date
    (``deletedAt`` when present, otherwise ``expiresAt`` as the last
    known end of the service).  Forecast: billable services expiring in
    the next 90 days that are at risk — without autoprolong, or owned by
    a medium/high-risk customer — plus every ``prolong_wait`` service in
    the nearest bucket.  ``expectedNonRenewals`` weights each at-risk
    service by the same risk factor used for the money estimate
    (0.80 / 0.45 / 0.15), so the forecast is a fractional expectation,
    not a promise.
    """
    moment = now or utcnow()
    past_deleted = [0] * len(PAST_BUCKETS)
    future_at_risk = [0] * len(FUTURE_BUCKETS)
    future_expected = [0.0] * len(FUTURE_BUCKETS)
    deleted_total = 0

    for customer in customers:
        factor = RISK_FACTORS.get(customer.get("riskLevel"), 0)
        risky_owner = customer.get("riskLevel") in {"high", "medium"}
        for service in customer.get("services", []):
            status = str(service.get("status", "")).lower()
            if status == "deleted":
                deleted_total += 1
                deleted_at = parse_date(service.get("deletedAt")) or parse_date(
                    service.get("expiresAt")
                )
                if deleted_at is not None:
                    days = (deleted_at - moment).total_seconds() / 86400
                    index = _bucket_index(PAST_BUCKETS, days)
                    if index is not None:
                        past_deleted[index] += 1
                continue
            if status == "prolong_wait":
                future_at_risk[0] += 1
                future_expected[0] += factor
                continue
            if status not in {"active", "suspended"}:
                continue
            expires = parse_date(service.get("expiresAt"))
            if expires is None:
                continue
            days = (expires - moment).total_seconds() / 86400
            index = _bucket_index(FUTURE_BUCKETS, days)
            if index is None:
                continue
            if service.get("autoprolong", False) and not risky_owner:
                continue
            future_at_risk[index] += 1
            future_expected[index] += factor

    at_risk_30d = sum(future_at_risk[:3])
    expected_30d = round(sum(future_expected[:3]), 2)
    return {
        "generatedAt": iso(moment),
        "past": [
            {
                "label": label,
                "fromDays": int(low),
                "toDays": int(high),
                "deleted": past_deleted[index],
            }
            for index, (low, high, label) in enumerate(PAST_BUCKETS)
        ],
        "future": [
            {
                "label": label,
                "fromDays": int(low),
                "toDays": int(high),
                "servicesAtRisk": future_at_risk[index],
                "expectedNonRenewals": round(future_expected[index], 2),
            }
            for index, (low, high, label) in enumerate(FUTURE_BUCKETS)
        ],
        "totals": {
            "deletedServices": deleted_total,
            "deleted90d": sum(past_deleted),
            "servicesAtRisk30d": at_risk_30d,
            "expectedNonRenewals30d": expected_30d,
            "servicesAtRisk90d": sum(future_at_risk),
            "expectedNonRenewals90d": round(sum(future_expected), 2),
        },
        "method": (
            "Факт — услуги со статусом deleted по дате удаления "
            "(deletedAt, иначе expiresAt). Прогноз — услуги под риском: "
            "prolong_wait и истекающие без автопродления или у клиентов "
            "среднего/высокого риска; ожидаемые непродления взвешены "
            "коэффициентами риска 0,80 / 0,45 / 0,15."
        ),
    }


# ---------------------------------------------------------------------------
# Realtime risk radar: alert candidates + rescue prioritisation
# ---------------------------------------------------------------------------

CRITICAL_SCORE_THRESHOLD = 80
LARGE_LOSS_THRESHOLD_CENTS = 50_000
_ALERT_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


def _service_days(service: dict[str, Any], now: datetime) -> float | None:
    expires = parse_date(service.get("expiresAt"))
    if expires is None:
        return None
    return (expires - now).total_seconds() / 86400


def _due_services(customer: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    return [
        service
        for service in customer.get("services", [])
        if _due_soon(service, now)
    ]


def _shortage(customer: dict[str, Any], now: datetime) -> int:
    due_amount = sum(
        _number(service.get("price")) for service in _due_services(customer, now)
    )
    available = _number(customer.get("availableBalance", customer.get("balance")))
    return round(max(0.0, due_amount - available))


def _nearest_deadline(
    customer: dict[str, Any], now: datetime
) -> tuple[datetime | None, float | None, dict[str, Any] | None]:
    candidates: list[tuple[datetime, dict[str, Any]]] = []
    for service in customer.get("services", []):
        status = str(service.get("status", "")).lower()
        if status == "prolong_wait":
            candidates.append((parse_date(service.get("expiresAt")) or now, service))
        elif _is_billable(service):
            expires = parse_date(service.get("expiresAt"))
            if expires is not None:
                candidates.append((expires, service))
    if not candidates:
        return None, None, None
    deadline, service = min(candidates, key=lambda item: item[0])
    return deadline, (deadline - now).total_seconds() / 86400, service


def _urgency_component(days: float | None, features: dict[str, bool]) -> float:
    if features.get("prolong_wait") or (days is not None and days <= 0):
        return 22.0
    if days is None:
        return 4.0
    if days <= 3:
        return 20.0
    if days <= 7:
        return 16.0
    if days <= 14:
        return 11.0
    if days <= 30:
        return 6.0
    return 2.0


def _predicted_score(
    customer: dict[str, Any],
    weights: dict[str, float],
    removed_features: set[str],
) -> int | None:
    if customer.get("score") is None:
        return None
    total = sum(max(_number(weights.get(feature.key, feature.default_weight)), 0.0) for feature in FEATURES)
    if total <= 0:
        return 0
    active = sum(
        max(_number(weights.get(feature.key, feature.default_weight)), 0.0)
        for feature in FEATURES
        if customer.get("features", {}).get(feature.key)
        and feature.key not in removed_features
    )
    return round(100 * active / total)


def rescue_queue(
    customers: list[dict[str, Any]],
    weights: dict[str, float] | None = None,
    now: datetime | None = None,
    limit: int = 10,
    minimum_score: int = 65,
) -> dict[str, Any]:
    """Server-side rescue queue: what to do, by when, and what it is worth.

    Unlike a plain score sort, priority combines the already risk-weighted
    90-day loss with how actionable the dominant signal is and how little
    time is left.  ``rescueValue`` never exceeds the customer's estimated
    loss; urgency changes the order through ``priorityIndex`` rather than
    inflating the money figure.
    """
    moment = now or utcnow()
    effective_weights = weights or DEFAULT_WEIGHTS
    items: list[dict[str, Any]] = []

    for customer in customers:
        score = customer.get("score")
        if score is None:
            continue
        features = customer.get("features", {})
        if score < minimum_score and not features.get("prolong_wait"):
            continue

        shortage = _shortage(customer, moment)
        deadline, days, deadline_service = _nearest_deadline(customer, moment)
        if features.get("prolong_wait"):
            action_type = "pay_now"
            action_label = "Закрыть ожидание оплаты сегодня"
            action_detail = (
                "Услуга уже находится в льготном периоде. Нужен короткий "
                "контакт и готовая ссылка на оплату до отключения."
            )
            removed = {"prolong_wait"}
            actionability = 0.95
        elif shortage > 0:
            action_type = "top_up"
            action_label = "Предложить точное пополнение"
            action_detail = (
                f"На ближайшие продления не хватает {_money_cents(shortage)}. "
                "Это самая дешёвая точка спасения выручки."
            )
            removed = {"insufficient_funds"}
            actionability = 0.92
        elif features.get("expiring_without_autoprolong"):
            action_type = "enable_autoprolong"
            action_label = "Включить автопродление"
            action_detail = (
                "Услуга заканчивается без автопродления. Подтверждение "
                "продления снимает главный временной сигнал."
            )
            removed = {"expiring_without_autoprolong"}
            actionability = 0.88
        elif features.get("failed_transactions"):
            action_type = "fix_payment_method"
            action_label = "Проверить способ оплаты"
            action_detail = (
                "Есть незавершённый платёж. Стоит предложить резервный "
                "способ оплаты до следующего списания."
            )
            removed = {"failed_transactions"}
            actionability = 0.78
        elif features.get("deleted_services"):
            action_type = "winback_call"
            action_label = "Выявить причину удалений"
            action_detail = (
                "Клиент уже сокращал набор услуг. Нужен разговор о ценности "
                "и возможной смене тарифа, а не ещё один общий оффер."
            )
            removed = {"deleted_services"}
            actionability = 0.62
        else:
            action_type = "contact"
            action_label = "Связаться и подтвердить планы"
            action_detail = "Скор высокий, но одного доминирующего технического сигнала нет."
            removed = set()
            actionability = 0.6

        estimated_loss = round(_number(customer.get("estimatedLoss")))
        rescue_value = round(min(estimated_loss, estimated_loss * actionability))
        money_component = min(38.0, math.log1p(max(rescue_value, 0) / 100) * 8)
        priority = round(
                min(
                    100.0,
                    max(
                        1.0,
                        score * 0.4
                        + money_component
                        + _urgency_component(days, features),
                    ),
                )
            )
        active_signals = sum(1 for enabled in features.values() if enabled)
        if deadline is not None and active_signals >= 2:
            confidence, confidence_score = "high", 90
        elif deadline is not None or active_signals >= 2:
            confidence, confidence_score = "medium", 70
        else:
            confidence, confidence_score = "low", 50

        items.append(
            {
                "customerId": customer["id"],
                "email": customer.get("email") or "—",
                "score": score,
                "riskLevel": customer.get("riskLevel"),
                "estimatedLoss": estimated_loss,
                "monthlyRevenue": round(_number(customer.get("monthlyRevenue"))),
                "rescueValue": rescue_value,
                "valuePerDay": round(rescue_value / max(1.0, math.ceil(days)) if days is not None else rescue_value),
                "priorityIndex": priority,
                "actionType": action_type,
                "actionLabel": action_label,
                "actionDetail": action_detail,
                "requiredTopUp": shortage if shortage > 0 else None,
                "deadlineAt": iso(deadline) if deadline else None,
                "dueInDays": round(days, 1) if days is not None else None,
                "serviceName": deadline_service.get("name") if deadline_service else None,
                "predictedScoreAfterAction": _predicted_score(
                    customer, effective_weights, removed
                ),
                "confidence": confidence,
                "confidenceScore": confidence_score,
                "reasons": list(customer.get("reasons", []))[:2],
            }
        )

    items.sort(
        key=lambda item: (
            -item["priorityIndex"],
            -item["rescueValue"],
            item["dueInDays"] if item["dueInDays"] is not None else 9999,
        )
    )
    for index, item in enumerate(items, start=1):
        item["rank"] = index

    return {
        "generatedAt": iso(moment),
        "items": items[: max(1, limit)],
        "totals": {
            "eligibleCustomers": len(items),
            "criticalCustomers": sum(
                1 for item in items if item["score"] >= CRITICAL_SCORE_THRESHOLD
            ),
            "rescueValue": sum(item["rescueValue"] for item in items),
            "top3RescueValue": sum(item["rescueValue"] for item in items[:3]),
            "requiredTopUps": sum(item["requiredTopUp"] or 0 for item in items),
        },
        "method": (
            "Приоритет = скор (40%) + денежная ценность действия + срочность "
            "по ближайшему дедлайну. Rescue value не превышает уже взвешенную "
            "оценку потерь на 90 дней; прогноз скора показывает эффект снятия "
            "главного сигнала при текущих весах."
        ),
    }


def alert_candidates(
    customers: list[dict[str, Any]], now: datetime | None = None
) -> list[dict[str, Any]]:
    """Currently true risk conditions that deserve an operator alert."""
    moment = now or utcnow()
    candidates: list[dict[str, Any]] = []

    for customer in customers:
        score = customer.get("score")
        if score is None:
            continue
        features = customer.get("features", {})
        shortage = _shortage(customer, moment)
        _deadline, days, _service = _nearest_deadline(customer, moment)
        base = {
            "customerId": customer["id"],
            "customerEmail": customer.get("email") or "—",
            "score": score,
            "riskLevel": customer.get("riskLevel"),
            "estimatedLoss": round(_number(customer.get("estimatedLoss"))),
            "daysToExpiry": round(days, 1) if days is not None else customer.get("daysToExpiry"),
            "requiredTopUp": shortage or None,
        }

        def add(
            event_type: str,
            severity: str,
            title: str,
            message: str,
            _base: dict[str, Any] = base,
            _customer_id: Any = customer["id"],
        ) -> None:
            candidates.append(
                {
                    **_base,
                    "episodeKey": f"{_customer_id}:{event_type}",
                    "type": event_type,
                    "severity": severity,
                    "title": title,
                    "message": message,
                }
            )

        if score >= CRITICAL_SCORE_THRESHOLD:
            add(
                "critical_score",
                "critical",
                f"Критический риск: {score} из 100",
                (customer.get("reasons") or ["Скор выше критического порога 80."])[0],
            )
        if features.get("prolong_wait"):
            add(
                "payment_waiting",
                "critical",
                "Услуга уже ожидает оплаты",
                "Клиент находится в льготном периоде. Если оплату не закрыть сейчас, услуга может отключиться.",
            )

        expiring = [
            service
            for service in customer.get("services", [])
            if _is_billable(service)
            and not service.get("autoprolong", False)
            and (_service_days(service, moment) is not None)
            and 0 <= float(_service_days(service, moment)) <= 3
        ]
        if expiring:
            add(
                "expiry_72h",
                "critical",
                "До окончания услуги меньше 72 часов",
                "Автопродление выключено. Нужно подтверждение продления или включённое автопродление сегодня.",
            )
        if features.get("insufficient_funds") and shortage > 0:
            add(
                "insufficient_funds",
                "critical" if score >= 65 or shortage >= 10_000 else "warning",
                "Не хватает денег на продление",
                f"До ближайших списаний не хватает {_money_cents(shortage)}. Точное пополнение снимает сигнал.",
            )
        if features.get("failed_transactions") and score >= RISK_THRESHOLDS["high"]:
            add(
                "failed_payment",
                "warning",
                "Незавершённый платёж у клиента высокого риска",
                "Проверьте способ оплаты до следующего продления.",
            )
        if base["estimatedLoss"] >= LARGE_LOSS_THRESHOLD_CENTS and score >= RISK_THRESHOLDS["high"]:
            add(
                "large_revenue_at_risk",
                "critical" if base["estimatedLoss"] >= 150_000 else "warning",
                "Крупная выручка под угрозой",
                f"На горизонте 90 дней под риском {_money_cents(base['estimatedLoss'])}.",
            )
        if features.get("deleted_services") and score >= RISK_THRESHOLDS["high"]:
            add(
                "deletion_pattern",
                "warning",
                "Клиент уже сокращал услуги",
                "Повторяющиеся удаления усиливают риск полного ухода. Лучше выяснить причину до следующего продления.",
            )

    candidates.sort(
        key=lambda item: (
            _ALERT_SEVERITY_ORDER.get(item["severity"], 9),
            -item["estimatedLoss"],
            -item["score"],
        )
    )
    return candidates


def customer_risk_state(customers: list[dict[str, Any]]) -> dict[str, Any]:
    """Compact state used by the monitor to detect changes between polls."""
    return {
        str(customer["id"]): {
            "score": customer.get("score"),
            "riskLevel": customer.get("riskLevel"),
            "estimatedLoss": round(_number(customer.get("estimatedLoss"))),
            "features": sorted(
                key for key, enabled in customer.get("features", {}).items() if enabled
            ),
        }
        for customer in customers
    }
