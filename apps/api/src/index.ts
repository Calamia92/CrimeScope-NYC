import { createClient } from "@clickhouse/client";
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

type H3AggregationRow = { cell: string; count: string };

const app = new Elysia()
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
  .get("/aggregations/h3", async ({ query, set }) => {
    const resolution = Number(query.resolution ?? 9);
    if (!ALLOWED_RESOLUTIONS.has(resolution)) {
      set.status = 400;
      return { error: "Invalid resolution. Allowed values: 7, 9." };
    }

    const column = resolution === 9 ? "h3_res_9" : "h3_res_7";
    const whereParts: string[] = [`${column} IS NOT NULL`];
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
  .listen({
    hostname: "0.0.0.0",
    port
  });

console.log(`CrimeScope API listening on http://${app.server?.hostname}:${app.server?.port}`);
