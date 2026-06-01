# API Contract

This document defines the first JSON contracts shared by the SvelteKit frontend, ElysiaJS API, ClickHouse-backed analytics, and the future Chronos prediction service.

The TypeScript reference types live in `packages/contracts/src/index.ts`. They are intentionally small and mirror the current HTTP responses without adding runtime dependencies.

## General Rules

- Dates use `YYYY-MM-DD`.
- Times use `HH:MM:SS` when present.
- Counts are JSON numbers.
- Missing optional fields are omitted.
- Nullable source fields are returned as `null`.
- API validation errors use HTTP `400`.
- Backend or ClickHouse failures use HTTP `500` or `503`.

Error responses are one of these shapes:

```json
{ "status": "error", "message": "page must be a positive integer." }
```

```json
{ "error": "Invalid resolution. Allowed values: 7, 9." }
```

## Health

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /db-health`

Success:

```json
{ "status": "ok", "database": "clickhouse" }
```

Failure:

```json
{
  "status": "error",
  "database": "clickhouse",
  "message": "Ping failed"
}
```

### `GET /data-health`

Returns dataset-level observability for the ClickHouse tables and latest ingestion runs.

```json
{
  "status": "ok",
  "generatedAt": "2026-06-01T12:00:00.000Z",
  "records": {
    "total": 1274387,
    "minDate": "2024-01-01",
    "maxDate": "2026-03-31",
    "geocoded": 1274374,
    "geocodedPercent": 99.99,
    "unknownOffense": 23,
    "h3Res9Cells": 18920
  },
  "analyticsMart": {
    "weeklyRows": 2450,
    "minWeek": "2024-01-01",
    "maxWeek": "2026-03-30",
    "latestRefresh": "2026-06-01 12:00:00.000"
  },
  "sources": [
    {
      "dataset": "qgea-i56i",
      "records": 1141860,
      "minDate": "2024-01-01",
      "maxDate": "2025-12-31",
      "geocoded": 1141847,
      "geocodedPercent": 99.99
    }
  ],
  "recentIngestionRuns": [
    {
      "runId": "018f1d9a-5f2f-4d54-a97a-71a5e7d45d01",
      "startedAt": "2026-06-01 10:00:00.000",
      "finishedAt": "2026-06-01 10:14:25.000",
      "mode": "socrata",
      "dataset": "qgea-i56i",
      "status": "success",
      "requestedLimit": 1500000,
      "sourceRows": 1141860,
      "importedRows": 1141860,
      "skippedRows": 0,
      "geocodedRows": 1141847,
      "warningCount": 34,
      "durationMs": 865000,
      "errorMessage": null,
      "skippedReasons": {},
      "warnings": {
        "missing_coordinates": 13,
        "missing_offense_category": 21
      }
    }
  ]
}
```

## Analytics Mart

### `GET /analytics/weekly-mart`

Returns prepared weekly aggregates from `crime_weekly_analytics`, not from the raw complaint table.

Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `from` / `to` | `YYYY-MM-DD` | none | Inclusive bounds on `week_start` |
| `borough` | string | none | Exact borough match after uppercasing |
| `offenseCategory` | string | none | Exact offense category match after uppercasing |
| `limit` | positive integer | `500`, capped at `5000` | Max rows returned |

Response:

```json
{
  "filters": {
    "borough": "MANHATTAN"
  },
  "limit": 500,
  "rowCount": 1,
  "rows": [
    {
      "weekStart": "2026-03-30",
      "borough": "MANHATTAN",
      "offenseCategory": "PETIT LARCENY",
      "complaintCount": 42,
      "geocodedCount": 42,
      "h3Res9Cells": 31,
      "refreshedAt": "2026-06-01 12:00:00.000"
    }
  ]
}
```

## Crime Records

### `GET /crime-records`

Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | positive integer | `1` | 1-based page index |
| `pageSize` | positive integer | `25` | Max `100` |
| `from` | `YYYY-MM-DD` | none | Inclusive start date |
| `to` | `YYYY-MM-DD` | none | Inclusive end date |
| `borough` | string | none | Uppercased server-side |
| `offenseCategory` | string | none | Exact match after uppercasing |
| `precinct` | integer | none | Positive precinct number |

Response:

```json
{
  "page": 1,
  "pageSize": 25,
  "total": 1234,
  "totalPages": 50,
  "filters": {
    "from": "2025-01-01",
    "borough": "BROOKLYN"
  },
  "items": [
    {
      "complaint_number": "318207515",
      "complaint_start_date": "2025-12-31",
      "complaint_start_time": "20:55:00",
      "complaint_end_date": "2025-12-31",
      "complaint_end_time": "21:01:00",
      "offense_category": "FELONY ASSAULT",
      "borough": "BRONX",
      "precinct": 50,
      "latitude": 40.880352,
      "longitude": -73.904325,
      "source_dataset": "qgea-i56i"
    }
  ]
}
```

## Shared Analytics Filters

The map and analytics endpoints share these optional filters:

| Param | Type | Notes |
|---|---|---|
| `from` / `to` | `YYYY-MM-DD` | Inclusive bounds on `complaint_start_date` |
| `borough` | string | Matched against borough |
| `offense` | string | Substring match against offense description |

## H3 Map Aggregation

### `GET /aggregations/h3`

Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `resolution` | `7` or `9` | `9` | Other values return HTTP `400` |
| shared filters | see above | none | Optional |

Response:

```json
{
  "resolution": 9,
  "filters": {
    "borough": "BRONX",
    "offense": "%ASSAULT%"
  },
  "cellCount": 4,
  "cells": [
    {
      "h3": "892a1001463ffff",
      "count": 3,
      "lat": 40.88840837232645,
      "lng": -73.85165110851239
    }
  ]
}
```

Cells are sorted by descending count and capped at 5000.

## Charts

### `GET /analytics/by-date`

Query parameters:

| Param | Type | Default |
|---|---|---|
| `granularity` | `day`, `week`, or `month` | `month` |
| shared filters | see above | none |

Response:

```json
{
  "granularity": "month",
  "filters": {},
  "bucketCount": 2,
  "buckets": [
    { "bucket": "2025-12-01", "count": 42 }
  ]
}
```

### `GET /analytics/by-category`

Query parameters:

| Param | Type | Default |
|---|---|---|
| `dimension` | `offense_category`, `borough`, or `law_category` | `offense_category` |
| `limit` | positive integer | `10`, capped at `100` |
| shared filters | see above | none |

Response:

```json
{
  "dimension": "offense_category",
  "filters": {},
  "limit": 10,
  "totalGroups": 1,
  "totals": [
    { "key": "FELONY ASSAULT", "count": 12 }
  ]
}
```

### `GET /analytics/by-hour`

Response:

```json
{
  "filters": {},
  "buckets": [
    { "hour": 20, "count": 8 }
  ]
}
```

### `GET /analytics/by-weekday`

Response:

```json
{
  "filters": {},
  "buckets": [
    { "weekday": 3, "label": "Wed", "count": 14 }
  ]
}
```

## Future Chronos Prediction Contract

The Chronos service is still a placeholder. Future prediction work should use a separate Python service container and keep the response shape close to the analytics endpoints.

Proposed request:

```json
{
  "from": "2025-01-01",
  "to": "2025-12-31",
  "borough": "BROOKLYN",
  "offenseCategory": "FELONY ASSAULT",
  "horizonDays": 30,
  "granularity": "day"
}
```

Proposed response:

```json
{
  "model": "chronos",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "filters": {
    "from": "2025-01-01",
    "to": "2025-12-31",
    "borough": "BROOKLYN",
    "offenseCategory": "FELONY ASSAULT",
    "horizonDays": 30,
    "granularity": "day"
  },
  "points": [
    {
      "date": "2026-01-01",
      "predictedCount": 18,
      "lowerBound": 12,
      "upperBound": 24
    }
  ]
}
```
