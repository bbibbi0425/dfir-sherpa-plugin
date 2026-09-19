import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSearchFixture } from "./searchFixture.mjs";
import { datasetOverview, OVERVIEW_MAX_BYTES } from "../src/datasetOverview.mjs";
import { RECORD_FIELDS } from "../src/recordTools.mjs";

const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "sherpa-overview-"));
  try { const path = join(root, "fixture.sqlite"); createSearchFixture(path); run(path, root); }
  finally { rmSync(root, { recursive: true }); }
}

test("overview returns metadata only, text extrema, four tool purposes and bounded audit", () => fixture((path, root) => {
  const before = hash(path), mtime = statSync(path).mtimeMs, files = readdirSync(root);
  const logs = [];
  const result = datasetOverview(path, {}, entry => logs.push(entry));
  assert.equal(result.ok, true);
  assert.equal(result.dataset, "fixture.sqlite");
  assert.equal(result.total_records, 40);
  assert.deepEqual(result.available_fields, RECORD_FIELDS);
  assert.equal(result.first_timestamp, "2025-01-01T00:00:00Z");
  assert.equal(result.last_timestamp, "2025-01-28T00:00:00Z");
  assert.equal(result.distinct_source_count, 2);
  assert.deepEqual(Object.keys(result.supported_tools), ["dataset_overview", "search_records", "get_record", "get_context"]);
  assert.deepEqual(Object.keys(result), ["ok", "dataset", "total_records", "available_fields", "first_timestamp", "last_timestamp", "timestamp_order", "distinct_source_count", "supported_tools", "elapsed_ms"]);
  const json = JSON.stringify(result);
  assert.ok(Buffer.byteLength(json) <= OVERVIEW_MAX_BYTES);
  for (const forbidden of ["quartz", "sample-", "synthetic.csv", root]) assert.ok(!json.includes(forbidden));
  assert.deepEqual(logs, [{ tool: "dataset_overview", line_id: null, returned: 0, elapsed_ms: result.elapsed_ms }]);
  assert.equal(hash(path), before);
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.deepEqual(readdirSync(root), files);
}));

test("empty timeline returns zero counts and null timestamp bounds", () => fixture(path => {
  const db = new DatabaseSync(path); db.exec("DELETE FROM timeline"); db.close(); // synthetic fixture only
  const result = datasetOverview(path, {}, () => {});
  assert.equal(result.ok, true);
  assert.equal(result.total_records, 0);
  assert.equal(result.distinct_source_count, 0);
  assert.equal(result.first_timestamp, null);
  assert.equal(result.last_timestamp, null);
}));

test("overview rejects model arguments, unconfigured paths, absent DB and invalid schema", () => fixture((path, root) => {
  for (const args of [null, [], { sql: "SELECT 1" }, { path }]) {
    assert.equal(datasetOverview(path, args, () => {}).error, "INVALID_ARGUMENT");
  }
  for (const value of ["", "relative.sqlite", null]) assert.equal(datasetOverview(value, {}, () => {}).error, "DB_NOT_CONFIGURED");
  const missing = join(root, "missing.sqlite");
  assert.equal(datasetOverview(missing, {}, () => {}).error, "DB_READ_FAILED");
  assert.equal(existsSync(missing), false);
  const invalid = join(root, "invalid.sqlite"); const db = new DatabaseSync(invalid);
  db.exec("CREATE TABLE timeline(line_id TEXT)"); db.close();
  assert.equal(datasetOverview(invalid, {}, () => {}).error, "INVALID_SCHEMA");
}));

test("abnormal long timestamp fails compactly without a misleading truncated timestamp", () => fixture(path => {
  const db = new DatabaseSync(path); db.prepare("UPDATE timeline SET timestamp=?").run("x".repeat(4096)); db.close();
  const result = datasetOverview(path, {}, () => {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_METADATA");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= OVERVIEW_MAX_BYTES);
}));
