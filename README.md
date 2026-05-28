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

## Run The Ingest Sample

The ingest service runs under the `ingest` Compose profile and loads a small sample into ClickHouse:

```bash
docker compose --profile ingest run --rm ingest
```

The job reads `packages/ingest/sample/sample.json`, normalizes the records to the initial raw schema, and inserts them into `crimescope.raw_nypd_complaints`.

You do not need Bun, Python, or ClickHouse installed locally. Docker builds and runs the ingest container, and the ClickHouse service is reached over the Compose network.

If you want to inspect the inserted rows after the job completes:

```bash
docker compose exec clickhouse clickhouse-client --user crimescope --password crimescope_password --query "SELECT complaint_number, borough, offense_category FROM crimescope.raw_nypd_complaints ORDER BY complaint_start_date;"
```

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
