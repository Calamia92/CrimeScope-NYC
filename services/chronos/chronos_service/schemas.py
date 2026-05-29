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
