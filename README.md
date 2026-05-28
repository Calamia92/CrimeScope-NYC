# CrimeScope NYC

CrimeScope NYC is a Docker-first web application for analyzing and visualizing NYPD crime data in New York City. The first version provides a clean TypeScript-first foundation with a SvelteKit frontend, ElysiaJS API, ClickHouse database, placeholder ingestion package, and placeholder Chronos prediction service.

The project already includes the main planned stack in Docker: Bun, SvelteKit, ElysiaJS, ClickHouse, MapLibre GL JS, H3, Vega-Lite, and a placeholder Chronos service. Future work will add the real crime-data ingestion pipeline, interactive maps, analytics views, and time-series prediction logic.

## Stack

- Docker Compose for local orchestration
- SvelteKit + TypeScript frontend
- Bun runtime and package manager
- ElysiaJS backend API
- ClickHouse database with persistent Docker volume
- MapLibre GL JS for future maps
- H3 for future geospatial indexing
- Vega-Lite for future charts
- Python placeholder service for future Chronos prediction

## Prerequisites

Only these tools are required on your machine:

- Docker Desktop
- Git
- An IDE

You do not need to install Bun, Python, ClickHouse, or frontend/backend dependencies locally.

## Start The Project

From this folder, run:

```bash
docker compose up --build
```

The first run downloads images and installs dependencies inside Docker containers.

## Local URLs

- Web app: http://localhost:5173
- API health: http://localhost:3000/health
- API ClickHouse check: http://localhost:3000/db-health
- ClickHouse HTTP: http://localhost:8123
- ClickHouse native TCP: localhost:9000
- Chronos placeholder: http://localhost:8000

## Run The Ingestion

The ingest service runs under the `ingest` Compose profile. It supports two modes (selected via the `INGEST_MODE` environment variable):

- `socrata` (default) — fetches live NYPD complaint records from the [NYC Open Data Socrata API](https://dev.socrata.com/foundry/data.cityofnewyork.us/qgea-i56i) (`qgea-i56i` dataset), normalizes them, computes H3 cells, and inserts into ClickHouse.
- `sample` — reads the small bundled `packages/ingest/sample/sample.json` file. Useful for offline runs and quick smoke tests.

Run the default Open Data ingestion (5 000 most recent records with coordinates):

```bash
docker compose --profile ingest run --rm ingest
```

Tune the volume or switch modes via env vars:

```bash
# Larger pull from NYC Open Data
docker compose --profile ingest run --rm -e INGEST_LIMIT=20000 ingest

# Offline sample-only run
docker compose --profile ingest run --rm -e INGEST_MODE=sample ingest
```

| Variable | Default | Purpose |
|---|---|---|
| `INGEST_MODE` | `socrata` | `socrata` (live API) or `sample` (bundled JSON) |
| `INGEST_LIMIT` | `5000` | Max rows pulled per Socrata run (capped at 50 000 without an app token) |
| `INGEST_BATCH_SIZE` | `1000` | Rows per `INSERT JSONEachRow` request |
| `NYPD_SOCRATA_ENDPOINT` | `https://data.cityofnewyork.us/resource/qgea-i56i.json` | Override only to point at a different Socrata resource |
| `SOCRATA_APP_TOKEN` | _(empty)_ | Optional Socrata app token to bypass the throttling for anonymous calls |

The job is idempotent per dataset: each run starts by `ALTER TABLE ... DELETE WHERE source_dataset = '<dataset>'`, where `<dataset>` is either `sample` or `qgea-i56i`, so rerunning never duplicates rows.

You do not need Bun, Python, or ClickHouse installed locally. Docker builds and runs the ingest container, and the ClickHouse service is reached over the Compose network.

Inspect the inserted rows after the job completes:

```bash
docker compose exec clickhouse clickhouse-client --user crimescope --password crimescope_password --query \
  "SELECT source_dataset, count() FROM crimescope.raw_nypd_complaints GROUP BY source_dataset"
```

## H3 Geospatial Aggregation

Records are indexed with [H3](https://h3geo.org/) hexagonal cells during ingestion at two resolutions:

- **Resolution 9** (`h3_res_9`, ~0.1 km² / ~150 m edges) — neighborhood/block granularity, the primary resolution for the main map heatmap.
- **Resolution 7** (`h3_res_7`, ~5 km² / ~1.2 km edges) — borough-level overview, useful when zoomed out.

Both columns are stored as `Nullable(UInt64)` in ClickHouse (the native H3 cell representation). Records without coordinates leave them `NULL`, which the aggregation endpoint filters out automatically.

### Aggregation endpoint

```
GET /aggregations/h3?resolution=9&from=YYYY-MM-DD&to=YYYY-MM-DD&borough=BROOKLYN&offense=ROBBERY
```

Query parameters (all optional except `resolution`, which defaults to 9):

| Param | Type | Notes |
|---|---|---|
| `resolution` | `7` or `9` | H3 resolution; other values return HTTP 400 |
| `from` / `to` | `YYYY-MM-DD` | Inclusive bounds on `complaint_start_date` |
| `borough` | string | Matched exactly against `borough` (uppercased server-side) |
| `offense` | string | Substring match (ILIKE) against `offense_description` |

Response shape (truncated):

```json
{
  "resolution": 9,
  "filters": { "borough": "BROOKLYN" },
  "cellCount": 1234,
  "cells": [
    { "h3": "892a1072603ffff", "count": 42, "lat": 40.6782, "lng": -73.9442 }
  ]
}
```

Cells are sorted by descending count and capped at 5 000 per response.

## ClickHouse Schema

The first raw table lives in [`clickhouse/init/001_create_raw_nypd_complaints.sql`](clickhouse/init/001_create_raw_nypd_complaints.sql).

On a fresh ClickHouse volume, Docker will execute the SQL automatically because the `clickhouse` service mounts `clickhouse/init` into `/docker-entrypoint-initdb.d`.

If the container is already running and you want to apply the schema manually, run:

```bash
docker compose exec clickhouse sh -c "clickhouse-client --user crimescope --password crimescope_password --multiquery < /docker-entrypoint-initdb.d/001_create_raw_nypd_complaints.sql"
```

The table keeps room for later H3 and analytics work with nullable H3 fields, source metadata, and the raw complaint dimensions needed for filtering and aggregation.

## Environment

Copy `.env.example` to `.env` if you want to override ports or ClickHouse credentials:

```bash
cp .env.example .env
```

Docker Compose also works without a `.env` file because defaults are defined in `docker-compose.yml`.
