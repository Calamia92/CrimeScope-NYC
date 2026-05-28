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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: `${fieldName} must use YYYY-MM-DD format.` };
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
