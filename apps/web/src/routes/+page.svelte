<script lang="ts">
  import { env } from "$env/dynamic/public";
  import CategoryChart from "$lib/components/CategoryChart.svelte";
  import CrimeMap from "$lib/components/CrimeMap.svelte";
  import ForecastChart from "$lib/components/ForecastChart.svelte";
  import HourChart from "$lib/components/HourChart.svelte";
  import TimeSeriesChart from "$lib/components/TimeSeriesChart.svelte";
  import WeekdayChart from "$lib/components/WeekdayChart.svelte";

  type CrimeRecord = {
    complaint_number: string;
    complaint_start_date: string;
    complaint_start_time: string | null;
    offense_category: string;
    borough: string | null;
    precinct: number | null;
  };

  type CrimeRecordsResponse = {
    total: number;
    items: CrimeRecord[];
  };

  type CategoryResponse = {
    totals: Array<{ key: string; count: number }>;
  };

  type ByDateResponse = {
    buckets: Array<{ bucket: string; count: number }>;
  };

  const apiBaseUrl = env.PUBLIC_API_BASE_URL ?? "http://localhost:3000";

  const boroughOptions = [
    "",
    "BRONX",
    "BROOKLYN",
    "MANHATTAN",
    "QUEENS",
    "STATEN ISLAND"
  ];

  // Default to the current year so analytics, map and tables show a focused
  // recent slice. Without this, with ~1.3M records over 27 months the map
  // saturates and the daily timeseries becomes unreadable. Users can clear the
  // filter to see the full range.
  const todayIso = new Date().toISOString().slice(0, 10);
  let dateFrom = $state(`${todayIso.slice(0, 4)}-01-01`);
  let dateTo = $state(todayIso);
  let borough = $state("");
  let offenseCategory = $state("");
  let overviewStatus: "loading" | "ready" | "empty" | "error" = $state("loading");
  let overviewError = $state("");
  let totalComplaints = $state(0);
  let topBorough = $state("No data");
  let topBoroughCount = $state(0);
  let topCategory = $state("No data");
  let topCategoryCount = $state(0);
  let coveredPeriod = $state("No data");
  let recentRecords = $state<CrimeRecord[]>([]);
  let overviewRequestId = 0;

  let forecastMode = $state<"forecast" | "backtest">("forecast");
  let forecastHorizon = $state(8);

  function buildCrimeRecordsUrl(): string {
    const url = new URL("/crime-records", apiBaseUrl);
    if (dateFrom) url.searchParams.set("from", dateFrom);
    if (dateTo) url.searchParams.set("to", dateTo);
    if (borough) url.searchParams.set("borough", borough);
    if (offenseCategory.trim()) url.searchParams.set("offenseCategory", offenseCategory.trim());
    return url.toString();
  }

  function buildAnalyticsFilterQuery(): string {
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (borough) params.set("borough", borough);
    if (offenseCategory.trim()) params.set("offense", offenseCategory.trim());
    return params.toString();
  }

  function buildAnalyticsUrl(path: string): string {
    const url = new URL(path, apiBaseUrl);
    const filters = new URLSearchParams(buildAnalyticsFilterQuery());
    filters.forEach((value, key) => url.searchParams.set(key, value));
    return url.toString();
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  function formatPeriod(buckets: ByDateResponse["buckets"]): string {
    if (buckets.length === 0) return "No data";
    const first = buckets[0]?.bucket.slice(0, 10);
    const last = buckets[buckets.length - 1]?.bucket.slice(0, 10);
    return first === last ? first : `${first} to ${last}`;
  }

  async function loadOverview(filterSignature: string): Promise<void> {
    const requestId = ++overviewRequestId;
    overviewStatus = "loading";
    overviewError = "";

    try {
      const recordsUrl = new URL(buildCrimeRecordsUrl());
      recordsUrl.searchParams.set("page", "1");
      recordsUrl.searchParams.set("pageSize", "10");

      const boroughUrl = buildAnalyticsUrl("/analytics/by-category?dimension=borough&limit=1");
      const categoryUrl = buildAnalyticsUrl("/analytics/by-category?dimension=offense_category&limit=1");
      const periodUrl = buildAnalyticsUrl("/analytics/by-date?granularity=month");

      const [records, boroughs, categories, dates] = await Promise.all([
        fetchJson<CrimeRecordsResponse>(recordsUrl.toString()),
        fetchJson<CategoryResponse>(boroughUrl),
        fetchJson<CategoryResponse>(categoryUrl),
        fetchJson<ByDateResponse>(periodUrl)
      ]);

      if (requestId !== overviewRequestId || filterSignature !== buildAnalyticsFilterQuery()) return;

      totalComplaints = records.total;
      recentRecords = records.items;
      topBorough = boroughs.totals[0]?.key ?? "No data";
      topBoroughCount = boroughs.totals[0]?.count ?? 0;
      topCategory = categories.totals[0]?.key ?? "No data";
      topCategoryCount = categories.totals[0]?.count ?? 0;
      coveredPeriod = formatPeriod(dates.buckets);
      overviewStatus = totalComplaints === 0 ? "empty" : "ready";
    } catch (error) {
      if (requestId !== overviewRequestId) return;
      overviewStatus = "error";
      overviewError = error instanceof Error ? error.message : String(error);
    }
  }

  const clearFilters = () => {
    dateFrom = "";
    dateTo = "";
    borough = "";
    offenseCategory = "";
  };

  $effect(() => {
    const signature = buildAnalyticsFilterQuery();
    void loadOverview(signature);
  });
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
    <div class="eyebrow-row">
      <p class="eyebrow">Open Data / Big Data Project</p>
      <span class="api-pill">API: {apiBaseUrl}</span>
    </div>
    <div class="hero-copy">
      <div>
        <h1>CrimeScope NYC</h1>
        <p class="summary">
          A simple dashboard for browsing NYPD complaint data with a map, quick filters,
          and analytics cards. Built to run entirely in Docker.
        </p>
      </div>
      <div class="hero-links">
        <a href={`${apiBaseUrl}/crime-records?page=1&pageSize=25`} target="_blank" rel="noreferrer">
          Open records API
        </a>
        <a href={`${apiBaseUrl}/health`} target="_blank" rel="noreferrer">
          API health
        </a>
      </div>
    </div>
  </section>

  <section class="dashboard-grid" aria-label="CrimeScope dashboard">
    <aside class="filters-panel" aria-label="Filters">
      <header class="section-header">
        <h2>Filters</h2>
        <p>Use these controls to narrow the dashboard and preview the API query.</p>
      </header>

      <div class="filter-form">
        <label>
          <span>Date from</span>
          <input bind:value={dateFrom} type="date" />
        </label>

        <label>
          <span>Date to</span>
          <input bind:value={dateTo} type="date" />
        </label>

        <label>
          <span>Borough</span>
          <select bind:value={borough}>
            {#each boroughOptions as option}
              <option value={option}>{option || "Any borough"}</option>
            {/each}
          </select>
        </label>

        <label>
          <span>Offense category</span>
          <input
            bind:value={offenseCategory}
            type="text"
            placeholder="e.g. Assault, Theft"
          />
        </label>
      </div>

      <div class="filter-actions">
        <a class="primary-link" href={buildCrimeRecordsUrl()} target="_blank" rel="noreferrer">
          View filtered records
        </a>
        <button type="button" class="secondary-button" onclick={clearFilters}>
          Reset filters
        </button>
      </div>

      <div class="filter-summary">
        <span>Current query</span>
        <code>{buildCrimeRecordsUrl()}</code>
      </div>

      <div class="api-links">
        <a href={buildAnalyticsUrl("/analytics/by-date?granularity=month")} target="_blank" rel="noreferrer">
          Monthly trend
        </a>
        <a href={buildAnalyticsUrl("/analytics/by-category?dimension=offense_category&limit=10")} target="_blank" rel="noreferrer">
          Top categories
        </a>
        <a href={buildAnalyticsUrl("/aggregations/h3?resolution=9")} target="_blank" rel="noreferrer">
          H3 density
        </a>
      </div>
    </aside>

    <div class="content-stack">
      <section class="overview-panel" aria-label="Dashboard overview">
        <div class="kpi-grid">
          <article class="kpi-card accent-total">
            <span>Total complaints</span>
            <strong>{overviewStatus === "loading" ? "..." : totalComplaints.toLocaleString()}</strong>
            <small>Current filter scope</small>
          </article>

          <article class="kpi-card">
            <span>Top borough</span>
            <strong>{overviewStatus === "loading" ? "..." : topBorough}</strong>
            <small>{topBoroughCount.toLocaleString()} complaints</small>
          </article>

          <article class="kpi-card">
            <span>Top category</span>
            <strong>{overviewStatus === "loading" ? "..." : topCategory}</strong>
            <small>{topCategoryCount.toLocaleString()} complaints</small>
          </article>

          <article class="kpi-card">
            <span>Period covered</span>
            <strong>{overviewStatus === "loading" ? "..." : coveredPeriod}</strong>
            <small>Grouped by month</small>
          </article>
        </div>

        {#if overviewStatus === "empty"}
          <div class="empty-banner">
            <strong>No records found</strong>
            <span>Run the ingest service or broaden the filters to populate the dashboard.</span>
            <code>docker compose --profile ingest run --rm -e INGEST_MODE=socrata -e INGEST_LIMIT=500 ingest</code>
          </div>
        {:else if overviewStatus === "error"}
          <div class="empty-banner error-banner">
            <strong>Overview unavailable</strong>
            <span>{overviewError}</span>
          </div>
        {/if}

        <div class="pipeline-strip" aria-label="Data pipeline">
          <span>NYC Open Data</span>
          <span>Ingest</span>
          <span>ClickHouse</span>
          <span>Elysia API</span>
          <span>SvelteKit Dashboard</span>
        </div>
      </section>

      <section class="map-panel" aria-label="Map">
        <header class="section-header">
          <h2>Map</h2>
          <p>Crime density aggregated server-side and rendered with MapLibre GL JS.</p>
        </header>
        <CrimeMap {apiBaseUrl} filterQuery={buildAnalyticsFilterQuery()} />
      </section>

      <section class="records-panel" aria-label="Recent crime records">
        <header class="section-header records-header">
          <div>
            <h2>Recent records</h2>
            <p>Latest complaints matching the current filters.</p>
          </div>
          <a href={buildCrimeRecordsUrl()} target="_blank" rel="noreferrer">Open full API result</a>
        </header>

        {#if overviewStatus === "loading"}
          <div class="table-state">Loading records...</div>
        {:else if recentRecords.length === 0}
          <div class="table-state">No records to show.</div>
        {:else}
          <div class="records-table-wrap">
            <table class="records-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Borough</th>
                  <th>Category</th>
                  <th>Precinct</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {#each recentRecords as record}
                  <tr>
                    <td>
                      <strong>{record.complaint_start_date}</strong>
                      <span>{record.complaint_start_time ?? "time unknown"}</span>
                    </td>
                    <td>{record.borough ?? "Unknown"}</td>
                    <td>{record.offense_category}</td>
                    <td>{record.precinct ?? "N/A"}</td>
                    <td><code>{record.complaint_number}</code></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section class="analytics-panel" aria-label="Predictions">
        <header class="section-header forecast-header">
          <div>
            <h2>Predictions</h2>
            <p>
              Weekly complaint forecast powered by Amazon Chronos-2. Backtest mode holds out the
              last <strong>{forecastHorizon}</strong> known weeks, predicts them, and scores accuracy.
            </p>
          </div>
          <div class="forecast-controls">
            <div class="mode-toggle" role="tablist" aria-label="Forecast mode">
              <button
                type="button"
                role="tab"
                aria-selected={forecastMode === "forecast"}
                class:active={forecastMode === "forecast"}
                onclick={() => (forecastMode = "forecast")}
              >
                Forecast
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={forecastMode === "backtest"}
                class:active={forecastMode === "backtest"}
                onclick={() => (forecastMode = "backtest")}
              >
                Backtest
              </button>
            </div>
            <label class="horizon-select">
              <span>Horizon</span>
              <select bind:value={forecastHorizon}>
                <option value={4}>4 weeks</option>
                <option value={8}>8 weeks</option>
                <option value={12}>12 weeks</option>
                <option value={16}>16 weeks</option>
                <option value={26}>26 weeks (6 mo)</option>
                <option value={52}>52 weeks (1 yr)</option>
              </select>
            </label>
          </div>
        </header>
        <ForecastChart
          mode={forecastMode}
          borough={borough}
          offense={offenseCategory}
          horizon={forecastHorizon}
          title={forecastMode === "backtest" ? "Backtest: forecast vs actual" : "Weekly complaint forecast"}
        />
      </section>

      <section class="analytics-panel" aria-label="Analytics">
        <header class="section-header">
          <h2>Analytics</h2>
          <p>Simple time and category views for the current dataset.</p>
        </header>
        <div class="charts-grid">
          <div class="charts-wide">
            <TimeSeriesChart
              {apiBaseUrl}
              filterQuery={buildAnalyticsFilterQuery()}
              granularity="day"
              title="Complaints per day"
            />
          </div>
          <HourChart {apiBaseUrl} filterQuery={buildAnalyticsFilterQuery()} />
          <WeekdayChart {apiBaseUrl} filterQuery={buildAnalyticsFilterQuery()} />
          <CategoryChart
            {apiBaseUrl}
            filterQuery={buildAnalyticsFilterQuery()}
            dimension="offense_category"
            limit={10}
            title="Top offense categories"
          />
        </div>
      </section>
    </div>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    color: #14212b;
    background:
      radial-gradient(circle at top left, rgba(0, 109, 119, 0.16), transparent 32%),
      radial-gradient(circle at top right, rgba(176, 0, 38, 0.14), transparent 28%),
      #f6f8fa;
  }

  .shell {
    min-height: 100vh;
    display: grid;
    align-content: start;
    gap: 2rem;
    max-width: 1360px;
    margin: 0 auto;
    padding: 2rem 1rem 3rem;
  }

  .hero {
    display: grid;
    gap: 1rem;
    padding: 1.25rem 1.25rem 0;
  }

  .eyebrow-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .eyebrow {
    margin: 0;
    color: #006d77;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.8rem;
  }

  .api-pill {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0 0.75rem;
    border-radius: 999px;
    background: rgba(0, 109, 119, 0.1);
    color: #005d68;
    font-size: 0.82rem;
    font-weight: 700;
  }

  .hero-copy {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.4rem, 8vw, 4.8rem);
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

  .hero-links {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .hero-links a,
  .primary-link,
  .api-links a,
  .secondary-button {
    border-radius: 10px;
    font-weight: 700;
    text-decoration: none;
    transition:
      transform 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .hero-links a,
  .primary-link,
  .api-links a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.6rem;
    padding: 0 1rem;
    background: #14212b;
    color: #f6f8fa;
  }

  .hero-links a:hover,
  .primary-link:hover,
  .api-links a:hover,
  .secondary-button:hover {
    transform: translateY(-1px);
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
    padding: 0 1rem;
  }

  .filters-panel,
  .overview-panel,
  .map-panel,
  .records-panel,
  .analytics-panel {
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #d8e0e6;
    border-radius: 8px;
    box-shadow: 0 14px 34px rgba(20, 33, 43, 0.08);
    overflow: hidden;
  }

  .filters-panel {
    position: sticky;
    top: 1rem;
    display: grid;
    gap: 1rem;
    padding: 1.2rem;
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

  .filter-form {
    display: grid;
    gap: 0.9rem;
  }

  .filter-form label {
    display: grid;
    gap: 0.35rem;
  }

  .filter-form span {
    color: #4d5b65;
    font-size: 0.86rem;
    font-weight: 700;
  }

  .filter-form input,
  .filter-form select {
    width: 100%;
    min-height: 2.6rem;
    padding: 0.55rem 0.75rem;
    border: 1px solid #cfd8df;
    border-radius: 10px;
    background: #fff;
    color: #14212b;
    font: inherit;
    box-sizing: border-box;
  }

  .filter-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .secondary-button {
    min-height: 2.6rem;
    border: 1px solid #cfd8df;
    background: #fff;
    color: #14212b;
    cursor: pointer;
    padding: 0 1rem;
  }

  .filter-summary {
    display: grid;
    gap: 0.4rem;
  }

  .filter-summary span {
    color: #4d5b65;
    font-size: 0.86rem;
    font-weight: 700;
  }

  .filter-summary code {
    padding: 0.75rem;
    border-radius: 12px;
    background: #f6f8fa;
    border: 1px solid #d8e0e6;
    color: #4d5b65;
    font-size: 0.78rem;
    word-break: break-all;
  }

  .api-links {
    display: grid;
    gap: 0.65rem;
  }

  .api-links a {
    background: #006d77;
  }

  .content-stack {
    display: grid;
    gap: 1.25rem;
  }

  .overview-panel {
    display: grid;
    gap: 1rem;
    padding: 1.2rem;
  }

  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.85rem;
  }

  .kpi-card {
    display: grid;
    gap: 0.35rem;
    min-height: 112px;
    padding: 1rem;
    border: 1px solid #d8e0e6;
    border-radius: 8px;
    background: #fff;
  }

  .kpi-card span,
  .kpi-card small {
    color: #60717d;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .kpi-card strong {
    align-self: center;
    color: #14212b;
    font-size: 1.45rem;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .accent-total {
    background: #14212b;
    border-color: #14212b;
  }

  .accent-total span,
  .accent-total small {
    color: #b8c6cf;
  }

  .accent-total strong {
    color: #fff;
  }

  .empty-banner {
    display: grid;
    gap: 0.35rem;
    padding: 1rem;
    border: 1px solid #f1c56b;
    border-radius: 8px;
    background: #fff8e5;
    color: #5a4100;
  }

  .empty-banner span {
    color: #6b5a27;
  }

  .empty-banner code {
    display: block;
    padding: 0.65rem;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.75);
    color: #14212b;
    font-size: 0.8rem;
    overflow-x: auto;
  }

  .error-banner {
    border-color: #f1a1a8;
    background: #fff0f1;
    color: #8f001a;
  }

  .pipeline-strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .pipeline-strip span {
    min-height: 2.2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.55rem;
    border-radius: 6px;
    background: #eef6f7;
    color: #005d68;
    font-size: 0.78rem;
    font-weight: 800;
    text-align: center;
  }

  .map-panel,
  .records-panel,
  .analytics-panel {
    display: grid;
    gap: 1rem;
    padding: 1.2rem;
  }

  .map-panel {
    min-height: 560px;
  }

  .forecast-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .forecast-controls {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .mode-toggle {
    display: inline-flex;
    border: 1px solid #cfd8df;
    border-radius: 10px;
    overflow: hidden;
    background: #fff;
  }

  .mode-toggle button {
    border: 0;
    background: transparent;
    padding: 0.55rem 1rem;
    cursor: pointer;
    color: #4d5b65;
    font-weight: 700;
    font-size: 0.86rem;
  }

  .mode-toggle button.active {
    background: #006d77;
    color: #fff;
  }

  .horizon-select {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.86rem;
    color: #4d5b65;
    font-weight: 700;
  }

  .horizon-select select {
    min-height: 2.4rem;
    padding: 0.3rem 0.65rem;
    border: 1px solid #cfd8df;
    border-radius: 10px;
    background: #fff;
    color: #14212b;
    font: inherit;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 1.25rem;
  }

  .charts-wide {
    grid-column: 1 / -1;
  }

  .records-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
  }

  .records-header a {
    color: #006d77;
    font-size: 0.9rem;
    font-weight: 800;
    text-decoration: none;
  }

  .records-table-wrap {
    overflow-x: auto;
    border: 1px solid #d8e0e6;
    border-radius: 8px;
  }

  .records-table {
    width: 100%;
    min-width: 720px;
    border-collapse: collapse;
    background: #fff;
  }

  .records-table th,
  .records-table td {
    padding: 0.8rem 0.9rem;
    border-bottom: 1px solid #eef1f4;
    text-align: left;
    vertical-align: top;
  }

  .records-table th {
    color: #60717d;
    font-size: 0.76rem;
    text-transform: uppercase;
  }

  .records-table td {
    color: #14212b;
    font-size: 0.9rem;
  }

  .records-table td span {
    display: block;
    margin-top: 0.15rem;
    color: #60717d;
    font-size: 0.78rem;
  }

  .records-table code {
    color: #4d5b65;
    font-size: 0.78rem;
  }

  .records-table tr:last-child td {
    border-bottom: 0;
  }

  .table-state {
    display: grid;
    place-items: center;
    min-height: 140px;
    border: 1px dashed #cfd8df;
    border-radius: 8px;
    color: #60717d;
    background: #fff;
  }

  @media (max-width: 1024px) {
    .dashboard-grid {
      grid-template-columns: 1fr;
    }

    .filters-panel {
      position: static;
    }

    .kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .shell {
      padding: 1rem 0.75rem 2rem;
    }

    .hero,
    .dashboard-grid {
      padding-left: 0;
      padding-right: 0;
    }

    .filter-actions {
      grid-template-columns: 1fr;
    }

    .kpi-grid,
    .pipeline-strip {
      grid-template-columns: 1fr;
    }

    .records-header {
      align-items: start;
      flex-direction: column;
    }

    .charts-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
