from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import MAX_ACCOUNTS, MAX_SERVICES, MAX_TRANSACTIONS


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class SnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accounts: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_ACCOUNTS
    )
    services: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_SERVICES
    )
    transactions: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_TRANSACTIONS
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_input(cls, value: Any) -> Any:
        from .snapshot import normalize_snapshot

        return normalize_snapshot(value)


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    weights: dict[str, float] = Field(min_length=1, max_length=64)

    @field_validator("weights", mode="before")
    @classmethod
    def validate_weight_values(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            raise ValueError("weights должен быть объектом")  # noqa: TRY004 — Pydantic validators must raise ValueError to return 422.
        for key, weight in value.items():
            if isinstance(weight, bool):
                raise ValueError(f"Вес {key} должен быть числом от 0 до 100")  # noqa: TRY004 — Pydantic validators must raise ValueError to return 422.
            try:
                number = float(weight)
            except (TypeError, ValueError, OverflowError):
                raise ValueError(f"Вес {key} должен быть числом от 0 до 100") from None
            if not math.isfinite(number) or not 0 <= number <= 100:
                raise ValueError(f"Вес {key} должен быть числом от 0 до 100")
        return value


class LoginResponse(BaseModel):
    username: str
    expiresAt: str


class CustomerResponse(BaseModel):
    id: str
    email: str
    balance: float
    availableBalance: float | None = None
    totalReplenished: float
    score: int | None
    riskLevel: Literal["high", "medium", "low", "unrated"]
    reasons: list[str]
    services: list[dict[str, Any]]
    features: dict[str, bool]
    estimatedLoss: int
    monthlyRevenue: int
    daysToExpiry: float | None = None


class CustomerListResponse(BaseModel):
    items: list[CustomerResponse]
    total: int


class ChurnForecast(BaseModel):
    days: list[int]
    counts: list[int]


class AnalyticsSummary(BaseModel):
    customerCount: int
    ratedCount: int
    unratedCount: int
    highRisk: int
    mediumRisk: int
    lowRisk: int
    estimatedLoss: int
    monthlyRevenueAtRisk: int
    atRiskServices: int
    churnForecast: ChurnForecast
    currency: Literal["EUR"] = "EUR"
    unit: Literal["eurocents"] = "eurocents"


class ChurnPastBucket(BaseModel):
    label: str
    fromDays: int
    toDays: int
    deleted: int


class ChurnFutureBucket(BaseModel):
    label: str
    fromDays: int
    toDays: int
    servicesAtRisk: int
    expectedNonRenewals: float


class ChurnTimelineTotals(BaseModel):
    deletedServices: int
    deleted90d: int
    servicesAtRisk30d: int
    expectedNonRenewals30d: float
    servicesAtRisk90d: int
    expectedNonRenewals90d: float


class ChurnTimelineResponse(BaseModel):
    generatedAt: str
    past: list[ChurnPastBucket]
    future: list[ChurnFutureBucket]
    totals: ChurnTimelineTotals
    method: str


class OidcProviderInfo(BaseModel):
    enabled: bool
    name: str | None = None
    loginUrl: str | None = None


class AuthProvidersResponse(BaseModel):
    password: bool
    oidc: OidcProviderInfo


class ModelSettingsResponse(BaseModel):
    weights: dict[str, float]
    features: dict[str, str]
    thresholds: dict[str, int]
    horizonMonths: int


class RiskNotification(BaseModel):
    id: int
    episodeKey: str
    customerId: str | None = None
    customerEmail: str | None = None
    type: str
    severity: Literal["critical", "warning", "info"]
    title: str
    message: str
    score: int | None = None
    riskLevel: str | None = None
    estimatedLoss: int
    daysToExpiry: float | None = None
    requiredTopUp: int | None = None
    source: str = "snapshot"
    mode: Literal["LIVE", "DEMO"] = "LIVE"
    eventId: str | None = None
    previousScore: int | None = None
    riskDelta: float | None = None
    firstSeenAt: str
    lastSeenAt: str
    readAt: str | None = None
    resolvedAt: str | None = None
    isRead: bool


class NotificationListResponse(BaseModel):
    items: list[RiskNotification]
    total: int
    unreadCount: int
    criticalCount: int
    generatedAt: str


class NotificationReadResponse(BaseModel):
    ok: Literal[True] = True
    notification: RiskNotification | None = None
    updatedCount: int = 0
    unreadCount: int


class RescueQueueItem(BaseModel):
    rank: int
    customerId: str
    email: str
    score: int
    riskLevel: Literal["high", "medium", "low", "unrated"]
    estimatedLoss: int
    monthlyRevenue: int
    rescueValue: int
    valuePerDay: int
    priorityIndex: int
    actionType: str
    actionLabel: str
    actionDetail: str
    requiredTopUp: int | None = None
    deadlineAt: str | None = None
    dueInDays: float | None = None
    serviceName: str | None = None
    predictedScoreAfterAction: int | None = None
    confidence: Literal["high", "medium", "low"]
    confidenceScore: int
    reasons: list[str]


class RescueQueueTotals(BaseModel):
    eligibleCustomers: int
    criticalCustomers: int
    rescueValue: int
    top3RescueValue: int
    requiredTopUps: int


class RescueQueueResponse(BaseModel):
    generatedAt: str
    items: list[RescueQueueItem]
    totals: RescueQueueTotals
    method: str


DemoScenario = Literal[
    "NORMAL_ACTIVITY",
    "ACTIVITY_DROP",
    "CHURN_RISK_SPIKE",
    "HIGH_RISK_THRESHOLD",
    "CUSTOMER_RECOVERY",
    "NEW_CUSTOMER_ACTIVITY",
]


class DemoGenerateRequest(BaseModel):
    scenario: DemoScenario
    customerId: str | None = Field(default=None, max_length=160)
    eventId: str | None = Field(default=None, min_length=1, max_length=120)


class SimulatorStartRequest(BaseModel):
    intervalSeconds: float = Field(default=5, ge=2, le=60)
    scenario: DemoScenario | Literal["MIXED"] = "MIXED"


class ReactionTemplatePatch(BaseModel):
    enabled: bool | None = None
    subject: str | None = Field(default=None, min_length=1, max_length=240)
    body: str | None = Field(default=None, min_length=1, max_length=4000)
    cooldownSeconds: int | None = Field(default=None, ge=0, le=86400)
    channelStrategy: Literal["social_first", "email_first"] | None = None


class ReactionAction(BaseModel):
    id: int
    eventId: str
    templateId: str
    customerId: str | None = None
    channel: str
    recipient: str | None = None
    subject: str
    body: str
    status: str
    mode: str
    createdAt: str
    sentAt: str | None = None
    error: str | None = None


class RealtimeEvent(BaseModel):
    id: int
    eventId: str
    type: str
    source: str
    mode: Literal["LIVE", "DEMO"]
    scenario: str | None = None
    customerId: str | None = None
    customerEmail: str | None = None
    timestamp: str
    severity: Literal["critical", "warning", "info"]
    previousRiskScore: float | None = None
    riskScore: float
    riskPercent: int
    riskLevel: str
    riskDelta: float
    reason: str
    reasons: list[str]
    details: dict
    processed: bool
    notificationCreated: bool
    notificationId: int | None = None
    suppressedReason: str | None = None
    actions: list[ReactionAction] = []
    duplicate: bool = False
    createdAt: str


class RealtimeEventListResponse(BaseModel):
    items: list[RealtimeEvent]
    total: int
    latestId: int
    generatedAt: str


class RiskCalculation(BaseModel):
    eventId: str
    baseScore: float | None = None
    demoModifier: float
    previousRiskScore: float | None = None
    riskScore: float
    riskPercent: int
    riskLevel: str
    riskDelta: float
    reasons: list[str]
    source: str
    mode: str
    isDemo: bool
    calculatedAt: str


class CustomerRealtimeHistoryResponse(BaseModel):
    customerId: str
    events: list[RealtimeEvent]
    calculations: list[RiskCalculation]


class RealtimeSourceStatus(BaseModel):
    name: str
    label: str
    configured: bool
    available: bool
    mode: str
    message: str


class SimulatorStatus(BaseModel):
    running: bool
    intervalSeconds: float
    scenario: str
    generatedCount: int
    lastEventId: str | None = None
    lastError: str | None = None
    startedAt: str | None = None


class ScenarioInfo(BaseModel):
    id: str
    label: str


class ThresholdInfo(BaseModel):
    medium: int
    high: int
    critical: int
    significantDelta: int
    notificationCooldownSeconds: int


class EventCounts(BaseModel):
    total: int
    demo: int
    live: int


class RealtimeStatusResponse(BaseModel):
    generatedAt: str
    sources: list[RealtimeSourceStatus]
    simulator: SimulatorStatus
    scenarios: list[ScenarioInfo]
    thresholds: ThresholdInfo
    eventCounts: EventCounts
    trackedCustomers: int
    liveAvailable: bool


class SimulatorActionResponse(BaseModel):
    ok: Literal[True] = True
    simulator: SimulatorStatus


class SeriesPoint(BaseModel):
    label: str
    value: float


class RiskDistribution(BaseModel):
    high: int
    medium: int
    low: int


class RealtimeDashboardResponse(BaseModel):
    generatedAt: str
    periodHours: int
    trackedCustomers: int
    highRiskCustomers: int
    eventsInPeriod: int
    criticalEvents: int
    averageRiskPercent: float
    improvedCustomers: int
    distribution: RiskDistribution
    riskSeries: list[SeriesPoint]
    eventSeries: list[SeriesPoint]
    method: str


class ReactionTemplate(BaseModel):
    id: str
    name: str
    triggerTypes: list[str]
    minSeverity: str
    channelStrategy: str
    subject: str
    body: str
    enabled: bool
    cooldownSeconds: int
    priority: int
    updatedAt: str


class ReactionTemplateListResponse(BaseModel):
    items: list[ReactionTemplate]


class ReactionOutboxResponse(BaseModel):
    items: list[ReactionAction]


class DemoResetResponse(BaseModel):
    ok: Literal[True] = True
    deleted: dict[str, int]


class SnapshotResponse(BaseModel):
    ok: Literal[True] = True
    accountCount: int
