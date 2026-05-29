from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    status: str
    service: str = "chronos"
    model: str


class HistoryPointOut(BaseModel):
    week: date
    count: int


class ForecastPointOut(BaseModel):
    week: date
    count: float = Field(description="Median (P50) forecast for the week")
    lower: float = Field(description="Lower quantile bound (default P10)")
    upper: float = Field(description="Upper quantile bound (default P90)")


class ForecastFilters(BaseModel):
    borough: Optional[str] = None
    offense: Optional[str] = None


class WeeklyForecastResponse(BaseModel):
    # Avoid Pydantic v2's protected-namespace warning on the `model` field.
    model_config = ConfigDict(protected_namespaces=())

    target: str = "weekly_complaint_count"
    model: str = Field(description="Identifier of the forecasting model used")
    filters: ForecastFilters
    history_weeks: int
    horizon_weeks: int
    history: list[HistoryPointOut]
    forecast: list[ForecastPointOut]
    generated_at: datetime


class BacktestPointOut(BaseModel):
    week: date
    count: float = Field(description="Median (P50) forecast for the held-out week")
    lower: float
    upper: float
    actual: int = Field(description="Observed count for the held-out week")


class BacktestMetrics(BaseModel):
    mae: float = Field(description="Mean Absolute Error (same unit as counts)")
    mape: float = Field(description="Mean Absolute Percentage Error (0-100, skips zero actuals)")
    rmse: float = Field(description="Root Mean Squared Error")
    r2: float = Field(description="Coefficient of determination (-inf, 1]")
    coverage: float = Field(
        description="Share of actuals falling within the P10-P90 band (0-1)"
    )


class WeeklyBacktestResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    target: str = "weekly_complaint_count"
    model: str
    filters: ForecastFilters
    history_weeks: int = Field(description="Context length fed to the model after hold-out")
    horizon_weeks: int = Field(description="Number of held-out weeks scored")
    metrics: BacktestMetrics
    history: list[HistoryPointOut]
    backtest: list[BacktestPointOut]
    generated_at: datetime
