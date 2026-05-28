<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Result } from "vega-embed";
  import { inView } from "$lib/actions/inView";

  type Slice = { key: string; count: number };
  type ByCategoryResponse = {
    dimension: string;
    limit: number;
    totalGroups: number;
    totals: Slice[];
  };

  let {
    apiBaseUrl = "http://localhost:3000",
    dimension = "offense_category",
    limit = 10,
    title = "Top categories"
  }: {
    apiBaseUrl?: string;
    dimension?: "offense_category" | "borough" | "law_category";
    limit?: number;
    title?: string;
  } = $props();

  let container: HTMLDivElement;
  let result: Result | undefined;
  let status: "loading" | "ready" | "empty" | "error" = $state("loading");
  let totalGroups = $state(0);
  let topCount = $state(0);
  let errorMessage = $state("");

  async function load() {
    if (status !== "loading") return;
    try {
      const { default: embed } = await import("vega-embed");

      const url = new URL(`${apiBaseUrl}/analytics/by-category`);
      url.searchParams.set("dimension", dimension);
      url.searchParams.set("limit", String(limit));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
      const data = (await res.json()) as ByCategoryResponse;
      totalGroups = data.totalGroups;
      topCount = data.totals[0]?.count ?? 0;

      if (totalGroups === 0) {
        status = "empty";
        return;
      }

      const height = Math.max(220, totalGroups * 26);

      result = await embed(
        container,
        {
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
          data: { values: data.totals },
          mark: { type: "bar", color: "#fc4e2a", cornerRadiusEnd: 2 },
          encoding: {
            y: {
              field: "key",
              type: "nominal",
              sort: "-x",
              title: null,
              axis: { labelLimit: 240, labelColor: "#172026", labelFontSize: 12 }
            },
            x: {
              field: "count",
              type: "quantitative",
              title: "Complaints",
              axis: { labelColor: "#4d5b65", titleColor: "#4d5b65", gridColor: "#eef1f4" }
            },
            tooltip: [
              { field: "key", type: "nominal", title: dimension },
              { field: "count", type: "quantitative", title: "Complaints" }
            ]
          },
          width: "container",
          height,
          background: "transparent",
          padding: { left: 8, right: 8, top: 4, bottom: 0 }
        },
        { actions: false, renderer: "canvas" }
      );

      status = "ready";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      status = "error";
    }
  }

  onDestroy(() => result?.finalize());
</script>

<article class="chart-card" use:inView={load}>
  <header class="chart-header">
    <div>
      <h3>{title}</h3>
      <p class="chart-sub">dimension: <code>{dimension}</code> &middot; top <code>{limit}</code></p>
    </div>
    {#if status === "ready"}
      <div class="chart-stats">
        <span><strong>{totalGroups}</strong> shown</span>
        <span><strong>{topCount.toLocaleString()}</strong> peak</span>
      </div>
    {/if}
  </header>

  <div class="chart-body">
    {#if status === "loading"}
      <div class="state loading"><div class="spinner"></div>Loading categories...</div>
    {:else if status === "empty"}
      <div class="state empty">No data for this dimension.</div>
    {:else if status === "error"}
      <div class="state error">
        <strong>Could not load chart</strong>
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

  .chart-stats {
    display: flex;
    gap: 1.1rem;
    font-size: 0.78rem;
    color: #60717d;
  }

  .chart-stats strong {
    color: #172026;
    font-size: 0.95rem;
  }

  .chart-body {
    position: relative;
    padding: 1rem 1.25rem 1.1rem;
    min-height: 240px;
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
    height: 220px;
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
    max-width: 380px;
    text-align: center;
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
    to {
      transform: rotate(360deg);
    }
  }
</style>
