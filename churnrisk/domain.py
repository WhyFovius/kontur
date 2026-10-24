from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, NamedTuple


@dataclass(frozen=True)
class Feature:
    key: str
    label: str
    default_weight: int


class ServiceFact(NamedTuple):
    """Typed, pre-parsed service values used by every analytics pass."""

    status: str
    billable: bool
    price: float
    monthly_revenue: float
    autoprolong: bool
    expires_ts: float | None
    deleted_ts: float | None


class TransactionFact(NamedTuple):
    """The only transaction aggregates the current rule model needs."""

    total: int
    has_failed: bool


def _is_billable(service: dict[str, Any]) -> bool:
    return str(service.get("status", "")).lower() in {"active", "suspended"}


def _due_soon(service: dict[str, Any], now: datetime) -> bool:
    return _fact_due_soon(build_service_fact(service), now.timestamp())


FEATURES: tuple[Feature, ...] = (
    Feature("expiring_without_autoprolong", "Скорое окончание без автопродления", 25),
    Feature("insufficient_funds", "Не хватает средств на продление", 25),
    Feature("prolong_wait", "Услуга ожидает оплаты", 25),
    Feature("failed_transactions", "Незавершённые платежи", 12),
    Feature("deleted_services", "Удалённые услуги", 8),
    Feature("balance_pressure", "Высокая нагрузка на баланс", 5),
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


@lru_cache(maxsize=16_384)
def _iso_timestamp(value: str) -> float | None:
    try:
        result = datetime.fromisoformat(value)
        if result.tzinfo is None:
            result = result.replace(tzinfo=UTC)
        else:
            result = result.astimezone(UTC)
        return result.timestamp()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _value_timestamp(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        return _value_timestamp(value.get("$date", value.get("$numberLong")))
    if isinstance(value, datetime):
        result = (
            value.replace(tzinfo=UTC)
            if value.tzinfo is None
            else value.astimezone(UTC)
        )
        try:
            return result.timestamp()
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number / 1000 if abs(number) > 100_000_000_000 else number
    return _iso_timestamp(str(value))


def parse_date(value: Any) -> datetime | None:
    timestamp = _value_timestamp(value)
    if timestamp is None:
        return None
    try:
        return datetime.fromtimestamp(timestamp, UTC)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def payment_period(term: str) -> float:
    return PAYMENT_PERIODS_PER_MONTH.get(term, 1.0)


def _number(value: Any) -> float:
    if type(value) is int:
        return float(value) if value > 0 else 0.0
    if type(value) is float:
        return value if math.isfinite(value) and value > 0 else 0.0
    if value is None:
        return 0.0
    try:
        number = float(value or 0)
        return max(number, 0.0) if math.isfinite(number) else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


def build_service_fact(service: dict[str, Any]) -> ServiceFact:
    """Parse one raw service dict into the typed values analytics need."""

    status = str(service.get("status", "")).lower()
    price = _number(service.get("price"))
    expires_raw = service.get("expiresAt")
    deleted_raw = service.get("deletedAt")
    return ServiceFact(
        status=status,
        billable=status in {"active", "suspended"},
        price=price,
        monthly_revenue=price
        * PAYMENT_PERIODS_PER_MONTH.get(
            str(service.get("paymentTerm", "month")), 1.0
        ),
        autoprolong=bool(service.get("autoprolong", False)),
        expires_ts=(
            _value_timestamp(expires_raw)
            if expires_raw is not None and expires_raw != ""
            else None
        ),
        deleted_ts=(
            _value_timestamp(deleted_raw)
            if deleted_raw is not None and deleted_raw != ""
            else None
        ),
    )


def _fact_due_soon(fact: ServiceFact, now_ts: float) -> bool:
    if fact.status == "prolong_wait":
        return True
    return (
        fact.billable
        and fact.expires_ts is not None
        and now_ts <= fact.expires_ts <= now_ts + 30 * 86400
    )


def _facts_for_customer(customer: dict[str, Any]) -> list[ServiceFact]:
    services = customer.get("services", [])
    facts = customer.get("_serviceFacts")
    if (
        isinstance(facts, list)
        and len(facts) == len(services)
        and (not facts or isinstance(facts[0], ServiceFact))
    ):
        return facts
    return [build_service_fact(service) for service in services]


def _owner_id(row: dict[str, Any]) -> str:
    try:
        return str(row["accountId"])
    except KeyError:
        return str(row.get("userId", row.get("account_id", "")))


def _money_cents(value: float) -> str:
    return f"{value / 100:,.2f}".replace(",", " ").replace(".", ",") + " €"


def analyze_prepared(
    accounts: list[dict[str, Any]],
    services_by_account: dict[
        str, tuple[list[dict[str, Any]], list[ServiceFact]]
    ],
    transactions_by_account: dict[str, TransactionFact],
    weights: dict[str, float],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Score prepared snapshot facts without re-parsing raw JSON rows."""

    now = now or utcnow()
    now_ts = now.timestamp()
    results: list[dict[str, Any]] = []
    normalized_weights = {
        key: max(_number(weights.get(key, feature.default_weight)), 0.0)
        for feature in FEATURES
        for key in (feature.key,)
    }
    total_weight = sum(normalized_weights.values())

    for account in accounts:
        identifier = str(account.get("id", account.get("_id", "")))
        prepared_services = services_by_account.get(identifier)
        if prepared_services is None:
            services: list[dict[str, Any]] = []
            facts: list[ServiceFact] = []
        else:
            services, facts = prepared_services
        transaction_fact = transactions_by_account.get(
            identifier, TransactionFact(total=0, has_failed=False)
        )
        balance = _number(account.get("balance"))
        bonus = (
            _number(account.get("bonusBalance"))
            if account.get("bonusState") is True
            else 0.0
        )
        available_balance = balance + bonus

        if not services and transaction_fact.total == 0:
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
                    "_serviceFacts": [],
                    "features": {},
                    "estimatedLoss": 0,
                    "monthlyRevenue": 0,
                    "daysToExpiry": None,
                }
            )
            continue

        monthly_revenue = 0.0
        due_amount = 0.0
        has_due_service = False
        ending_soon = False
        has_prolong_wait = False
        deleted_count = 0
        nearest_expiry_ts: float | None = None
        ending_deadline = now_ts + 14 * 86400

        for fact in facts:
            if fact.billable:
                monthly_revenue += fact.monthly_revenue
                if fact.expires_ts is not None:
                    if (
                        nearest_expiry_ts is None
                        or fact.expires_ts < nearest_expiry_ts
                    ):
                        nearest_expiry_ts = fact.expires_ts
                    if (
                        not fact.autoprolong
                        and now_ts <= fact.expires_ts <= ending_deadline
                    ):
                        ending_soon = True
            if fact.status == "prolong_wait":
                has_prolong_wait = True
            elif fact.status == "deleted":
                deleted_count += 1
            if _fact_due_soon(fact, now_ts):
                has_due_service = True
                due_amount += fact.price

        insufficient_funds = has_due_service and available_balance < due_amount
        deleted_services = bool(facts) and deleted_count / len(facts) >= 0.3
        balance_pressure = (
            monthly_revenue > 0 and available_balance < monthly_revenue * 2
        )
        signals = {
            "expiring_without_autoprolong": ending_soon,
            "insufficient_funds": insufficient_funds,
            "prolong_wait": has_prolong_wait,
            "failed_transactions": transaction_fact.has_failed,
            "deleted_services": deleted_services,
            "balance_pressure": balance_pressure,
        }
        weighted_score = (
            (normalized_weights["expiring_without_autoprolong"] if ending_soon else 0.0)
            + (normalized_weights["insufficient_funds"] if insufficient_funds else 0.0)
            + (normalized_weights["prolong_wait"] if has_prolong_wait else 0.0)
            + (
                normalized_weights["failed_transactions"]
                if transaction_fact.has_failed
                else 0.0
            )
            + (normalized_weights["deleted_services"] if deleted_services else 0.0)
            + (normalized_weights["balance_pressure"] if balance_pressure else 0.0)
        )
        score = round(100 * weighted_score / total_weight) if total_weight else 0
        risk_level = (
            "high"
            if score >= RISK_THRESHOLDS["high"]
            else "medium"
            if score >= RISK_THRESHOLDS["medium"]
            else "low"
        )

        reasons: list[str] = []
        if signals["expiring_without_autoprolong"]:
            reasons.append(
                "Есть оплачиваемая услуга без автопродления со сроком окончания в ближайшие 14 дней."
            )
        if signals["insufficient_funds"]:
            reasons.append(
                "На продления в ближайшие 30 дней не хватает "
                f"{_money_cents(max(0.0, due_amount - available_balance))}."
            )
        if signals["prolong_wait"]:
            reasons.append(
                "Услуга ожидает оплаты в течение пятидневного льготного периода."
            )
        if signals["failed_transactions"]:
            reasons.append("В снимке есть незавершённые транзакции.")
        if signals["deleted_services"]:
            reasons.append(
                "Удалено не менее 30% услуг аккаунта "
                f"({deleted_count} из {len(facts)})."
            )
        if signals["balance_pressure"]:
            reasons.append(
                "Доступного баланса меньше двух месяцев текущих платежей."
            )
        if not reasons:
            reasons = ["Критические сигналы риска не обнаружены."]

        horizon_revenue = monthly_revenue * 3
        loss = max(0.0, horizon_revenue - available_balance) * RISK_FACTORS[risk_level]
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
                "_serviceFacts": facts,
                "features": signals,
                "estimatedLoss": round(loss),
                "monthlyRevenue": round(monthly_revenue),
                "daysToExpiry": (
                    round((nearest_expiry_ts - now_ts) / 86400, 1)
                    if nearest_expiry_ts is not None
                    else None
                ),
            }
        )
    return results


def analyze(
    source: dict[str, list[dict[str, Any]]],
    weights: dict[str, float],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Compatibility wrapper: group and prepare a raw snapshot, then score it."""

    services_by_account: dict[
        str, tuple[list[dict[str, Any]], list[ServiceFact]]
    ] = {}
    for service in source["services"]:
        owner = _owner_id(service)
        prepared = services_by_account.get(owner)
        if prepared is None:
            prepared = ([], [])
            services_by_account[owner] = prepared
        prepared[0].append(service)
        prepared[1].append(build_service_fact(service))

    transaction_counts: dict[str, list[int]] = {}
    for transaction in source["transactions"]:
        owner = _owner_id(transaction)
        counts = transaction_counts.get(owner)
        if counts is None:
            counts = [0, 0]
            transaction_counts[owner] = counts
        counts[0] += 1
        if str(transaction.get("status", "")).lower() == "not_performed":
            counts[1] = 1
    transactions_by_account = {
        owner: TransactionFact(total=counts[0], has_failed=bool(counts[1]))
        for owner, counts in transaction_counts.items()
    }
    return analyze_prepared(
        source["accounts"],
        services_by_account,
        transactions_by_account,
        weights,
        now=now,
    )


def summary(
    customers: list[dict[str, Any]], *, now: datetime | None = None
) -> dict[str, Any]:
    moment = now or utcnow()
    now_ts = moment.timestamp()
    at_risk_services = 0
    waiting_services = 0
    forecast_buckets = [0, 0, 0, 0, 0]
    rated_count = 0
    unrated_count = 0
    risk_counts = {"high": 0, "medium": 0, "low": 0}
    estimated_loss = 0.0
    monthly_revenue_at_risk = 0.0

    for customer in customers:
        if customer["score"] is None:
            unrated_count += 1
        else:
            rated_count += 1
        risk_level = customer["riskLevel"]
        if risk_level in risk_counts:
            risk_counts[risk_level] += 1
        estimated_loss += customer["estimatedLoss"]
        monthly_revenue_at_risk += customer["monthlyRevenue"] * RISK_FACTORS.get(
            risk_level, 0
        )

        for fact in _facts_for_customer(customer):
            days = (
                (fact.expires_ts - now_ts) / 86400
                if fact.expires_ts is not None
                else None
            )
            expiring = (
                fact.billable
                and days is not None
                and 0 <= days <= 14
                and not fact.autoprolong
            )
            if fact.status == "prolong_wait":
                waiting_services += 1
                at_risk_services += 1
            elif expiring:
                at_risk_services += 1
            if (
                fact.billable
                and not fact.autoprolong
                and days is not None
                and 0 <= days <= 30
            ):
                if days <= 0:
                    forecast_buckets[0] += 1
                elif days <= 7:
                    forecast_buckets[1] += 1
                elif days <= 14:
                    forecast_buckets[2] += 1
                elif days <= 21:
                    forecast_buckets[3] += 1
                else:
                    forecast_buckets[4] += 1

    forecast: list[int] = []
    cumulative = waiting_services
    for bucket in forecast_buckets:
        cumulative += bucket
        forecast.append(cumulative)

    return {
        "customerCount": len(customers),
        "ratedCount": rated_count,
        "unratedCount": unrated_count,
        "highRisk": risk_counts["high"],
        "mediumRisk": risk_counts["medium"],
        "lowRisk": risk_counts["low"],
        "estimatedLoss": round(estimated_loss),
        "monthlyRevenueAtRisk": round(monthly_revenue_at_risk),
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

    moment_ts = moment.timestamp()
    for customer in customers:
        factor = RISK_FACTORS.get(customer.get("riskLevel"), 0)
        risky_owner = customer.get("riskLevel") in {"high", "medium"}
        for fact in _facts_for_customer(customer):
            if fact.status == "deleted":
                deleted_total += 1
                deleted_ts = (
                    fact.deleted_ts
                    if fact.deleted_ts is not None
                    else fact.expires_ts
                )
                if deleted_ts is not None:
                    days = (deleted_ts - moment_ts) / 86400
                    index = _bucket_index(PAST_BUCKETS, days)
                    if index is not None:
                        past_deleted[index] += 1
                continue
            if fact.status == "prolong_wait":
                future_at_risk[0] += 1
                future_expected[0] += factor
                continue
            if not fact.billable or fact.expires_ts is None:
                continue
            days = (fact.expires_ts - moment_ts) / 86400
            index = _bucket_index(FUTURE_BUCKETS, days)
            if index is None:
                continue
            if fact.autoprolong and not risky_owner:
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
    expires_ts = _value_timestamp(service.get("expiresAt"))
    if expires_ts is None:
        return None
    return (expires_ts - now.timestamp()) / 86400


def _shortage(customer: dict[str, Any], now: datetime) -> int:
    now_ts = now.timestamp()
    due_amount = sum(
        fact.price
        for fact in _facts_for_customer(customer)
        if _fact_due_soon(fact, now_ts)
    )
    available = _number(customer.get("availableBalance", customer.get("balance")))
    return round(max(0.0, due_amount - available))


def _nearest_deadline(
    customer: dict[str, Any], now: datetime
) -> tuple[datetime | None, float | None, dict[str, Any] | None]:
    now_ts = now.timestamp()
    best_ts: float | None = None
    best_service: dict[str, Any] | None = None
    services = customer.get("services", [])
    for service, fact in zip(services, _facts_for_customer(customer), strict=False):
        if fact.status == "prolong_wait":
            candidate_ts = fact.expires_ts if fact.expires_ts is not None else now_ts
        elif fact.billable and fact.expires_ts is not None:
            candidate_ts = fact.expires_ts
        else:
            continue
        if best_ts is None or candidate_ts < best_ts:
            best_ts = candidate_ts
            best_service = service
    if best_ts is None or best_service is None:
        return None, None, None
    return (
        datetime.fromtimestamp(best_ts, UTC),
        (best_ts - now_ts) / 86400,
        best_service,
    )


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
    moment_ts = moment.timestamp()
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

        expiring = any(
            fact.billable
            and not fact.autoprolong
            and fact.expires_ts is not None
            and moment_ts <= fact.expires_ts <= moment_ts + 3 * 86400
            for fact in _facts_for_customer(customer)
        )
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
