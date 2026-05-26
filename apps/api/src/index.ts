import { createClient } from "@clickhouse/client";
import { Elysia } from "elysia";

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
  .listen({
    hostname: "0.0.0.0",
    port
  });

console.log(`CrimeScope API listening on http://${app.server?.hostname}:${app.server?.port}`);
