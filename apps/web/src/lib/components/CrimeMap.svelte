<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import maplibregl, { type GeoJSONSource, type Map } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { cellToBoundary } from "h3-js";

  type H3Cell = { h3: string; count: number; lat: number; lng: number };
  type H3Response = {
    resolution: number;
    cellCount: number;
    cells: H3Cell[];
  };

  let {
    apiBaseUrl = "http://localhost:3000",
    filterQuery = ""
  }: { apiBaseUrl?: string; filterQuery?: string } = $props();

  // Step-function palette: visible thresholds match the legend below.
  const STOPS: Array<[number, string]> = [
    [1, "#ffeda0"],
    [25, "#fed976"],
    [50, "#feb24c"],
    [100, "#fd8d3c"],
    [250, "#fc4e2a"],
    [500, "#e31a1c"],
    [1000, "#b10026"]
  ];

  let mapContainer: HTMLDivElement;
  let map: Map | undefined;
  let status: "loading" | "ready" | "error" = $state("loading");
  let cellCount = $state(0);
  let maxCount = $state(0);
  let totalComplaints = $state(0);
  let errorMessage = $state("");

  function buildCellsUrl(): string {
    const url = new URL(`${apiBaseUrl}/aggregations/h3`);
    url.searchParams.set("resolution", "9");
    const filters = new URLSearchParams(filterQuery);
    filters.forEach((value, key) => url.searchParams.set(key, value));
    return url.toString();
  }

  function cellsToGeoJson(cells: H3Cell[]): GeoJSON.FeatureCollection {
    return {
      type: "FeatureCollection",
      features: cells.map((cell, idx) => ({
        type: "Feature",
        id: idx, // required for feature-state (hover)
        properties: { count: cell.count, h3: cell.h3 },
        geometry: {
          type: "Polygon",
          coordinates: [cellToBoundary(cell.h3, true) as [number, number][]]
        }
      }))
    };
  }

  async function loadCells(currentMap: Map): Promise<void> {
    try {
      status = "loading";
      const res = await fetch(buildCellsUrl());
      if (!res.ok) throw new Error(`API returned ${res.status} ${res.statusText}`);
      const data = (await res.json()) as H3Response;
      cellCount = data.cellCount;
      maxCount = data.cells.reduce((m, c) => (c.count > m ? c.count : m), 0);
      totalComplaints = data.cells.reduce((s, c) => s + c.count, 0);

      const geojson = cellsToGeoJson(data.cells);
      const source = currentMap.getSource("h3-cells") as GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
        status = "ready";
        return;
      }

      currentMap.addSource("h3-cells", { type: "geojson", data: geojson });

      // Flatten STOPS into a MapLibre `step` expression.
      const stepExpr: (number | string)[] = ["step", ["get", "count"], STOPS[0][1]];
      for (let i = 1; i < STOPS.length; i++) {
        stepExpr.push(STOPS[i][0], STOPS[i][1]);
      }

      currentMap.addLayer({
        id: "h3-fill",
        type: "fill",
        source: "h3-cells",
        paint: {
          "fill-color": stepExpr as maplibregl.ExpressionSpecification,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            0.9,
            0.65
          ]
        }
      });

      // Subtle outline; thicker when hovered.
      currentMap.addLayer({
        id: "h3-outline",
        type: "line",
        source: "h3-cells",
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            "#1a1a1a",
            "rgba(60, 60, 60, 0.25)"
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            2,
            0.5
          ]
        }
      });

      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12
      });

      let hoveredId: number | null = null;
      currentMap.on("mousemove", "h3-fill", (e) => {
        currentMap.getCanvas().style.cursor = "pointer";
        if (!e.features || e.features.length === 0) return;
        const feat = e.features[0];
        const newId = feat.id as number;
        if (hoveredId !== null && hoveredId !== newId) {
          currentMap.setFeatureState(
            { source: "h3-cells", id: hoveredId },
            { hover: false }
          );
        }
        hoveredId = newId;
        currentMap.setFeatureState(
          { source: "h3-cells", id: hoveredId },
          { hover: true }
        );
        const props = feat.properties as { count: number; h3: string };
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div class="popup-body">` +
              `<div class="popup-count">${props.count} <span>complaint${props.count > 1 ? "s" : ""}</span></div>` +
              `<code class="popup-h3">${props.h3}</code>` +
              `</div>`
          )
          .addTo(currentMap);
      });

      currentMap.on("mouseleave", "h3-fill", () => {
        currentMap.getCanvas().style.cursor = "";
        if (hoveredId !== null) {
          currentMap.setFeatureState(
            { source: "h3-cells", id: hoveredId },
            { hover: false }
          );
          hoveredId = null;
        }
        popup.remove();
      });

      status = "ready";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      status = "error";
    }
  }

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      // CartoDB Voyager: light basemap with neighborhood + street labels, free to use.
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
      center: [-73.94, 40.73],
      zoom: 10.2,
      attributionControl: { compact: true }
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      if (map) loadCells(map);
    });
  });

  $effect(() => {
    filterQuery;
    if (map?.isStyleLoaded() && map.getSource("h3-cells")) {
      void loadCells(map);
    }
  });

  onDestroy(() => {
    map?.remove();
  });
</script>

<div class="map-wrapper">
  <div bind:this={mapContainer} class="map"></div>

  {#if status === "loading"}
    <div class="overlay top-left loading">
      <div class="spinner"></div>
      <span>Loading H3 cells from API...</span>
    </div>
  {:else if status === "error"}
    <div class="overlay top-left error">
      <strong>Could not load cells</strong>
      <div class="error-detail">{errorMessage}</div>
    </div>
  {:else}
    <div class="overlay top-left stats">
      <div class="stat">
        <span class="stat-num">{cellCount.toLocaleString()}</span>
        <span class="stat-label">H3 cells (r9)</span>
      </div>
      <div class="stat">
        <span class="stat-num">{totalComplaints.toLocaleString()}</span>
        <span class="stat-label">complaints</span>
      </div>
      <div class="stat">
        <span class="stat-num">{maxCount}</span>
        <span class="stat-label">peak / cell</span>
      </div>
    </div>

    <div class="overlay bottom-right legend">
      <div class="legend-title">Complaints per H3 cell</div>
      <div class="legend-row">
        {#each STOPS as [threshold, color], i}
          <div class="legend-step">
            <div class="legend-swatch" style:background={color}></div>
            <div class="legend-label">
              {#if i === STOPS.length - 1}
                {threshold}+
              {:else}
                {threshold}-{STOPS[i + 1][0] - 1}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .map-wrapper {
    position: relative;
    width: 100%;
    height: 70vh;
    min-height: 520px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #d8e0e6;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  }

  .map {
    position: absolute;
    inset: 0;
  }

  .overlay {
    position: absolute;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(6px);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
    color: #172026;
    font-size: 0.85rem;
    z-index: 2;
  }

  .top-left {
    top: 1rem;
    left: 1rem;
    padding: 0.65rem 0.9rem;
  }

  .bottom-right {
    bottom: 1.5rem;
    right: 1rem;
    padding: 0.7rem 0.9rem;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 0.6rem;
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

  .error {
    color: #b00020;
    max-width: 320px;
  }

  .error-detail {
    margin-top: 0.25rem;
    font-size: 0.78rem;
    color: #4d5b65;
    word-break: break-word;
  }

  .stats {
    display: flex;
    gap: 1.1rem;
    padding: 0.6rem 1rem;
  }

  .stat {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
  }

  .stat-num {
    font-size: 1.15rem;
    font-weight: 700;
    color: #172026;
  }

  .stat-label {
    font-size: 0.72rem;
    color: #60717d;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.15rem;
  }

  .legend {
    min-width: 240px;
  }

  .legend-title {
    font-size: 0.72rem;
    color: #60717d;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 0.5rem;
  }

  .legend-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
  }

  .legend-step {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .legend-swatch {
    width: 100%;
    height: 14px;
    border-radius: 2px;
  }

  .legend-label {
    font-size: 0.7rem;
    color: #4d5b65;
    font-variant-numeric: tabular-nums;
  }

  :global(.maplibregl-popup-content) {
    padding: 0.55rem 0.75rem !important;
    border-radius: 6px !important;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18) !important;
  }

  :global(.popup-body) {
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.3;
  }

  :global(.popup-count) {
    font-size: 1.1rem;
    font-weight: 700;
    color: #b10026;
  }

  :global(.popup-count span) {
    font-size: 0.78rem;
    font-weight: 400;
    color: #4d5b65;
    margin-left: 0.2rem;
  }

  :global(.popup-h3) {
    display: block;
    margin-top: 0.2rem;
    font-size: 0.72rem;
    color: #60717d;
  }
</style>
