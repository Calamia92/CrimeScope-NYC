import { createClient } from "@clickhouse/client";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { cellToLatLng } from "h3-js";

// ClickHouse returns h3_res_X UInt64 as a decimal string; convert back to the canonical 15-char hex form h3-js uses everywhere else.
function decimalToH3(decimal: string): string {
  return BigInt(decimal).toString(16).padStart(15, "0");
}

const port = Number(Bun.env.API_PORT ?? 3000);

const clickhouseHost = Bun.env.CLICKHOUSE_HOST ?? "clickhouse";
const clickhousePort = Bun.env.CLICKHOUSE_HTTP_PORT ?? "8123";
const clickhouseDatabase = Bun.env.CLICKHOUSE_DATABASE ?? "crimescope";
const clickhouseUser = Bun.env.CLICKHOUSE_USER ?? "crimescope";
const clickhousePassword = Bun.env.CLICKHOUSE_PASSWORD ?? "crimescope_password";

const clickhouse = createClient({
  url: `http://${clickhouseHost}:${clickhousePort}`,
  database: clickhouseDatabase,
  username: clickhouseUser,
  password: clickhousePassword
});

const ALLOWED_RESOLUTIONS = new Set<number>([7, 9]);
const MAX_CELLS = 5000;

const ALLOWED_GRANULARITIES = new Set<string>(["day", "week", "month"]);
const ALLOWED_DIMENSIONS = new Set<string>(["offense_category", "borough", "law_category"]);
const DEFAULT_CATEGORY_LIMIT = 10;
const MAX_CATEGORY_LIMIT = 100;

type H3AggregationRow = { cell: string; count: string };
type ByDateRow = { bucket: string; count: string };
type ByCategoryRow = { key: string; count: string };
type DataHealthOverviewRow = {
  total_records: string;
  min_date: string | null;
  max_date: string | null;
  geocoded_records: string;
  unknown_offense_records: string;
  h3_res_9_cells: string;
};
type DataHealthSourceRow = {
  source_dataset: string;
  records: string;
  min_date: string | null;
  max_date: string | null;
  geocoded_records: string;
};
type AnalyticsMartHealthRow = {
  weekly_rows: string;
  min_week: string | null;
  max_week: string | null;
  latest_refresh: string | null;
};
type IngestionRunResultRow = {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  mode: string;
  dataset: string;
  status: string;
  requested_limit: string;
  source_rows: string;
  imported_rows: string;
  skipped_rows: string;
  geocoded_rows: string;
  warning_count: string;
  duration_ms: string;
  error_message: string | null;
  skipped_reasons_json: string;
  warnings_json: string;
};
type DataHealthResponse = {
  status: "ok";
  generatedAt: string;
  records: {
    total: number;
    minDate: string | null;
    maxDate: string | null;
    geocoded: number;
    geocodedPercent: number;
    unknownOffense: number;
    h3Res9Cells: number;
  };
  analyticsMart: {
    weeklyRows: number;
    minWeek: string | null;
    maxWeek: string | null;
    latestRefresh: string | null;
  };
  sources: Array<{
    dataset: string;
    records: number;
    minDate: string | null;
    maxDate: string | null;
    geocoded: number;
    geocodedPercent: number;
  }>;
  recentIngestionRuns: Array<{
    runId: string;
    startedAt: string;
    finishedAt: string | null;
    mode: string;
    dataset: string;
    status: string;
    requestedLimit: number;
    sourceRows: number;
    importedRows: number;
    skippedRows: number;
    geocodedRows: number;
    warningCount: number;
    durationMs: number;
    errorMessage: string | null;
    skippedReasons: Record<string, number>;
    warnings: Record<string, number>;
  }>;
};
type WeeklyAnalyticsMartRow = {
  week_start: string;
  borough: string;
  offense_category: string;
  complaint_count: string;
  geocoded_count: string;
  h3_res_9_cells: string;
  refreshed_at: string;
};
type CrimeRecordRow = {
  complaint_number: string;
  complaint_start_date: string;
  complaint_start_time: string | null;
  complaint_end_date: string | null;
  complaint_end_time: string | null;
  offense_category: string;
  borough: string | null;
  precinct: number | null;
  latitude: number | null;
  longitude: number | null;
  source_dataset: string;
};
type CrimeRecordsResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  filters: {
    from?: string;
    to?: string;
    borough?: string;
    offenseCategory?: string;
    precinct?: number;
  };
  items: CrimeRecordRow[];
};

type QueryRecord = Record<string, string | undefined>;

type CrimeRecordsQuery = QueryRecord & {
  page?: string;
  pageSize?: string;
  from?: string;
  to?: string;
  borough?: string;
  offenseCategory?: string;
  precinct?: string;
};

type ValidatedCrimeRecordsQuery = {
  page: number;
  pageSize: number;
  offset: number;
  from?: string;
  to?: string;
  borough?: string;
  offenseCategory?: string;
  precinct?: number;
};

const MAX_RECORD_PAGE_SIZE = 100;
const DEFAULT_WEEKLY_MART_LIMIT = 500;
const MAX_WEEKLY_MART_LIMIT = 5000;

function parsePositiveInt(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return Number.NaN;
  }
  return parsed;
}

function parseIsoDate(value: string | undefined, fieldName: string): { value?: string; error?: string } {
  if (typeof value !== "string" || value.length === 0) return {};
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return { error: `${fieldName} must use YYYY-MM-DD format.` };
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { error: `${fieldName} must be a valid calendar date.` };
  }

  return { value };
}

function validateCrimeRecordsQuery(query: CrimeRecordsQuery): { ok: true; value: ValidatedCrimeRecordsQuery } | { ok: false; error: string } {
  const page = parsePositiveInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(page)) {
    return { ok: false, error: "page must be a positive integer." };
  }

  const pageSize = parsePositiveInt(query.pageSize, 25, 1, MAX_RECORD_PAGE_SIZE);
  if (!Number.isFinite(pageSize)) {
    return { ok: false, error: `pageSize must be a positive integer no greater than ${MAX_RECORD_PAGE_SIZE}.` };
  }

  const fromResult = parseIsoDate(query.from, "from");
  if (fromResult.error) return { ok: false, error: fromResult.error };

  const toResult = parseIsoDate(query.to, "to");
  if (toResult.error) return { ok: false, error: toResult.error };

  if (fromResult.value && toResult.value && fromResult.value > toResult.value) {
    return { ok: false, error: "from must be less than or equal to to." };
  }

  const borough = typeof query.borough === "string" && query.borough.trim().length > 0 ? query.borough.trim().toUpperCase() : undefined;
  const offenseCategory =
    typeof query.offenseCategory === "string" && query.offenseCategory.trim().length > 0
      ? query.offenseCategory.trim().toUpperCase()
      : undefined;

  let precinct: number | undefined;
  if (typeof query.precinct === "string" && query.precinct.length > 0) {
    const parsedPrecinct = Number(query.precinct);
    if (!Number.isInteger(parsedPrecinct) || parsedPrecinct <= 0 || parsedPrecinct > 255) {
      return { ok: false, error: "precinct must be a positive integer." };
    }
    precinct = parsedPrecinct;
  }

  const offset = (page - 1) * pageSize;

  return {
    ok: true,
    value: {
      page,
      pageSize,
      offset,
      from: fromResult.value,
      to: toResult.value,
      borough,
      offenseCategory,
      precinct
    }
  };
}

function buildCrimeRecordsFilters(query: ValidatedCrimeRecordsQuery): { whereClause: string; params: Record<string, unknown> } {
  const whereParts: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.from) {
    whereParts.push("complaint_start_date >= {from:Date}");
    params.from = query.from;
  }
  if (query.to) {
    whereParts.push("complaint_start_date <= {to:Date}");
    params.to = query.to;
  }
  if (query.borough) {
    whereParts.push("upper(borough) = {borough:String}");
    params.borough = query.borough;
  }
  if (query.offenseCategory) {
    whereParts.push("upper(offense_category) = {offenseCategory:String}");
    params.offenseCategory = query.offenseCategory;
  }
  if (typeof query.precinct === "number") {
    whereParts.push("precinct = {precinct:UInt16}");
    params.precinct = query.precinct;
  }

  return {
    whereClause: whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
    params
  };
}

function buildFilters(query: QueryRecord): { whereParts: string[]; params: Record<string, unknown> } {
  const whereParts: string[] = [];
  const params: Record<string, unknown> = {};

  if (typeof query.from === "string" && query.from.length > 0) {
    whereParts.push("complaint_start_date >= {from:Date}");
    params.from = query.from;
  }
  if (typeof query.to === "string" && query.to.length > 0) {
    whereParts.push("complaint_start_date <= {to:Date}");
    params.to = query.to;
  }
  if (typeof query.borough === "string" && query.borough.length > 0) {
    whereParts.push("borough = {borough:String}");
    params.borough = query.borough.toUpperCase();
  }
  if (typeof query.offense === "string" && query.offense.length > 0) {
    whereParts.push("offense_description ILIKE {offense:String}");
    params.offense = `%${query.offense}%`;
  }

  return { whereParts, params };
}

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  if (part >= total) return 100;
  return Math.floor((part / total) * 10000) / 100;
}

function parseJsonRecord(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, count]) => [key, toNumber(count as string | number)])
    );
  } catch {
    return {};
  }
}

async function loadRecentIngestionRuns(): Promise<DataHealthResponse["recentIngestionRuns"]> {
  try {
    const result = await clickhouse.query({
      query: `
        SELECT
          toString(run_id) AS run_id,
          toString(started_at) AS started_at,
          if(isNull(finished_at), NULL, toString(finished_at)) AS finished_at,
          mode,
          dataset,
          status,
          toString(requested_limit) AS requested_limit,
          toString(source_rows) AS source_rows,
          toString(imported_rows) AS imported_rows,
          toString(skipped_rows) AS skipped_rows,
          toString(geocoded_rows) AS geocoded_rows,
          toString(warning_count) AS warning_count,
          toString(duration_ms) AS duration_ms,
          error_message,
          skipped_reasons_json,
          warnings_json
        FROM ingestion_runs
        ORDER BY started_at DESC
        LIMIT 5
      `,
      format: "JSONEachRow"
    });
    const rows = await result.json<IngestionRunResultRow>();
    return rows.map((row) => ({
      runId: row.run_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      mode: row.mode,
      dataset: row.dataset,
      status: row.status,
      requestedLimit: toNumber(row.requested_limit),
      sourceRows: toNumber(row.source_rows),
      importedRows: toNumber(row.imported_rows),
      skippedRows: toNumber(row.skipped_rows),
      geocodedRows: toNumber(row.geocoded_rows),
      warningCount: toNumber(row.warning_count),
      durationMs: toNumber(row.duration_ms),
      errorMessage: row.error_message,
      skippedReasons: parseJsonRecord(row.skipped_reasons_json),
      warnings: parseJsonRecord(row.warnings_json)
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNKNOWN_TABLE") || message.includes("doesn't exist")) return [];
    throw error;
  }
}

async function loadAnalyticsMartHealth(): Promise<DataHealthResponse["analyticsMart"]> {
  try {
    const result = await clickhouse.query({
      query: `
        SELECT
          toString(count()) AS weekly_rows,
          toString(min(week_start)) AS min_week,
          toString(max(week_start)) AS max_week,
          toString(max(refreshed_at)) AS latest_refresh
        FROM crime_weekly_analytics
      `,
      format: "JSONEachRow"
    });
    const rows = await result.json<AnalyticsMartHealthRow>();
    const row = rows[0];
    return {
      weeklyRows: toNumber(row?.weekly_rows),
      minWeek: row?.min_week ?? null,
      maxWeek: row?.max_week ?? null,
      latestRefresh: row?.latest_refresh ?? null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNKNOWN_TABLE") || message.includes("doesn't exist")) {
      return { weeklyRows: 0, minWeek: null, maxWeek: null, latestRefresh: null };
    }
    throw error;
  }
}

function buildWeeklyMartFilters(query: QueryRecord): { whereClause: string; params: Record<string, unknown> } {
  const whereParts: string[] = [];
  const params: Record<string, unknown> = {};

  if (typeof query.from === "string" && query.from.length > 0) {
    whereParts.push("week_start >= {from:Date}");
    params.from = query.from;
  }
  if (typeof query.to === "string" && query.to.length > 0) {
    whereParts.push("week_start <= {to:Date}");
    params.to = query.to;
  }
  if (typeof query.borough === "string" && query.borough.length > 0) {
    whereParts.push("borough = {borough:String}");
    params.borough = query.borough.toUpperCase();
  }
  if (typeof query.offenseCategory === "string" && query.offenseCategory.length > 0) {
    whereParts.push("offense_category = {offenseCategory:String}");
    params.offenseCategory = query.offenseCategory.toUpperCase();
  }

  return {
    whereClause: whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
    params
  };
}

const app = new Elysia()
  .use(cors())
  .get("/health", () => ({ status: "ok" }))
  .get("/db-health", async ({ set }) => {
    try {
      const isAlive = await clickhouse.ping();

      if (!isAlive.success) {
        set.status = 503;
        return { status: "error", database: "clickhouse", message: "Ping failed" };
      }

      return { status: "ok", database: "clickhouse" };
    } catch (error) {
      set.status = 503;
      return {
        status: "error",
        database: "clickhouse",
        message: error instanceof Error ? error.message : "Unknown ClickHouse error"
      };
    }
  })
  .get("/data-health", async ({ set }) => {
    try {
      const overviewResult = await clickhouse.query({
        query: `
          SELECT
            toString(count()) AS total_records,
            toString(min(complaint_start_date)) AS min_date,
            toString(max(complaint_start_date)) AS max_date,
            toString(countIf(latitude IS NOT NULL AND longitude IS NOT NULL)) AS geocoded_records,
            toString(countIf(offense_category = 'UNKNOWN')) AS unknown_offense_records,
            toString(uniqExactIf(h3_res_9, h3_res_9 IS NOT NULL)) AS h3_res_9_cells
          FROM raw_nypd_complaints
        `,
        format: "JSONEachRow"
      });
      const overviewRows = await overviewResult.json<DataHealthOverviewRow>();
      const overview = overviewRows[0] ?? {
        total_records: "0",
        min_date: null,
        max_date: null,
        geocoded_records: "0",
        unknown_offense_records: "0",
        h3_res_9_cells: "0"
      };

      const sourcesResult = await clickhouse.query({
        query: `
          SELECT
            source_dataset,
            toString(count()) AS records,
            toString(min(complaint_start_date)) AS min_date,
            toString(max(complaint_start_date)) AS max_date,
            toString(countIf(latitude IS NOT NULL AND longitude IS NOT NULL)) AS geocoded_records
          FROM raw_nypd_complaints
          GROUP BY source_dataset
          ORDER BY count() DESC
        `,
        format: "JSONEachRow"
      });
      const sourceRows = await sourcesResult.json<DataHealthSourceRow>();
      const recentIngestionRuns = await loadRecentIngestionRuns();
      const analyticsMart = await loadAnalyticsMartHealth();

      const total = toNumber(overview.total_records);
      const geocoded = toNumber(overview.geocoded_records);

      return {
        status: "ok",
        generatedAt: new Date().toISOString(),
        records: {
          total,
          minDate: overview.min_date,
          maxDate: overview.max_date,
          geocoded,
          geocodedPercent: percent(geocoded, total),
          unknownOffense: toNumber(overview.unknown_offense_records),
          h3Res9Cells: toNumber(overview.h3_res_9_cells)
        },
        analyticsMart,
        sources: sourceRows.map((row) => {
          const records = toNumber(row.records);
          const sourceGeocoded = toNumber(row.geocoded_records);
          return {
            dataset: row.source_dataset,
            records,
            minDate: row.min_date,
            maxDate: row.max_date,
            geocoded: sourceGeocoded,
            geocodedPercent: percent(sourceGeocoded, records)
          };
        }),
        recentIngestionRuns
      } satisfies DataHealthResponse;
    } catch (error) {
      set.status = 500;
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown ClickHouse error"
      };
    }
  })
  .get("/analytics/weekly-mart", async ({ query, set }) => {
    let limit = Number(query.limit ?? DEFAULT_WEEKLY_MART_LIMIT);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_WEEKLY_MART_LIMIT;
    limit = Math.min(Math.floor(limit), MAX_WEEKLY_MART_LIMIT);

    const { whereClause, params } = buildWeeklyMartFilters(query as QueryRecord);

    try {
      const result = await clickhouse.query({
        query: `
          SELECT
            toString(week_start) AS week_start,
            borough,
            offense_category,
            toString(complaint_count) AS complaint_count,
            toString(geocoded_count) AS geocoded_count,
            toString(h3_res_9_cells) AS h3_res_9_cells,
            toString(refreshed_at) AS refreshed_at
          FROM crime_weekly_analytics
          ${whereClause}
          ORDER BY week_start ASC, complaint_count DESC
          LIMIT {limit:UInt64}
        `,
        query_params: {
          ...params,
          limit
        },
        format: "JSONEachRow"
      });
      const rows = await result.json<WeeklyAnalyticsMartRow>();

      return {
        filters: params,
        limit,
        rowCount: rows.length,
        rows: rows.map((row) => ({
          weekStart: row.week_start,
          borough: row.borough,
          offenseCategory: row.offense_category,
          complaintCount: toNumber(row.complaint_count),
          geocodedCount: toNumber(row.geocoded_count),
          h3Res9Cells: toNumber(row.h3_res_9_cells),
          refreshedAt: row.refreshed_at
        }))
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : "Unknown ClickHouse error" };
    }
  })
  .get("/crime-records", async ({ query, set }) => {
    const validation = validateCrimeRecordsQuery(query as CrimeRecordsQuery);
    if (!validation.ok) {
      set.status = 400;
      return {
        status: "error",
        message: validation.error
      };
    }

    const filters = buildCrimeRecordsFilters(validation.value);
    const countSql = `
      SELECT count() AS total
      FROM raw_nypd_complaints
      ${filters.whereClause}
    `;
    const recordsSql = `
      SELECT
        complaint_number,
        complaint_start_date,
        complaint_start_time,
        complaint_end_date,
        complaint_end_time,
        offense_category,
        borough,
        precinct,
        latitude,
        longitude,
        source_dataset
      FROM raw_nypd_complaints
      ${filters.whereClause}
      ORDER BY complaint_start_date DESC, complaint_number DESC
      LIMIT {limit:UInt64}
      OFFSET {offset:UInt64}
    `;

    try {
      const totalResult = await clickhouse.query({
        query: countSql,
        query_params: filters.params,
        format: "JSONEachRow"
      });
      const totalRows = await totalResult.json<{ total: string }>();
      const total = Number(totalRows[0]?.total ?? 0);

      const recordsResult = await clickhouse.query({
        query: recordsSql,
        query_params: {
          ...filters.params,
          limit: validation.value.pageSize,
          offset: validation.value.offset
        },
        format: "JSONEachRow"
      });
      const items = await recordsResult.json<CrimeRecordRow>();

      return {
        page: validation.value.page,
        pageSize: validation.value.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / validation.value.pageSize),
        filters: {
          from: validation.value.from,
          to: validation.value.to,
          borough: validation.value.borough,
          offenseCategory: validation.value.offenseCategory,
          precinct: validation.value.precinct
        },
        items
      } satisfies CrimeRecordsResponse;
    } catch (error) {
      set.status = 500;
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown ClickHouse error"
      };
    }
  })
  .get("/aggregations/h3", async ({ query, set }) => {
    const resolution = Number(query.resolution ?? 9);
    if (!ALLOWED_RESOLUTIONS.has(resolution)) {
      set.status = 400;
      return { error: "Invalid resolution. Allowed values: 7, 9." };
    }

    const column = resolution === 9 ? "h3_res_9" : "h3_res_7";
    const { whereParts, params } = buildFilters(query as QueryRecord);
    whereParts.unshift(`${column} IS NOT NULL`);

    // h3_res_X is UInt64; cast to String to keep BigInt precision through JSON.
    const sql = `
      SELECT toString(${column}) AS cell, count() AS count
      FROM raw_nypd_complaints
      WHERE ${whereParts.join(" AND ")}
      GROUP BY ${column}
      ORDER BY count DESC
      LIMIT ${MAX_CELLS}
    `;

    try {
      const result = await clickhouse.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow"
      });
      const rows = await result.json<H3AggregationRow>();
      const cells = rows.map((row) => {
        const h3 = decimalToH3(row.cell);
        const [lat, lng] = cellToLatLng(h3);
        return {
          h3,
          count: Number(row.count),
          lat,
          lng
        };
      });

      return {
        resolution,
        filters: params,
        cellCount: cells.length,
        cells
      };
    } catch (error) {
      set.status = 500;
      return {
        error: error instanceof Error ? error.message : "Unknown ClickHouse error"
      };
    }
  })
  .get("/analytics/by-date", async ({ query, set }) => {
    const granularity = String(query.granularity ?? "month").toLowerCase();
    if (!ALLOWED_GRANULARITIES.has(granularity)) {
      set.status = 400;
      return { error: "Invalid granularity. Allowed values: day, week, month." };
    }

    const bucketExpr =
      granularity === "day"
        ? "complaint_start_date"
        : granularity === "week"
          ? "toStartOfWeek(complaint_start_date, 1)"
          : "toStartOfMonth(complaint_start_date)";

    const { whereParts, params } = buildFilters(query as QueryRecord);
    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const sql = `
      SELECT ${bucketExpr} AS bucket, count() AS count
      FROM raw_nypd_complaints
      ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    try {
      const result = await clickhouse.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow"
      });
      const rows = await result.json<ByDateRow>();
      return {
        granularity,
        filters: params,
        bucketCount: rows.length,
        buckets: rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }))
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : "Unknown ClickHouse error" };
    }
  })
  .get("/analytics/by-category", async ({ query, set }) => {
    const dimension = String(query.dimension ?? "offense_category").toLowerCase();
    if (!ALLOWED_DIMENSIONS.has(dimension)) {
      set.status = 400;
      return {
        error: `Invalid dimension. Allowed values: ${[...ALLOWED_DIMENSIONS].join(", ")}.`
      };
    }

    let limit = Number(query.limit ?? DEFAULT_CATEGORY_LIMIT);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_CATEGORY_LIMIT;
    limit = Math.min(Math.floor(limit), MAX_CATEGORY_LIMIT);

    const { whereParts, params } = buildFilters(query as QueryRecord);
    // Drop NULLs and known dirty placeholders from NYC Open Data.
    whereParts.unshift(
      `${dimension} IS NOT NULL`,
      `${dimension} != ''`,
      `${dimension} != '(null)'`
    );

    const sql = `
      SELECT ${dimension} AS key, count() AS count
      FROM raw_nypd_complaints
      WHERE ${whereParts.join(" AND ")}
      GROUP BY ${dimension}
      ORDER BY count DESC
      LIMIT ${limit}
    `;

    try {
      const result = await clickhouse.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow"
      });
      const rows = await result.json<ByCategoryRow>();
      return {
        dimension,
        filters: params,
        limit,
        totalGroups: rows.length,
        totals: rows.map((r) => ({ key: r.key, count: Number(r.count) }))
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : "Unknown ClickHouse error" };
    }
  })
  .get("/analytics/by-hour", async ({ query, set }) => {
    const { whereParts, params } = buildFilters(query as QueryRecord);
    whereParts.unshift("complaint_start_time IS NOT NULL");

    // complaint_start_time is "HH:MM:SS"; concat a dummy date so we can parse to a DateTime and extract the hour.
    const hourExpr = "toHour(parseDateTimeBestEffortOrNull(concat('2000-01-01 ', complaint_start_time)))";
    const sql = `
      SELECT ${hourExpr} AS hour, count() AS count
      FROM raw_nypd_complaints
      WHERE ${whereParts.join(" AND ")}
      GROUP BY hour
      HAVING hour IS NOT NULL
      ORDER BY hour ASC
    `;

    try {
      const result = await clickhouse.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow"
      });
      const rows = await result.json<{ hour: string; count: string }>();
      return {
        filters: params,
        buckets: rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) }))
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : "Unknown ClickHouse error" };
    }
  })
  .get("/analytics/by-weekday", async ({ query, set }) => {
    const { whereParts, params } = buildFilters(query as QueryRecord);
    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    // ClickHouse toDayOfWeek: 1 = Monday, 7 = Sunday.
    const sql = `
      SELECT toDayOfWeek(complaint_start_date) AS weekday, count() AS count
      FROM raw_nypd_complaints
      ${where}
      GROUP BY weekday
      ORDER BY weekday ASC
    `;

    try {
      const result = await clickhouse.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow"
      });
      const rows = await result.json<{ weekday: string; count: string }>();
      const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      return {
        filters: params,
        buckets: rows.map((r) => ({
          weekday: Number(r.weekday),
          label: labels[Number(r.weekday) - 1] ?? String(r.weekday),
          count: Number(r.count)
        }))
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : "Unknown ClickHouse error" };
    }
  })
  .listen({
    hostname: "0.0.0.0",
    port
  });

console.log(`CrimeScope API listening on http://${app.server?.hostname}:${app.server?.port}`);
