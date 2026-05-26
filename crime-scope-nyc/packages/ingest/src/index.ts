import { latLngToCell } from "h3-js";

console.log("CrimeScope NYC ingest placeholder");
console.log("Future NYC Open Data ingestion scripts will live in packages/ingest.");
console.log("This service will eventually load NYPD complaint data into ClickHouse.");
console.log(`H3 example cell for NYC City Hall: ${latLngToCell(40.7128, -74.006, 9)}`);
