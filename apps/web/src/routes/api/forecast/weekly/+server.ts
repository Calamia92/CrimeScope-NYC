import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

const FORWARDED_PARAMS = ["borough", "offense", "horizon", "history_weeks"] as const;

export const GET: RequestHandler = async ({ url, fetch }) => {
  const chronosUrl = (env.CHRONOS_URL ?? "http://chronos:8000").replace(/\/$/, "");

  const params = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") params.set(key, value);
  }

  const target = `${chronosUrl}/forecast/weekly${params.size ? `?${params.toString()}` : ""}`;

  let upstream: Response;
  try {
    upstream = await fetch(target);
  } catch (cause) {
    error(502, `Chronos unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    error(upstream.status, text || `Chronos returned ${upstream.status}`);
  }

  return json(await upstream.json());
};
