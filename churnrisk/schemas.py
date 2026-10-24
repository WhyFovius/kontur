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


class ModelSettingsResponse(BaseModel):
    weights: dict[str, float]
    features: dict[str, str]
    thresholds: dict[str, int]
    horizonMonths: int


class SnapshotResponse(BaseModel):
    ok: Literal[True] = True
    accountCount: int
