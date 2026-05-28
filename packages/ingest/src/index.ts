import { readFileSync } from "fs";
import { latLngToCell } from "h3-js";

const MODE = (process.env.INGEST_MODE ?? "socrata").toLowerCase();
const LIMIT = Number(process.env.INGEST_LIMIT ?? 5000);
const BATCH_SIZE = Number(process.env.INGEST_BATCH_SIZE ?? 1000);
const SOCRATA_ENDPOINT =
	process.env.NYPD_SOCRATA_ENDPOINT ??
	"https://data.cityofnewyork.us/resource/qgea-i56i.json";
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN ?? "";

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST ?? "clickhouse";
const CLICKHOUSE_PORT = process.env.CLICKHOUSE_HTTP_PORT ?? "8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER ?? "crimescope";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "crimescope_password";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "crimescope";

const H3_PRIMARY = 9;
const H3_SECONDARY = 7;

type CrimeRow = {
	complaint_number: string;
	complaint_start_date: string;
	complaint_start_time: string | null;
	complaint_end_date: string | null;
	complaint_end_time: string | null;
	report_datetime: string | null;
	offense_code: number | null;
	offense_category: string;
	offense_description: string | null;
	law_category: string | null;
	borough: string | null;
	precinct: number | null;
	jurisdiction_description: string | null;
	location_of_occurrence: string | null;
	premise_description: string | null;
	latitude: number | null;
	longitude: number | null;
	h3_res_9: string | null;
	h3_res_7: string | null;
	source_dataset: string;
	source_record_url: string | null;
	source_row_checksum: string | null;
};

type SocrataRecord = {
	cmplnt_num?: string;
	cmplnt_fr_dt?: string;
	cmplnt_fr_tm?: string;
	cmplnt_to_dt?: string;
	cmplnt_to_tm?: string;
	rpt_dt?: string;
	ky_cd?: string;
	ofns_desc?: string;
	pd_desc?: string;
	law_cat_cd?: string;
	boro_nm?: string;
	addr_pct_cd?: string;
	juris_desc?: string;
	loc_of_occur_desc?: string;
	prem_typ_desc?: string;
	latitude?: string;
	longitude?: string;
};

function clickhouseUrl(query: string): string {
	const params = new URLSearchParams({
		user: CLICKHOUSE_USER,
		password: CLICKHOUSE_PASSWORD,
		database: CLICKHOUSE_DATABASE,
		query
	});
	return `http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/?${params.toString()}`;
}

// h3-js exposes cells as 15-char hex strings; ClickHouse stores them as UInt64.
// We convert hex -> BigInt -> decimal string to keep full 64-bit precision through JSON.
function h3UInt64(lat: number, lng: number, res: number): string {
	const cell = latLngToCell(lat, lng, res);
	return BigInt("0x" + cell).toString();
}

function toIntOrNull(v: unknown): number | null {
	if (v == null || v === "") return null;
	const n = Number.parseInt(String(v), 10);
	return Number.isFinite(n) ? n : null;
}

function toFloatOrNull(v: unknown): number | null {
	if (v == null || v === "") return null;
	const n = Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : null;
}

function isoDateOnly(v: unknown): string | null {
	if (typeof v !== "string" || v.length < 10) return null;
	return v.slice(0, 10);
}

function socrataToCrimeRow(raw: SocrataRecord): CrimeRow | null {
	if (!raw.cmplnt_num || !raw.cmplnt_fr_dt) return null;

	const startDate = isoDateOnly(raw.cmplnt_fr_dt);
	if (!startDate) return null;

	const lat = toFloatOrNull(raw.latitude);
	const lng = toFloatOrNull(raw.longitude);
	const hasGeo = lat !== null && lng !== null;

	const reportDt = typeof raw.rpt_dt === "string" ? raw.rpt_dt.replace("T", " ").slice(0, 23) : null;

	return {
		complaint_number: raw.cmplnt_num,
		complaint_start_date: startDate,
		complaint_start_time: raw.cmplnt_fr_tm ?? null,
		complaint_end_date: isoDateOnly(raw.cmplnt_to_dt),
		complaint_end_time: raw.cmplnt_to_tm ?? null,
		report_datetime: reportDt,
		offense_code: toIntOrNull(raw.ky_cd),
		offense_category: raw.ofns_desc ?? "UNKNOWN",
		offense_description: raw.pd_desc ?? raw.ofns_desc ?? null,
		law_category: raw.law_cat_cd ?? null,
		borough: raw.boro_nm ?? null,
		precinct: toIntOrNull(raw.addr_pct_cd),
		jurisdiction_description: raw.juris_desc ?? null,
		location_of_occurrence: raw.loc_of_occur_desc ?? null,
		premise_description: raw.prem_typ_desc ?? null,
		latitude: hasGeo ? lat : null,
		longitude: hasGeo ? lng : null,
		h3_res_9: hasGeo ? h3UInt64(lat!, lng!, H3_PRIMARY) : null,
		h3_res_7: hasGeo ? h3UInt64(lat!, lng!, H3_SECONDARY) : null,
		source_dataset: "qgea-i56i",
		source_record_url: `${SOCRATA_ENDPOINT}?cmplnt_num=${encodeURIComponent(raw.cmplnt_num)}`,
		source_row_checksum: null
	};
}

function enrichSampleRow(raw: Record<string, unknown>): CrimeRow {
	const lat = typeof raw.latitude === "number" ? raw.latitude : toFloatOrNull(raw.latitude);
	const lng = typeof raw.longitude === "number" ? raw.longitude : toFloatOrNull(raw.longitude);
	const hasGeo = lat !== null && lng !== null;

	// Force-compute H3 from coords if available, ignoring any null placeholders in the sample file.
	const h3_9 = hasGeo ? h3UInt64(lat!, lng!, H3_PRIMARY) : null;
	const h3_7 = hasGeo ? h3UInt64(lat!, lng!, H3_SECONDARY) : null;

	return {
		complaint_number: String(raw.complaint_number ?? ""),
		complaint_start_date: String(raw.complaint_start_date ?? ""),
		complaint_start_time: (raw.complaint_start_time as string | null) ?? null,
		complaint_end_date: (raw.complaint_end_date as string | null) ?? null,
		complaint_end_time: (raw.complaint_end_time as string | null) ?? null,
		report_datetime: (raw.report_datetime as string | null) ?? null,
		offense_code: toIntOrNull(raw.offense_code),
		offense_category: (raw.offense_category as string) ?? "UNKNOWN",
		offense_description: (raw.offense_description as string | null) ?? null,
		law_category: (raw.law_category as string | null) ?? null,
		borough: (raw.borough as string | null) ?? null,
		precinct: toIntOrNull(raw.precinct),
		jurisdiction_description: (raw.jurisdiction_description as string | null) ?? null,
		location_of_occurrence: (raw.location_of_occurrence as string | null) ?? null,
		premise_description: (raw.premise_description as string | null) ?? null,
		latitude: lat,
		longitude: lng,
		h3_res_9: h3_9,
		h3_res_7: h3_7,
		source_dataset: (raw.source_dataset as string) ?? "sample",
		source_record_url: (raw.source_record_url as string | null) ?? null,
		source_row_checksum: (raw.source_row_checksum as string | null) ?? null
	};
}

async function loadSample(): Promise<CrimeRow[]> {
	const samplePath = new URL("../sample/sample.json", import.meta.url);
	const raw = JSON.parse(readFileSync(samplePath, "utf-8")) as Array<Record<string, unknown>>;
	return raw.map(enrichSampleRow);
}

async function fetchSocrata(): Promise<CrimeRow[]> {
	const url = new URL(SOCRATA_ENDPOINT);
	url.searchParams.set("$limit", String(LIMIT));
	url.searchParams.set(
		"$where",
		"latitude IS NOT NULL AND longitude IS NOT NULL AND cmplnt_fr_dt IS NOT NULL"
	);
	url.searchParams.set("$order", "cmplnt_fr_dt DESC");

	console.log(`[ingest] fetching up to ${LIMIT} records from ${url.host}...`);
	const headers: Record<string, string> = {};
	if (SOCRATA_APP_TOKEN) headers["X-App-Token"] = SOCRATA_APP_TOKEN;

	const res = await fetch(url.toString(), { headers });
	if (!res.ok) {
		throw new Error(`Socrata returned ${res.status} ${res.statusText}: ${await res.text()}`);
	}
	const raw = (await res.json()) as SocrataRecord[];
	console.log(`[ingest] received ${raw.length} raw records from NYC Open Data.`);

	const mapped: CrimeRow[] = [];
	for (const r of raw) {
		const row = socrataToCrimeRow(r);
		if (row) mapped.push(row);
	}
	const dropped = raw.length - mapped.length;
	if (dropped > 0) console.log(`[ingest] dropped ${dropped} records (missing id or date).`);
	return mapped;
}

async function deleteWhereDataset(dataset: string): Promise<void> {
	const query = `ALTER TABLE ${CLICKHOUSE_DATABASE}.raw_nypd_complaints DELETE WHERE source_dataset = '${dataset.replace(/'/g, "''")}'`;
	const res = await fetch(clickhouseUrl(query), { method: "POST" });
	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`Failed to clear previous '${dataset}' rows: ${res.status} ${txt}`);
	}
}

async function insertBatch(rows: CrimeRow[]): Promise<void> {
	const query = `INSERT INTO ${CLICKHOUSE_DATABASE}.raw_nypd_complaints FORMAT JSONEachRow`;
	const body = rows.map((r) => JSON.stringify(r)).join("\n");
	const res = await fetch(clickhouseUrl(query), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body
	});
	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`ClickHouse insert failed: ${res.status} ${txt}`);
	}
}

async function main(): Promise<void> {
	console.log(
		`[ingest] mode=${MODE} target=${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/${CLICKHOUSE_DATABASE}`
	);

	let rows: CrimeRow[];
	let dataset: string;
	if (MODE === "sample") {
		rows = await loadSample();
		dataset = "sample";
	} else if (MODE === "socrata") {
		rows = await fetchSocrata();
		dataset = "qgea-i56i";
	} else {
		throw new Error(`Unknown INGEST_MODE '${MODE}'. Expected 'socrata' or 'sample'.`);
	}

	const withGeo = rows.filter((r) => r.h3_res_9 !== null).length;
	console.log(
		`[ingest] prepared ${rows.length} rows (${withGeo} geocoded, H3 r${H3_PRIMARY} + r${H3_SECONDARY}).`
	);

	if (rows.length === 0) {
		console.log("[ingest] nothing to insert, exiting.");
		return;
	}

	console.log(`[ingest] clearing previous '${dataset}' rows...`);
	await deleteWhereDataset(dataset);

	console.log(`[ingest] inserting in batches of ${BATCH_SIZE}...`);
	for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
		const chunk = rows.slice(offset, offset + BATCH_SIZE);
		await insertBatch(chunk);
		console.log(`[ingest] inserted ${Math.min(offset + chunk.length, rows.length)}/${rows.length}`);
	}

	console.log("[ingest] done.");
}

main().catch((err) => {
	console.error("[ingest] failed:", err);
	process.exit(1);
});
