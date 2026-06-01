from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from chronos_service.config import Settings, load_settings
from chronos_service.db import ClickHouseRepository, WeeklyPoint
from chronos_service.metrics import coverage, mae, mape, r2, rmse
from chronos_service.model import ChronosForecaster
from chronos_service.schemas import (
    BacktestMetrics,
    BacktestPointOut,
    ForecastFilters,
    ForecastPointOut,
    HealthResponse,
    HistoryPointOut,
    WeeklyBacktestResponse,
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


@app.get(
    "/forecast/weekly/backtest",
    response_model=WeeklyBacktestResponse,
    tags=["forecast"],
    summary="Hold-out evaluation: forecast the last N known weeks and score it",
)
async def forecast_weekly_backtest(
    request: Request,
    borough: Optional[str] = Query(default=None),
    offense: Optional[str] = Query(default=None),
    horizon: int = Query(
        default=settings.default_horizon_weeks,
        ge=1,
        le=settings.max_horizon_weeks,
        description="Number of trailing known weeks to hold out and score against.",
    ),
    history_weeks: int = Query(
        default=settings.default_history_weeks,
        ge=settings.min_history_points,
        le=settings.max_history_weeks,
        description="Context window length after the hold-out has been removed.",
    ),
) -> WeeklyBacktestResponse:
    repo: ClickHouseRepository = request.app.state.repo
    forecaster: ChronosForecaster = request.app.state.forecaster

    try:
        full_history: list[WeeklyPoint] = await run_in_threadpool(
            repo.weekly_counts, borough=borough, offense=offense
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ClickHouse query failed: {exc}") from exc

    # We need at least `min_history_points` of context AFTER carving out `horizon`
    # weeks of ground truth. Otherwise the forecast itself can't be produced.
    required = horizon + settings.min_history_points
    if len(full_history) < required:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Not enough weekly history to backtest: got {len(full_history)} points, "
                f"need >= {required} (horizon={horizon} + min context={settings.min_history_points})."
            ),
        )

    held_out = full_history[-horizon:]
    context_full = full_history[:-horizon]
    context = context_full[-history_weeks:]

    values = [float(p.count) for p in context]
    try:
        bands = await run_in_threadpool(forecaster.forecast, values, horizon)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model inference failed: {exc}") from exc

    actual = [float(p.count) for p in held_out]
    metrics = BacktestMetrics(
        mae=round(mae(actual, bands.median), 3),
        mape=round(mape(actual, bands.median), 3),
        rmse=round(rmse(actual, bands.median), 3),
        r2=round(r2(actual, bands.median), 4),
        coverage=round(coverage(actual, bands.lower, bands.upper), 3),
    )

    backtest_points = [
        BacktestPointOut(
            week=held_out[i].week,
            count=round(bands.median[i], 2),
            lower=round(bands.lower[i], 2),
            upper=round(bands.upper[i], 2),
            actual=held_out[i].count,
        )
        for i in range(horizon)
    ]

    return WeeklyBacktestResponse(
        model=forecaster.model_name,
        filters=ForecastFilters(borough=borough, offense=offense),
        history_weeks=len(context),
        horizon_weeks=horizon,
        metrics=metrics,
        history=[HistoryPointOut(week=p.week, count=p.count) for p in context],
        backtest=backtest_points,
        generated_at=datetime.now(timezone.utc),
    )


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=settings.port,
        log_level="info",
    )
