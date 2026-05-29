<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Result } from "vega-embed";
  import { inView } from "$lib/actions/inView";

  type Bucket = { weekday: number; label: string; count: number };
  type ByWeekdayResponse = { buckets: Bucket[] };

  let {
    apiBaseUrl = "http://localhost:3000",
    filterQuery = "",
    title = "Complaints by weekday"
  }: {
    apiBaseUrl?: string;
    filterQuery?: string;
    title?: string;
  } = $props();

  let container: HTMLDivElement;
  let result: Result | undefined;
  let status: "loading" | "ready" | "empty" | "error" = $state("loading");
  let totalComplaints = $state(0);
  let peakLabel = $state("");
  let errorMessage = $state("");
  let hasLoaded = false;

  function applyFilters(url: URL, query: string): void {
    const filters = new URLSearchParams(query);
    filters.forEach((value, key) => url.searchParams.set(key, value));
  }

  async function load(query = filterQuery) {
    hasLoaded = true;
    try {
      status = "loading";
      errorMessage = "";
      result?.finalize();
      result = undefined;
      const { default: embed } = await import("vega-embed");

      const url = new URL(`${apiBaseUrl}/analytics/by-weekday`);
      applyFilters(url, query);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
      const data = (await res.json()) as ByWeekdayResponse;

      if (data.buckets.length === 0) {
        status = "empty";
        return;
      }

      totalComplaints = data.buckets.reduce((s, b) => s + b.count, 0);
      const peak = data.buckets.reduce((p, b) => (b.count > p.count ? b : p));
      peakLabel = peak.label;

      result = await embed(
        container,
        {
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
          data: { values: data.buckets },
          mark: { type: "bar", color: "#fc4e2a", cornerRadiusTopLeft: 2, cornerRadiusTopRight: 2 },
          encoding: {
            x: {
              field: "label",
              type: "ordinal",
              title: null,
              sort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
              axis: { labelColor: "#172026", grid: false, labelAngle: 0 }
            },
            y: {
              field: "count",
              type: "quantitative",
              title: "Complaints",
              axis: { labelColor: "#4d5b65", titleColor: "#4d5b65", gridColor: "#eef1f4" }
            },
            color: {
              field: "label",
              type: "nominal",
              scale: {
                domain: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                range: ["#fed976", "#fed976", "#fed976", "#fed976", "#fd8d3c", "#fc4e2a", "#fc4e2a"]
              },
              legend: null
            },
            tooltip: [
              { field: "label", type: "nominal", title: "Day" },
              { field: "count", type: "quantitative", title: "Complaints" }
            ]
          },
          width: "container",
          height: 260,
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

  $effect(() => {
    const query = filterQuery;
    if (hasLoaded) void load(query);
  });

  onDestroy(() => result?.finalize());
</script>

<article class="chart-card" use:inView={load}>
  <header class="chart-header">
    <div>
      <h3>{title}</h3>
      <p class="chart-sub">weekday pattern (Mon -&gt; Sun)</p>
    </div>
    {#if status === "ready"}
      <div class="chart-stats">
        <span><strong>{peakLabel}</strong> peak</span>
        <span><strong>{totalComplaints.toLocaleString()}</strong> total</span>
      </div>
    {/if}
  </header>

  <div class="chart-body">
    {#if status === "loading"}
      <div class="state loading"><div class="spinner"></div>Loading weekday distribution...</div>
    {:else if status === "empty"}
      <div class="state empty">No complaints found.</div>
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
    min-height: 280px;
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
    height: 260px;
    color: #60717d;
    font-size: 0.9rem;
    gap: 0.6rem;
  }
  .state.error {
    flex-direction: column;
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
