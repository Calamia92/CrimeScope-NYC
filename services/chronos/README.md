# Chronos — CrimeScope NYC forecast service

FastAPI service that turns weekly NYPD complaint aggregates into quantile-banded forecasts using [Amazon Chronos](https://github.com/amazon-science/chronos-forecasting).

## Stack

- **FastAPI + Uvicorn** — async HTTP layer, auto-generated OpenAPI at `/docs`.
- **chronos-forecasting** — [`amazon/chronos-2`](https://huggingface.co/amazon/chronos-2) by default (120M-parameter encoder-only foundation model, Oct 2025, zero-shot univariate/multivariate). Override at build time with `--build-arg CHRONOS_MODEL=…` or at runtime with the `CHRONOS_MODEL` env var (e.g. `amazon/chronos-bolt-tiny` / `-small` / `-base` for lighter footprints).
- **clickhouse-connect** — direct ClickHouse queries with parameter binding; no SQL goes through the main API.
- **torch (CPU)** — installed from the PyTorch CPU index to keep the image small.

The model weights are downloaded **once at build time** and baked into the image, so the container is offline-capable and cold-start free.

## Endpoints

### `GET /health`

```json
{ "status": "ok", "service": "chronos", "model": "amazon/chronos-2" }
```

### `GET /forecast/weekly`

Forecast weekly complaint counts for the given filter slice.

Query parameters (all optional):

| Param           | Type   | Default | Notes                                                                   |
| --------------- | ------ | ------- | ----------------------------------------------------------------------- |
| `borough`       | string | —       | Exact match, uppercased server-side (`MANHATTAN`, `BROOKLYN`, …).        |
| `offense`       | string | —       | Case-insensitive substring on `offense_description`.                    |
| `horizon`       | int    | 8       | Future weeks to forecast (1 – `CHRONOS_MAX_HORIZON_WEEKS`).             |
| `history_weeks` | int    | 104     | Context window fed to the model (`min_history_points` – `max_history_weeks`). |

Response:

```json
{
  "target": "weekly_complaint_count",
  "model": "amazon/chronos-2",
  "filters": { "borough": "MANHATTAN", "offense": null },
  "history_weeks": 104,
  "horizon_weeks": 8,
  "history": [
    { "week": "2024-06-03", "count": 1234 },
    { "week": "2024-06-10", "count": 1198 }
  ],
  "forecast": [
    { "week": "2026-06-01", "count": 1180.42, "lower": 980.11, "upper": 1392.87 }
  ],
  "generated_at": "2026-05-28T10:23:11.482Z"
}
```

`count` is the P50, `lower`/`upper` default to P10/P90 (configurable in `chronos_service/model.py`).

Errors:

- **422** — not enough history points after filtering (default minimum: 12 weeks).
- **502** — ClickHouse query failure.
- **500** — model inference failure.

### `GET /forecast/weekly/backtest`

Held-out evaluation: hide the last `horizon` weeks of known data, ask Chronos to forecast them blind, then score the result against the truth. Useful for sizing the model's accuracy on a given filter slice.

Query parameters are the same as `/forecast/weekly`. Response:

```json
{
  "target": "weekly_complaint_count",
  "model": "amazon/chronos-2",
  "filters": { "borough": "MANHATTAN", "offense": null },
  "history_weeks": 96,
  "horizon_weeks": 8,
  "metrics": {
    "mae": 118.7,
    "mape": 5.36,
    "rmse": 157.8,
    "r2": -1.45,
    "coverage": 0.875
  },
  "history": [ { "week": "2024-04-08", "count": 2664 }, ... ],
  "backtest": [
    { "week": "2026-02-02", "count": 2353.32, "lower": 1988.22, "upper": 2552.22, "actual": 2348 }
  ],
  "generated_at": "2026-05-29T15:48:11.482Z"
}
```

Metric definitions:

- **`mae`** — Mean Absolute Error, same unit as counts. "We're off by ~X complaints per week."
- **`mape`** — Mean Absolute Percentage Error (0-100). "We're off by ~X%." Skips zero actuals.
- **`rmse`** — Root Mean Squared Error. Penalizes large misses more than MAE.
- **`r2`** — Coefficient of determination. **Noisy when the held-out window has low variance** — a flat 8-week stretch makes R² explode negatively even for a tight forecast. Read it alongside MAPE rather than alone.
- **`coverage`** — Share of actuals falling within the P10–P90 band (0-1). A well-calibrated model lands near 0.80. < 0.70 = overconfident; > 0.95 = bands too wide.

## Data hygiene

Two automatic cleanups apply to every query, both at the repository layer:

- **Pre-2024 records** are filtered at the Socrata `$where` clause and never reach ClickHouse. The YTD feed in particular contains complaints with very old `cmplnt_fr_dt` (NYPD reports backdated incidents); without this guard the series stretches back to 1970.
- **The trailing week is dropped if it's incomplete** (the source data doesn't reach Sunday of that week yet). Otherwise the partial last week shows up as an artificial cliff in both the history line and the model's context.

## Frontend contract

The browser never talks to Chronos directly. The SvelteKit backend exposes two BFF routes that forward the request server-side, keeping Chronos on the internal Docker network and avoiding CORS entirely:

- `GET /api/forecast/weekly` — proxies the forecast endpoint
- `GET /api/forecast/weekly/backtest` — proxies the backtest endpoint

Both are implemented under `apps/web/src/routes/api/forecast/weekly/`. The home dashboard's "Predictions" section consumes them via the `ForecastChart` Vega-Lite component, with a mode toggle (forecast / backtest) and a horizon selector (4–52 weeks).

## Configuration

| Env var                         | Default                          | Purpose                                          |
| ------------------------------- | -------------------------------- | ------------------------------------------------ |
| `CHRONOS_PORT`                  | `8000`                           | HTTP port inside the container.                  |
| `CHRONOS_MODEL`                 | `amazon/chronos-2`               | Hugging Face model id; must be baked at build.   |
| `CLICKHOUSE_HOST`               | `clickhouse`                     | Docker service name.                             |
| `CLICKHOUSE_HTTP_PORT`          | `8123`                           |                                                  |
| `CLICKHOUSE_DATABASE`           | `crimescope`                     |                                                  |
| `CLICKHOUSE_USER`               | `crimescope`                     |                                                  |
| `CLICKHOUSE_PASSWORD`           | `crimescope_password`            |                                                  |
| `CHRONOS_DEFAULT_HISTORY_WEEKS` | `104`                            | Default context window.                          |
| `CHRONOS_DEFAULT_HORIZON_WEEKS` | `8`                              | Default forecast horizon.                        |
| `CHRONOS_MAX_HISTORY_WEEKS`     | `520`                            | Hard cap on context.                             |
| `CHRONOS_MAX_HORIZON_WEEKS`     | `52`                             | Hard cap on horizon.                             |
| `CHRONOS_MIN_HISTORY_POINTS`    | `12`                             | Minimum series length to attempt a forecast.     |

## Local usage

Build and start the whole stack:

```bash
docker compose up --build
```

Smoke-test once the service is up:

```bash
curl http://localhost:8000/health
curl 'http://localhost:8000/forecast/weekly?borough=MANHATTAN&horizon=12'
curl 'http://localhost:8000/forecast/weekly/backtest?borough=MANHATTAN&horizon=8'
```

Or hit it through the SvelteKit BFF:

```bash
curl 'http://localhost:5173/api/forecast/weekly?borough=MANHATTAN&horizon=12'
curl 'http://localhost:5173/api/forecast/weekly/backtest?borough=MANHATTAN&horizon=8'
```

OpenAPI / Swagger UI: `http://localhost:8000/docs`.
