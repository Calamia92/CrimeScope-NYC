import { readFileSync } from "fs";

async function main() {
	const clickhouseHost = process.env.CLICKHOUSE_HOST ?? "clickhouse";
	const clickhousePort = process.env.CLICKHOUSE_HTTP_PORT ?? "8123";
	const clickhouseUser = process.env.CLICKHOUSE_USER ?? "crimescope";
	const clickhousePassword = process.env.CLICKHOUSE_PASSWORD ?? "crimescope_password";
	const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE ?? "crimescope";

	console.log("Starting ingest (sample) to ClickHouse at", clickhouseHost + ":" + clickhousePort);

	const samplePath = new URL("../sample/sample.json", import.meta.url);
	const raw = readFileSync(samplePath, "utf-8");
	const records = JSON.parse(raw) as Array<Record<string, unknown>>;

	if (!records.length) {
		console.log("No sample records found, exiting.");
		return;
	}

	// Build JSONEachRow body (one JSON object per line)
	const body = records.map((r) => JSON.stringify(r)).join("\n");

	const deleteQuery = `ALTER TABLE ${clickhouseDatabase}.raw_nypd_complaints DELETE WHERE source_dataset = 'sample'`;
	const insertQuery = `INSERT INTO ${clickhouseDatabase}.raw_nypd_complaints FORMAT JSONEachRow`;
	const url = `http://${clickhouseHost}:${clickhousePort}/?user=${encodeURIComponent(
		clickhouseUser
	)}&password=${encodeURIComponent(clickhousePassword)}&query=${encodeURIComponent(deleteQuery)}`;

	const insertUrl = `http://${clickhouseHost}:${clickhousePort}/?user=${encodeURIComponent(
		clickhouseUser
	)}&password=${encodeURIComponent(clickhousePassword)}&query=${encodeURIComponent(insertQuery)}`;

	console.log("Clearing previous sample rows...");

	const deleteResponse = await fetch(url, { method: "POST" });
	const deleteText = await deleteResponse.text();

	if (!deleteResponse.ok) {
		console.error("Failed to clear previous sample rows:", deleteResponse.status, deleteResponse.statusText);
		console.error(deleteText);
		process.exit(1);
	}

	console.log("Posting", records.length, "records to ClickHouse... (this may take a moment)");

	try {
		const res = await fetch(insertUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body
		});

		const text = await res.text();

		if (!res.ok) {
			console.error("ClickHouse responded with error:", res.status, res.statusText);
			console.error(text);
			process.exit(1);
		}

		console.log("Ingest completed successfully.");
		if (text) console.log("ClickHouse response:", text);
	} catch (err) {
		console.error("Failed to POST to ClickHouse:", err);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
