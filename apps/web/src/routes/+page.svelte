<script lang="ts">
  import CategoryChart from "$lib/components/CategoryChart.svelte";
  import CrimeMap from "$lib/components/CrimeMap.svelte";
  import HourChart from "$lib/components/HourChart.svelte";
  import TimeSeriesChart from "$lib/components/TimeSeriesChart.svelte";
  import WeekdayChart from "$lib/components/WeekdayChart.svelte";

  const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000";
</script>

<svelte:head>
  <title>CrimeScope NYC</title>
  <meta
    name="description"
    content="Docker-first web application for NYPD crime data analysis and visualization."
  />
</svelte:head>

<main class="shell">
  <section class="hero">
    <p class="eyebrow">Open Data / Big Data Project</p>
    <h1>CrimeScope NYC</h1>
    <p class="summary">
      A Docker-first foundation for exploring NYPD crime data with maps, filters,
      analytics, and future time-series prediction.
    </p>
  </section>

  <section class="map-section" aria-label="Crime density map">
    <header class="section-header">
      <h2>Crime density (H3 resolution 9)</h2>
      <p>Live NYC Open Data, aggregated server-side and rendered with MapLibre GL JS.</p>
    </header>
    <CrimeMap {apiBaseUrl} />
  </section>

  <section class="analytics-section" aria-label="Analytics">
    <header class="section-header">
      <h2>Analytics</h2>
      <p>Aggregated views of the ingested complaints, powered by Vega-Lite.</p>
    </header>
    <div class="charts-grid">
      <div class="charts-wide">
        <TimeSeriesChart
          {apiBaseUrl}
          granularity="day"
          title="Complaints per day"
        />
      </div>
      <HourChart {apiBaseUrl} />
      <WeekdayChart {apiBaseUrl} />
      <CategoryChart
        {apiBaseUrl}
        dimension="offense_category"
        limit={10}
        title="Top offense categories"
      />
      <CategoryChart
        {apiBaseUrl}
        dimension="borough"
        limit={5}
        title="Complaints by borough"
      />
      <CategoryChart
        {apiBaseUrl}
        dimension="law_category"
        limit={5}
        title="Severity (law category)"
      />
    </div>
  </section>

  <section class="status-grid" aria-label="Service links">
    <a href={`${apiBaseUrl}/health`} target="_blank" rel="noreferrer">
      <span>API</span>
      <strong>/health</strong>
    </a>
    <a href={`${apiBaseUrl}/db-health`} target="_blank" rel="noreferrer">
      <span>ClickHouse</span>
      <strong>/db-health</strong>
    </a>
    <a href={`${apiBaseUrl}/aggregations/h3?resolution=9`} target="_blank" rel="noreferrer">
      <span>API</span>
      <strong>/aggregations/h3</strong>
    </a>
    <a href={`${apiBaseUrl}/analytics/by-date?granularity=month`} target="_blank" rel="noreferrer">
      <span>API</span>
      <strong>/analytics/by-date</strong>
    </a>
    <a href={`${apiBaseUrl}/analytics/by-category?dimension=offense_category`} target="_blank" rel="noreferrer">
      <span>API</span>
      <strong>/analytics/by-category</strong>
    </a>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    color: #172026;
    background: #f6f8fa;
  }

  .shell {
    min-height: 100vh;
    display: grid;
    align-content: start;
    gap: 2.5rem;
    max-width: 1200px;
    margin: 0 auto;
    padding: 3rem 1.5rem;
  }

  .hero {
    display: grid;
    gap: 1rem;
  }

  .eyebrow {
    margin: 0;
    color: #006d77;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.8rem;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.5rem, 8vw, 5rem);
    line-height: 1;
    letter-spacing: 0;
  }

  .summary {
    max-width: 680px;
    margin: 0;
    color: #4d5b65;
    font-size: 1.125rem;
    line-height: 1.6;
  }

  .map-section,
  .analytics-section {
    display: grid;
    gap: 1rem;
  }

  .section-header {
    display: grid;
    gap: 0.25rem;
  }

  .section-header h2 {
    margin: 0;
    font-size: 1.5rem;
  }

  .section-header p {
    margin: 0;
    color: #4d5b65;
    font-size: 0.95rem;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 1.25rem;
  }

  .charts-wide {
    grid-column: 1 / -1;
  }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }

  .status-grid a {
    display: grid;
    gap: 0.35rem;
    min-height: 96px;
    padding: 1rem;
    border: 1px solid #d8e0e6;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    background: white;
  }

  .status-grid span {
    color: #60717d;
    font-size: 0.9rem;
  }

  .status-grid strong {
    font-size: 1.2rem;
  }
</style>
