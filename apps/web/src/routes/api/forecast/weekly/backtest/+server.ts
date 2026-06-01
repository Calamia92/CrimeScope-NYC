import { json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

const FORWARDED_PARAMS = ["borough", "offense", "horizon", "history_weeks"] as const;

async function upstreamError(upstream: Response) {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return json(await upstream.json(), { status: upstream.status });
  }

  const text = await upstream.text();
  return json(
    { status: "error", message: text || `Chronos returned ${upstream.status}` },
    { status: upstream.status }
  );
}

export const GET: RequestHandler = async ({ url, fetch }) => {
  const chronosUrl = (env.CHRONOS_URL ?? "http://chronos:8000").replace(/\/$/, "");

  const params = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") params.set(key, value);
  }

  const target = `${chronosUrl}/forecast/weekly/backtest${params.size ? `?${params.toString()}` : ""}`;

  let upstream: Response;
  try {
    upstream = await fetch(target);
  } catch (cause) {
    return json(
      {
        status: "error",
        message: `Chronos unreachable: ${cause instanceof Error ? cause.message : String(cause)}`
      },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    return upstreamError(upstream);
  }

  return json(await upstream.json());
};
