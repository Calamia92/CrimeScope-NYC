from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from chronos_service.config import Settings, load_settings
from chronos_service.db import ClickHouseRepository, WeeklyPoint
from chronos_service.model import ChronosForecaster
from chronos_service.schemas import (
    ForecastFilters,
    ForecastPointOut,
    HealthResponse,
    HistoryPointOut,
    WeeklyForecastResponse,
)

settings: Settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Loading the model is the slowest startup step (~5-15s on CPU).
    # Doing it once at boot keeps every request hot.
    forecaster = ChronosForecaster(settings.model_name)
    repo = ClickHouseRepository(settings)
    app.state.forecaster = forecaster
    app.state.repo = repo
    try:
        yield
    finally:
        repo.close()


app = FastAPI(
    title="Chronos — CrimeScope NYC forecast service",
    version="0.1.0",
    description=(
        "Time-series forecasts on top of CrimeScope NYC's curated NYPD complaint "
        "data, powered by Amazon Chronos. Reads weekly aggregates from ClickHouse "
        "and emits quantile-banded forecasts."
    ),
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse, tags=["meta"])
async def health(request: Request) -> HealthResponse:
    forecaster: ChronosForecaster = request.app.state.forecaster
    return HealthResponse(status="ok", model=forecaster.model_name)


@app.get(
    "/forecast/weekly",
    response_model=WeeklyForecastResponse,
    tags=["forecast"],
    summary="Forecast weekly NYPD complaint counts",
)
async def forecast_weekly(
    request: Request,
    borough: Optional[str] = Query(
        default=None,
        description="Borough filter (e.g. MANHATTAN, BROOKLYN). Case-insensitive.",
    ),
    offense: Optional[str] = Query(
        default=None,
        description="Case-insensitive substring match on offense_description.",
    ),
    horizon: int = Query(
        default=settings.default_horizon_weeks,
        ge=1,
        le=settings.max_horizon_weeks,
        description="Number of future weeks to forecast.",
    ),
    history_weeks: int = Query(
        default=settings.default_history_weeks,
        ge=settings.min_history_points,
        le=settings.max_history_weeks,
        description="Number of past weeks fed as context to the model.",
    ),
) -> WeeklyForecastResponse:
    repo: ClickHouseRepository = request.app.state.repo
    forecaster: ChronosForecaster = request.app.state.forecaster

    try:
        history: list[WeeklyPoint] = await run_in_threadpool(
            repo.weekly_counts, borough=borough, offense=offense
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ClickHouse query failed: {exc}") from exc

    # The repo returns the full series; trim to the requested context window.
    history = history[-history_weeks:]

    if len(history) < settings.min_history_points:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Not enough weekly history to forecast: got {len(history)} points, "
                f"need >= {settings.min_history_points}. Run the ingest job or "
                "loosen filters."
            ),
        )

    values = [float(p.count) for p in history]
    try:
        bands = await run_in_threadpool(forecaster.forecast, values, horizon)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model inference failed: {exc}") from exc

    last_week = history[-1].week
    forecast_points = [
        ForecastPointOut(
            week=last_week + timedelta(weeks=i + 1),
            count=round(bands.median[i], 2),
            lower=round(bands.lower[i], 2),
            upper=round(bands.upper[i], 2),
        )
        for i in range(horizon)
    ]

    return WeeklyForecastResponse(
        model=forecaster.model_name,
        filters=ForecastFilters(borough=borough, offense=offense),
        history_weeks=len(history),
        horizon_weeks=horizon,
        history=[HistoryPointOut(week=p.week, count=p.count) for p in history],
        forecast=forecast_points,
        generated_at=datetime.now(timezone.utc),
    )


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=settings.port,
        log_level="info",
    )
