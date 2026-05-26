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

## Run The Ingest Placeholder

The ingest service is optional and runs under the `ingest` Compose profile:

```bash
docker compose --profile ingest run --rm ingest
```

For now it only prints a placeholder message. NYC Open Data ingestion logic will be added later in `packages/ingest`.

## Environment

Copy `.env.example` to `.env` if you want to override ports or ClickHouse credentials:

```bash
cp .env.example .env
```

Docker Compose also works without a `.env` file because defaults are defined in `docker-compose.yml`.
