import { readFileSync } from "fs";
import { latLngToCell } from "h3-js";

const MODE = (process.env.INGEST_MODE ?? "socrata").toLowerCase();
const LIMIT = Number(process.env.INGEST_LIMIT ?? 50000);
const BATCH_SIZE = Number(process.env.INGEST_BATCH_SIZE ?? 1000);
const SOCRATA_PAGE_SIZE = 50000;
const SOCRATA_ENDPOINT =
	process.env.NYPD_SOCRATA_ENDPOINT ??
	"https://data.cityofnewyork.us/resource/qgea-i56i.json";
// "Year-To-Date" dataset, refreshed weekly. Covers the current year only and is
// much fresher than the validated historic dataset, which lags by ~5 months.
const SOCRATA_YTD_ENDPOINT =
	process.env.NYPD_SOCRATA_YTD_ENDPOINT ??
	"https://data.cityofnewyork.us/resource/5uac-w243.json";
// Lower bound for the historic dataset. Anything earlier is dropped at the API
// level via $where so we don't waste bandwidth paginating through the full
// 10M-row archive.
const INGEST_HISTORIC_FROM = process.env.INGEST_HISTORIC_FROM ?? "2024-01-01";
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN ?? "";

type SocrataSource = {
	endpoint: string;
	dataset: string;
	label: string;
	where: string;
};

const HISTORIC_SOURCE: SocrataSource = {
	endpoint: SOCRATA_ENDPOINT,
	dataset: "qgea-i56i",
	label: "historic",
	where: `cmplnt_num IS NOT NULL AND cmplnt_fr_dt IS NOT NULL AND cmplnt_fr_dt >= '${INGEST_HISTORIC_FROM}T00:00:00'`
};

// YTD is keyed on the *report* date (rpt_dt), so it can contain complaints
// whose actual occurrence (cmplnt_fr_dt) is much older — sometimes back to the
// 70s. We apply the same date floor as the historic ingest to keep the time
// series clean for analytics, the map, and Chronos.
const YTD_SOURCE: SocrataSource = {
	endpoint: SOCRATA_YTD_ENDPOINT,
	dataset: "5uac-w243",
	label: "year-to-date",
	where: `cmplnt_num IS NOT NULL AND cmplnt_fr_dt IS NOT NULL AND cmplnt_fr_dt >= '${INGEST_HISTORIC_FROM}T00:00:00'`
};

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

type DataQualitySummary = {
	sourceRows: number;
	importedRows: number;
	skippedRows: number;
	skippedReasons: Record<string, number>;
	warnings: Record<string, number>;
};

type IngestionRunRow = {
	run_id: string;
	started_at: string;
	finished_at: string | null;
	mode: string;
	dataset: string;
	status: "success" | "failed";
	source_endpoint: string | null;
	requested_limit: number;
	source_rows: number;
	imported_rows: number;
	skipped_rows: number;
	geocoded_rows: number;
	warning_count: number;
	skipped_reasons_json: string;
	warnings_json: string;
	error_message: string | null;
	duration_ms: number;
};

function createQualitySummary(): DataQualitySummary {
	return {
		sourceRows: 0,
		importedRows: 0,
		skippedRows: 0,
		skippedReasons: {},
		warnings: {}
	};
}

function countReason(target: Record<string, number>, reason: string): void {
	target[reason] = (target[reason] ?? 0) + 1;
}

function skipRow(summary: DataQualitySummary, reason: string): null {
	summary.skippedRows += 1;
	countReason(summary.skippedReasons, reason);
	return null;
}

function warnRow(summary: DataQualitySummary, reason: string): void {
	countReason(summary.warnings, reason);
}

function clickhouseUrl(query: string): string {
	const params = new URLSearchParams({
		user: CLICKHOUSE_USER,
		password: CLICKHOUSE_PASSWORD,
		database: CLICKHOUSE_DATABASE,
		query
	});
	return `http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/?${params.toString()}`;
}

function toClickHouseDateTime(date: Date): string {
	return date.toISOString().replace("T", " ").replace("Z", "");
}

function countWarnings(summary: DataQualitySummary): number {
	return Object.values(summary.warnings).reduce((total, count) => total + count, 0);
}

async function postClickHouse(query: string, body?: string): Promise<void> {
	const res = await fetch(clickhouseUrl(query), {
		method: "POST",
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body
	});
	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`ClickHouse query failed: ${res.status} ${txt}`);
	}
}

async function ensureIngestionRunsTable(): Promise<void> {
	const query = `
		CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DATABASE}.ingestion_runs
		(
			run_id UUID,
			started_at DateTime64(3, 'UTC'),
			finished_at Nullable(DateTime64(3, 'UTC')),
			mode LowCardinality(String),
			dataset LowCardinality(String),
			status LowCardinality(String),
			source_endpoint Nullable(String),
			requested_limit UInt64,
			source_rows UInt64,
			imported_rows UInt64,
			skipped_rows UInt64,
			geocoded_rows UInt64,
			warning_count UInt64,
			skipped_reasons_json String,
			warnings_json String,
			error_message Nullable(String),
			duration_ms UInt64
		)
		ENGINE = MergeTree
		PARTITION BY toYYYYMM(started_at)
		ORDER BY (started_at, dataset, run_id)
		SETTINGS index_granularity = 8192
	`;
	await postClickHouse(query);
}

async function ensureAnalyticsMartTable(): Promise<void> {
	const query = `
		CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DATABASE}.crime_weekly_analytics
		(
			week_start Date,
			borough LowCardinality(String),
			offense_category LowCardinality(String),
			complaint_count UInt64,
			geocoded_count UInt64,
			h3_res_9_cells UInt64,
			refreshed_at DateTime64(3, 'UTC') DEFAULT now64(3)
		)
		ENGINE = MergeTree
		PARTITION BY toYYYYMM(week_start)
		ORDER BY (week_start, borough, offense_category)
		SETTINGS index_granularity = 8192
	`;
	await postClickHouse(query);
}

async function refreshWeeklyAnalyticsMart(): Promise<void> {
	console.log("[ingest] refreshing weekly analytics mart...");
	await postClickHouse(`TRUNCATE TABLE ${CLICKHOUSE_DATABASE}.crime_weekly_analytics`);
	await postClickHouse(`
		INSERT INTO ${CLICKHOUSE_DATABASE}.crime_weekly_analytics
		SELECT
			toStartOfWeek(complaint_start_date, 1) AS week_start,
			ifNull(borough, 'UNKNOWN') AS borough,
			offense_category,
			count() AS complaint_count,
			countIf(latitude IS NOT NULL AND longitude IS NOT NULL) AS geocoded_count,
			uniqExactIf(h3_res_9, h3_res_9 IS NOT NULL) AS h3_res_9_cells,
			now64(3) AS refreshed_at
		FROM ${CLICKHOUSE_DATABASE}.raw_nypd_complaints
		GROUP BY week_start, borough, offense_category
	`);
	console.log("[ingest] weekly analytics mart refreshed.");
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

function isValidCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [, yearText, monthText, dayText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

function isoDateOnly(v: unknown): string | null {
	if (typeof v !== "string" || v.length < 10) return null;
	const value = v.slice(0, 10);
	return isValidCalendarDate(value) ? value : null;
}

function normalizeCoordinates(
	rawLat: unknown,
	rawLng: unknown,
	summary: DataQualitySummary
): { lat: number | null; lng: number | null } {
	const lat = toFloatOrNull(rawLat);
	const lng = toFloatOrNull(rawLng);

	if (lat === null && lng === null) {
		warnRow(summary, "missing_coordinates");
		return { lat: null, lng: null };
	}

	if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
		warnRow(summary, "invalid_coordinates");
		return { lat: null, lng: null };
	}

	return { lat, lng };
}

function cleanText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.toLowerCase() !== "(null)" ? trimmed : null;
}

function makeSocrataMapper(source: SocrataSource) {
	return (raw: SocrataRecord, summary: DataQualitySummary): CrimeRow | null =>
		socrataToCrimeRow(raw, summary, source);
}

function socrataToCrimeRow(
	raw: SocrataRecord,
	summary: DataQualitySummary,
	source: SocrataSource = HISTORIC_SOURCE
): CrimeRow | null {
	const complaintNumber = cleanText(raw.cmplnt_num);
	if (!complaintNumber) return skipRow(summary, "missing_complaint_number");

	const startDate = isoDateOnly(raw.cmplnt_fr_dt);
	if (!startDate) return skipRow(summary, "missing_or_invalid_start_date");

	const { lat, lng } = normalizeCoordinates(raw.latitude, raw.longitude, summary);
	const hasGeo = lat !== null && lng !== null;
	const offenseCategory = cleanText(raw.ofns_desc);
	if (!offenseCategory) warnRow(summary, "missing_offense_category");

	const reportDt = typeof raw.rpt_dt === "string" ? raw.rpt_dt.replace("T", " ").slice(0, 23) : null;

	return {
		complaint_number: complaintNumber,
		complaint_start_date: startDate,
		complaint_start_time: raw.cmplnt_fr_tm ?? null,
		complaint_end_date: isoDateOnly(raw.cmplnt_to_dt),
		complaint_end_time: raw.cmplnt_to_tm ?? null,
		report_datetime: reportDt,
		offense_code: toIntOrNull(raw.ky_cd),
		offense_category: offenseCategory ?? "UNKNOWN",
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
		source_dataset: source.dataset,
		source_record_url: `${source.endpoint}?cmplnt_num=${encodeURIComponent(complaintNumber)}`,
		source_row_checksum: null
	};
}

function enrichSampleRow(raw: Record<string, unknown>, summary: DataQualitySummary): CrimeRow | null {
	const complaintNumber = cleanText(raw.complaint_number);
	if (!complaintNumber) return skipRow(summary, "missing_complaint_number");

	const startDate = isoDateOnly(raw.complaint_start_date);
	if (!startDate) return skipRow(summary, "missing_or_invalid_start_date");

	const { lat, lng } = normalizeCoordinates(raw.latitude, raw.longitude, summary);
	const hasGeo = lat !== null && lng !== null;
	const offenseCategory = cleanText(raw.offense_category);
	if (!offenseCategory) warnRow(summary, "missing_offense_category");

	// Force-compute H3 from coords if available, ignoring any null placeholders in the sample file.
	const h3_9 = hasGeo ? h3UInt64(lat!, lng!, H3_PRIMARY) : null;
	const h3_7 = hasGeo ? h3UInt64(lat!, lng!, H3_SECONDARY) : null;

	return {
		complaint_number: complaintNumber,
		complaint_start_date: startDate,
		complaint_start_time: (raw.complaint_start_time as string | null) ?? null,
		complaint_end_date: (raw.complaint_end_date as string | null) ?? null,
		complaint_end_time: (raw.complaint_end_time as string | null) ?? null,
		report_datetime: (raw.report_datetime as string | null) ?? null,
		offense_code: toIntOrNull(raw.offense_code),
		offense_category: offenseCategory ?? "UNKNOWN",
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

function mapValidRows<T>(
	sourceRows: T[],
	mapper: (row: T, summary: DataQualitySummary) => CrimeRow | null
): { rows: CrimeRow[]; summary: DataQualitySummary } {
	const summary = createQualitySummary();
	summary.sourceRows = sourceRows.length;
	const rows: CrimeRow[] = [];

	for (const sourceRow of sourceRows) {
		const row = mapper(sourceRow, summary);
		if (row) {
			rows.push(row);
			summary.importedRows += 1;
		}
	}

	return { rows, summary };
}

function printQualitySummary(summary: DataQualitySummary): void {
	console.log(
		`[ingest] data quality: source=${summary.sourceRows} imported=${summary.importedRows} skipped=${summary.skippedRows}`
	);

	for (const [reason, count] of Object.entries(summary.skippedReasons)) {
		console.log(`[ingest] skipped.${reason}=${count}`);
	}

	for (const [reason, count] of Object.entries(summary.warnings)) {
		console.log(`[ingest] warning.${reason}=${count}`);
	}
}

async function loadSample(): Promise<{ rows: CrimeRow[]; summary: DataQualitySummary }> {
	const samplePath = new URL("../sample/sample.json", import.meta.url);
	const raw = JSON.parse(readFileSync(samplePath, "utf-8")) as Array<Record<string, unknown>>;
	return mapValidRows(raw, enrichSampleRow);
}

async function fetchSocrataPage(
	source: SocrataSource,
	pageLimit: number,
	offset: number
): Promise<SocrataRecord[]> {
	const url = new URL(source.endpoint);
	url.searchParams.set("$limit", String(pageLimit));
	url.searchParams.set("$offset", String(offset));
	url.searchParams.set("$where", source.where);
	url.searchParams.set("$order", "cmplnt_fr_dt DESC");

	const headers: Record<string, string> = {};
	if (SOCRATA_APP_TOKEN) headers["X-App-Token"] = SOCRATA_APP_TOKEN;

	const res = await fetch(url.toString(), { headers });
	if (!res.ok) {
		throw new Error(`Socrata returned ${res.status} ${res.statusText}: ${await res.text()}`);
	}
	return (await res.json()) as SocrataRecord[];
}

async function fetchSocrata(
	source: SocrataSource,
	target: number
): Promise<{ rows: CrimeRow[]; summary: DataQualitySummary }> {
	const raw: SocrataRecord[] = [];
	let offset = 0;
	let page = 0;

	console.log(
		`[ingest] [${source.label}] fetching up to ${target} records from ${source.endpoint}`
	);
	while (raw.length < target) {
		const pageLimit = Math.min(SOCRATA_PAGE_SIZE, target - raw.length);
		page += 1;
		console.log(`[ingest] [${source.label}] page ${page}: limit=${pageLimit} offset=${offset}`);
		const records = await fetchSocrataPage(source, pageLimit, offset);
		raw.push(...records);
		if (records.length < pageLimit) {
			console.log(`[ingest] [${source.label}] reached end of dataset (${raw.length} records).`);
			break;
		}
		offset += pageLimit;
	}

	console.log(`[ingest] [${source.label}] received ${raw.length} raw records across ${page} page(s).`);

	return mapValidRows(raw, makeSocrataMapper(source));
}

async function deleteWhereDataset(dataset: string): Promise<void> {
	const query = `ALTER TABLE ${CLICKHOUSE_DATABASE}.raw_nypd_complaints DELETE WHERE source_dataset = '${dataset.replace(/'/g, "''")}' SETTINGS mutations_sync = 1`;
	await postClickHouse(query);
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

async function insertIngestionRun(run: IngestionRunRow): Promise<void> {
	const query = `INSERT INTO ${CLICKHOUSE_DATABASE}.ingestion_runs FORMAT JSONEachRow`;
	await postClickHouse(query, JSON.stringify(run));
}

async function main(): Promise<void> {
	console.log(
		`[ingest] mode=${MODE} target=${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/${CLICKHOUSE_DATABASE}`
	);

	if (!Number.isInteger(LIMIT) || LIMIT <= 0) {
		throw new Error(`Invalid INGEST_LIMIT '${process.env.INGEST_LIMIT}'. Expected a positive integer.`);
	}
	if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE <= 0) {
		throw new Error(
			`Invalid INGEST_BATCH_SIZE '${process.env.INGEST_BATCH_SIZE}'. Expected a positive integer.`
		);
	}

	await ensureIngestionRunsTable();
	await ensureAnalyticsMartTable();

	if (MODE === "sample") {
		await ingestDataset({
			dataset: "sample",
			sourceEndpoint: null,
			load: loadSample
		});
	} else if (MODE === "socrata") {
		// We combine two datasets so the time series stays current: the validated
		// "historic" archive (lags ~5 months) plus the YTD feed (refreshed weekly).
		for (const source of [HISTORIC_SOURCE, YTD_SOURCE]) {
			await ingestDataset({
				dataset: source.dataset,
				sourceEndpoint: source.endpoint,
				load: () => fetchSocrata(source, LIMIT)
			});
		}
	} else {
		throw new Error(`Unknown INGEST_MODE '${MODE}'. Expected 'socrata' or 'sample'.`);
	}

	await refreshWeeklyAnalyticsMart();
	console.log("[ingest] done.");
}

async function ingestDataset(input: {
	dataset: string;
	sourceEndpoint: string | null;
	load: () => Promise<{ rows: CrimeRow[]; summary: DataQualitySummary }>;
}): Promise<void> {
	const startedAt = new Date();
	const runId = crypto.randomUUID();
	let rows: CrimeRow[] = [];
	let summary = createQualitySummary();

	try {
		const loaded = await input.load();
		rows = loaded.rows;
		summary = loaded.summary;
		await ingestRows({ rows, summary, dataset: input.dataset });

		const finishedAt = new Date();
		await insertIngestionRun({
			run_id: runId,
			started_at: toClickHouseDateTime(startedAt),
			finished_at: toClickHouseDateTime(finishedAt),
			mode: MODE,
			dataset: input.dataset,
			status: "success",
			source_endpoint: input.sourceEndpoint,
			requested_limit: MODE === "sample" ? summary.sourceRows : LIMIT,
			source_rows: summary.sourceRows,
			imported_rows: summary.importedRows,
			skipped_rows: summary.skippedRows,
			geocoded_rows: rows.filter((r) => r.h3_res_9 !== null).length,
			warning_count: countWarnings(summary),
			skipped_reasons_json: JSON.stringify(summary.skippedReasons),
			warnings_json: JSON.stringify(summary.warnings),
			error_message: null,
			duration_ms: finishedAt.getTime() - startedAt.getTime()
		});
	} catch (error) {
		const finishedAt = new Date();
		await insertIngestionRun({
			run_id: runId,
			started_at: toClickHouseDateTime(startedAt),
			finished_at: toClickHouseDateTime(finishedAt),
			mode: MODE,
			dataset: input.dataset,
			status: "failed",
			source_endpoint: input.sourceEndpoint,
			requested_limit: MODE === "sample" ? summary.sourceRows : LIMIT,
			source_rows: summary.sourceRows,
			imported_rows: summary.importedRows,
			skipped_rows: summary.skippedRows,
			geocoded_rows: rows.filter((r) => r.h3_res_9 !== null).length,
			warning_count: countWarnings(summary),
			skipped_reasons_json: JSON.stringify(summary.skippedReasons),
			warnings_json: JSON.stringify(summary.warnings),
			error_message: error instanceof Error ? error.message : String(error),
			duration_ms: finishedAt.getTime() - startedAt.getTime()
		});
		throw error;
	}
}

async function ingestRows(input: {
	rows: CrimeRow[];
	summary: DataQualitySummary;
	dataset: string;
}): Promise<void> {
	const { rows, summary, dataset } = input;

	printQualitySummary(summary);

	const withGeo = rows.filter((r) => r.h3_res_9 !== null).length;
	console.log(
		`[ingest] [${dataset}] prepared ${rows.length} rows (${withGeo} geocoded, H3 r${H3_PRIMARY} + r${H3_SECONDARY}).`
	);

	console.log(`[ingest] [${dataset}] clearing previous rows...`);
	await deleteWhereDataset(dataset);

	if (rows.length === 0) {
		console.log(`[ingest] [${dataset}] nothing to insert.`);
		return;
	}

	console.log(`[ingest] [${dataset}] inserting in batches of ${BATCH_SIZE}...`);
	for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
		const chunk = rows.slice(offset, offset + BATCH_SIZE);
		await insertBatch(chunk);
		console.log(
			`[ingest] [${dataset}] inserted ${Math.min(offset + chunk.length, rows.length)}/${rows.length}`
		);
	}
}

main().catch((err) => {
	console.error("[ingest] failed:", err);
	process.exit(1);
});
