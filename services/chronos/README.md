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

## Frontend contract

The browser never talks to Chronos directly. The SvelteKit backend exposes `GET /api/forecast/weekly` (`apps/web/src/routes/api/forecast/weekly/+server.ts`) which forwards the request server-side. This keeps Chronos on the internal Docker network and avoids CORS entirely.

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
```

Or hit it through the SvelteKit BFF:

```bash
curl 'http://localhost:5173/api/forecast/weekly?borough=MANHATTAN&horizon=12'
```

OpenAPI / Swagger UI: `http://localhost:8000/docs`.
