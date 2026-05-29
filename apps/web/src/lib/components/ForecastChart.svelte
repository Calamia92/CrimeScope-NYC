<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Result } from "vega-embed";
  import { inView } from "$lib/actions/inView";

  type HistoryPoint = { week: string; count: number };
  type ForecastPoint = { week: string; count: number; lower: number; upper: number };
  type BacktestPoint = ForecastPoint & { actual: number };
  type Metrics = {
    mae: number;
    mape: number;
    rmse: number;
    r2: number;
    coverage: number;
  };

  type ForecastResponse = {
    model: string;
    history_weeks: number;
    horizon_weeks: number;
    history: HistoryPoint[];
    forecast: ForecastPoint[];
  };

  type BacktestResponse = {
    model: string;
    history_weeks: number;
    horizon_weeks: number;
    metrics: Metrics;
    history: HistoryPoint[];
    backtest: BacktestPoint[];
  };

  type Mode = "forecast" | "backtest";

  let {
    mode = "forecast",
    borough = "",
    offense = "",
    horizon = 8,
    historyWeeks = 104,
    title = "Weekly forecast"
  }: {
    mode?: Mode;
    borough?: string;
    offense?: string;
    horizon?: number;
    historyWeeks?: number;
    title?: string;
  } = $props();

  let container: HTMLDivElement;
  let result: Result | undefined;
  let status: "loading" | "ready" | "empty" | "error" = $state("loading");
  let metrics: Metrics | null = $state(null);
  let modelName = $state("");
  let errorMessage = $state("");
  let lastKnownWeek = $state<string | null>(null);
  let lagDays = $state<number | null>(null);
  let hasLoaded = false;

  async function load() {
    hasLoaded = true;
    try {
      status = "loading";
      errorMessage = "";
      metrics = null;
      result?.finalize();
      result = undefined;

      const { default: embed } = await import("vega-embed");

      const path = mode === "backtest" ? "/api/forecast/weekly/backtest" : "/api/forecast/weekly";
      const url = new URL(path, window.location.origin);
      if (borough) url.searchParams.set("borough", borough);
      if (offense.trim()) url.searchParams.set("offense", offense.trim());
      url.searchParams.set("horizon", String(horizon));
      url.searchParams.set("history_weeks", String(historyWeeks));

      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status} — ${text || res.statusText}`);
      }

      const data = (await res.json()) as ForecastResponse | BacktestResponse;
      modelName = data.model;

      const fullHistory = data.history;
      const futurePoints: BacktestPoint[] | ForecastPoint[] =
        mode === "backtest" ? (data as BacktestResponse).backtest : (data as ForecastResponse).forecast;

      if (fullHistory.length === 0 || futurePoints.length === 0) {
        status = "empty";
        return;
      }

      // Crop the displayed history to ~3× horizon so the forecast region is
      // clearly visible. Chronos still gets the full series from the backend
      // for its context — this is purely a display concern.
      const visibleHistoryWeeks = Math.max(horizon * 3, 12);
      const history = fullHistory.slice(-visibleHistoryWeeks);

      lastKnownWeek = fullHistory[fullHistory.length - 1].week;
      const lastDate = new Date(lastKnownWeek);
      lagDays = Math.max(0, Math.round((Date.now() - lastDate.getTime()) / 86_400_000));

      // Stitch the last historical point onto the forecast line so the chart
      // doesn't show a visual gap between the two segments.
      const lastHistory = history[history.length - 1];
      const bridgePoint = {
        week: lastHistory.week,
        count: lastHistory.count,
        lower: lastHistory.count,
        upper: lastHistory.count,
        ...(mode === "backtest" ? { actual: lastHistory.count } : {})
      };

      const historyValues = history.map((p) => ({ week: p.week, count: p.count }));
      const forecastValues = [bridgePoint, ...futurePoints];

      // Vertical rule between observed history and forecast/held-out region.
      const splitMarker = [{ week: lastHistory.week }];

      if (mode === "backtest") {
        metrics = (data as BacktestResponse).metrics;
      }

      result = await embed(
        container,
        {
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
          background: "transparent",
          width: "container",
          height: 320,
          padding: { left: 8, right: 8, top: 4, bottom: 0 },
          layer: [
            {
              data: { values: splitMarker },
              mark: { type: "rule", color: "#9aa6ae", strokeDash: [3, 3], strokeWidth: 1 },
              encoding: {
                x: { field: "week", type: "temporal" }
              }
            },
            {
              data: { values: forecastValues },
              mark: { type: "area", color: "#006d77", opacity: 0.2, interpolate: "monotone" },
              encoding: {
                x: { field: "week", type: "temporal" },
                y: { field: "lower", type: "quantitative" },
                y2: { field: "upper" },
                tooltip: [
                  { field: "week", type: "temporal", title: "Week" },
                  { field: "lower", type: "quantitative", title: "P10", format: ",.0f" },
                  { field: "upper", type: "quantitative", title: "P90", format: ",.0f" }
                ]
              }
            },
            {
              data: { values: historyValues },
              mark: { type: "line", color: "#172026", strokeWidth: 2, interpolate: "monotone" },
              encoding: {
                x: { field: "week", type: "temporal", title: null, axis: { labelColor: "#4d5b65", grid: false } },
                y: { field: "count", type: "quantitative", title: "Complaints", axis: { labelColor: "#4d5b65", titleColor: "#4d5b65", gridColor: "#eef1f4" } },
                tooltip: [
                  { field: "week", type: "temporal", title: "Week" },
                  { field: "count", type: "quantitative", title: "Observed", format: ",.0f" }
                ]
              }
            },
            {
              data: { values: forecastValues },
              mark: { type: "line", color: "#006d77", strokeWidth: 2, strokeDash: [4, 3], interpolate: "monotone" },
              encoding: {
                x: { field: "week", type: "temporal" },
                y: { field: "count", type: "quantitative" },
                tooltip: [
                  { field: "week", type: "temporal", title: "Week" },
                  { field: "count", type: "quantitative", title: "Forecast P50", format: ",.2f" }
                ]
              }
            },
            ...(mode === "backtest"
              ? [
                  {
                    data: { values: futurePoints as BacktestPoint[] },
                    mark: { type: "line", color: "#b10026", strokeWidth: 2, interpolate: "monotone" },
                    encoding: {
                      x: { field: "week", type: "temporal" },
                      y: { field: "actual", type: "quantitative" },
                      tooltip: [
                        { field: "week", type: "temporal", title: "Week" },
                        { field: "actual", type: "quantitative", title: "Actual", format: ",.0f" }
                      ]
                    }
                  },
                  {
                    data: { values: futurePoints as BacktestPoint[] },
                    mark: { type: "point", color: "#b10026", filled: true, size: 50 },
                    encoding: {
                      x: { field: "week", type: "temporal" },
                      y: { field: "actual", type: "quantitative" }
                    }
                  }
                ]
              : [])
          ]
        },
        { actions: false, renderer: "canvas" }
      );

      status = "ready";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      status = "error";
    }
  }

  $effect(() => {
    // Touch reactive deps so $effect re-fires on any input change.
    void mode;
    void borough;
    void offense;
    void horizon;
    void historyWeeks;
    if (hasLoaded) void load();
  });

  onDestroy(() => result?.finalize());

  function formatNumber(n: number, digits = 2): string {
    if (Number.isNaN(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }
</script>

<article class="chart-card" use:inView={load}>
  <header class="chart-header">
    <div>
      <h3>{title}</h3>
      <p class="chart-sub">
        model: <code>{modelName || "amazon/chronos-2"}</code>
        · mode: <code>{mode}</code>
        {#if lastKnownWeek}
          · data ends: <code>{lastKnownWeek}</code>{#if lagDays !== null} ({lagDays} days ago){/if}
        {/if}
      </p>
    </div>
    <div class="legend">
      <span class="dot dot-history"></span><span>Observed</span>
      <span class="dot dot-forecast"></span><span>Forecast P50</span>
      {#if mode === "backtest"}
        <span class="dot dot-actual"></span><span>Actual (held-out)</span>
      {/if}
      <span class="band-swatch"></span><span>P10–P90</span>
    </div>
  </header>

  {#if mode === "backtest" && metrics}
    <div class="metrics-row">
      <div class="metric">
        <span class="label">MAPE</span>
        <strong>{formatNumber(metrics.mape)}%</strong>
        <span class="hint">avg relative error</span>
      </div>
      <div class="metric">
        <span class="label">MAE</span>
        <strong>{formatNumber(metrics.mae)}</strong>
        <span class="hint">avg error in complaints</span>
      </div>
      <div class="metric">
        <span class="label">P10–P90 coverage</span>
        <strong>{formatNumber(metrics.coverage * 100, 0)}%</strong>
        <span class="hint">target ≈ 80%</span>
      </div>
    </div>
  {/if}

  <div class="chart-body">
    {#if status === "loading"}
      <div class="state loading"><div class="spinner"></div>Loading forecast…</div>
    {:else if status === "empty"}
      <div class="state empty">Not enough history for this filter slice.</div>
    {:else if status === "error"}
      <div class="state error">
        <strong>Could not load forecast</strong>
        <div class="error-detail">{errorMessage}</div>
      </div>
    {/if}
    <div bind:this={container} class="vega-container" class:hidden={status !== "ready"}></div>
  </div>
</article>

<style>
  .chart-card {
    background: white;
    border: 1px solid #d8e0e6;
    border-radius: 10px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.05);
    overflow: hidden;
  }

  .chart-header {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #eef1f4;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .chart-header h3 {
    margin: 0;
    font-size: 1.1rem;
    color: #172026;
  }

  .chart-sub {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: #60717d;
  }

  .chart-sub code {
    background: #f6f8fa;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.78rem;
    color: #4d5b65;
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: #4d5b65;
    flex-wrap: wrap;
  }

  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .dot-history { background: #172026; }
  .dot-forecast { background: #006d77; }
  .dot-actual { background: #b10026; }

  .band-swatch {
    display: inline-block;
    width: 14px;
    height: 10px;
    background: rgba(0, 109, 119, 0.2);
    border: 1px solid rgba(0, 109, 119, 0.5);
    border-radius: 2px;
  }

  .metrics-row {
    display: flex;
    gap: 1.4rem;
    padding: 0.75rem 1.25rem;
    background: #f6f8fa;
    border-bottom: 1px solid #eef1f4;
    flex-wrap: wrap;
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .metric .label {
    font-size: 0.72rem;
    color: #60717d;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .metric strong {
    font-size: 1.05rem;
    color: #172026;
  }

  .metric .hint {
    font-size: 0.7rem;
    color: #8a98a3;
    font-style: italic;
  }

  .chart-body {
    position: relative;
    padding: 1rem 1.25rem 1.1rem;
    min-height: 340px;
  }

  .vega-container {
    width: 100%;
  }

  .vega-container.hidden {
    visibility: hidden;
  }

  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 320px;
    color: #60717d;
    font-size: 0.9rem;
    gap: 0.6rem;
  }

  .state.error {
    flex-direction: column;
    align-items: center;
    color: #b00020;
    gap: 0.25rem;
  }

  .error-detail {
    font-size: 0.8rem;
    color: #4d5b65;
    max-width: 480px;
    text-align: center;
    word-break: break-word;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #d8e0e6;
    border-top-color: #006d77;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
