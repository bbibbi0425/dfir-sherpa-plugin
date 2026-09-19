import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { searchRecords, coverageRanks, MAX_RESPONSE_BYTES } from "../src/searchRecords.mjs";
import { createSearchFixture } from "./searchFixture.mjs";

const root = mkdtempSync(join(tmpdir(), "sherpa-search-test-"));
const path = join(root, "fixture.sqlite");
let initial;
const hash = p => createHash("sha256").update(readFileSync(p)).digest("hex");
before(() => { createSearchFixture(path); initial = { hash: hash(path), modified: statSync(path).mtimeMs }; });
after(() => {
  assert.equal(hash(path), initial.hash);
  assert.equal(statSync(path).mtimeMs, initial.modified);
  assert.equal(readdirSync(root).some(name => /-(wal|shm|journal)$/.test(name)), false);
  // Only the private directory created by this test is removed.
  rmSync(root, { recursive: true });
});

test("defaults: exact count, 8 deterministic coverage samples, no full text fields", () => {
  const result = searchRecords(path, { query: "shared" });
  assert.equal(result.ok, true);
  assert.equal(result.total_matches, 40);
  assert.equal(result.returned, 8);
  assert.equal(result.limit, 8);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.sampling.ranks, [1, 6, 12, 17, 23, 28, 34, 40]);
  assert.deepEqual(result.records.map(r => r.rowid), ["3", "18", "36", "51", "69", "84", "102", "120"]);
  assert.deepEqual(searchRecords(path, { query: "shared" }).records, result.records);
  assert.ok(result.elapsed_ms >= 0);
  for (const row of result.records) {
    assert.equal("detail" in row, false); assert.equal("payload" in row, false);
    assert.equal("subject" in row, false);
    assert.ok(Array.from(row.snippet).length <= 300);
  }
});

test("coverage ranks include ends, use midpoint for one, never duplicate", () => {
  assert.deepEqual(coverageRanks(0, 8), []);
  assert.deepEqual(coverageRanks(40, 1), [19]);
  assert.deepEqual(coverageRanks(3, 10), [0, 1, 2]);
  for (let count = 1; count < 100; count++) {
    for (let limit = 1; limit <= 10; limit++) {
      const ranks = coverageRanks(count, limit);
      assert.equal(new Set(ranks).size, Math.min(count, limit));
      assert.ok(ranks.every(i => i >= 0 && i < count));
    }
  }
});

test("maximum 10; invalid limits and unknown fields fail without widening results", () => {
  assert.equal(searchRecords(path, { limit: 10 }).returned, 10);
  assert.equal(searchRecords(path, { limit: 1 }).records[0].rowid, "60");
  for (const limit of [0, 11, -1, 1.5, "10", null, NaN]) {
    // null is deliberately invalid, not a request to silently change the limit.
    assert.equal(searchRecords(path, { limit }).ok, false);
  }
  assert.equal(searchRecords(path, { sql: "SELECT * FROM timeline" }).error, "INVALID_ARGUMENT");
});

test("literal percent, underscore, backslash, quotes and SQL-like strings", () => {
  for (const query of ["100%_literal\\value", '"quote"', "한글🙂"]) {
    const result = searchRecords(path, { query });
    assert.equal(result.total_matches, 40);
    assert.equal(result.records[0].snippet_field, "detail");
    assert.ok(result.records[0].snippet.includes(query));
    assert.ok(result.records[0].snippet.startsWith("…"));
  }
  assert.equal(searchRecords(path, { query: "' OR 1=1 --" }).total_matches, 0);
  assert.equal(searchRecords(path, { query: "QUARTZ" }).total_matches, 40);
});

test("payload search and metadata-only filters with inclusive text timestamps", () => {
  const result = searchRecords(path, { query: '"generic"', source: "beta", event_type: "note" });
  assert.equal(result.total_matches, 6);
  assert.ok(result.records.every(r => r.source === "beta" && r.event_type === "note" && r.snippet_field === "payload"));
  const one = searchRecords(path, { timestamp_from: "2025-01-02T00:00:00Z", timestamp_to: "2025-01-02T00:00:00Z" });
  assert.equal(one.total_matches, 2);
  assert.equal(searchRecords(path, { timestamp_from: "z", timestamp_to: "a" }).error, "INVALID_ARGUMENT");
  assert.equal(searchRecords(path, { source: "ALPHA" }).total_matches, 0);
});

test("zero and small matches return all; whitespace stays literal", () => {
  const none = searchRecords(path, { query: "no_synthetic_match" });
  assert.equal(none.total_matches, 0); assert.equal(none.truncated, false);
  assert.deepEqual(none.records, []); assert.deepEqual(none.sampling.ranks, []);
  assert.equal(searchRecords(path, { query: "narrow-40 " }).total_matches, 1);
  assert.equal(searchRecords(path, { query: "  quartz" }).total_matches, 0);
});

test("parameter validation and paths never create a DB or expose raw errors", () => {
  for (const input of [null, [], { query: 2 }, { query: "x".repeat(257) }, { query: "\0" }, { source: "" }]) {
    assert.equal(searchRecords(path, input).error, "INVALID_ARGUMENT");
  }
  assert.equal(searchRecords("relative.sqlite", {}).error, "DB_NOT_CONFIGURED");
  const missing = join(root, "missing.sqlite");
  const result = searchRecords(missing, {});
  assert.equal(result.error, "DB_READ_FAILED");
  assert.equal(existsSync(missing), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("wrong schema fails and does not fall back to the derived records table", () => {
  const wrong = join(root, "wrong.sqlite");
  const db = new DatabaseSync(wrong);
  db.exec("CREATE TABLE records(line_id TEXT)"); db.close();
  const previous = hash(wrong);
  assert.equal(searchRecords(wrong, {}).error, "INVALID_SCHEMA");
  assert.equal(hash(wrong), previous);
});

test("long fields, Unicode and escaped controls respect snippet and total budgets", () => {
  const large = join(root, "large.sqlite");
  createSearchFixture(large);
  const db = new DatabaseSync(large);
  const update = db.prepare("UPDATE timeline SET line_id=?, timestamp=?, source=?, event_type=?, subject=?, detail=?, payload=? WHERE rowid=?");
  for (let i = 1; i <= 40; i++) {
    const controls = "\x01".repeat(500);
    update.run(String(i) + controls, controls, controls, controls, "", controls, "🙂".repeat(1000), i * 3);
  }
  db.close();
  const result = searchRecords(large, { limit: 10 });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESPONSE_BYTES);
  assert.equal(result.snippets_shortened_for_budget, true);
  assert.ok(result.records.every(r => Array.from(r.snippet).length <= 300 && r.truncated_fields.length === 4));
  const unicode = searchRecords(large, { query: "🙂".repeat(128), limit: 1 });
  assert.equal(unicode.ok, true);
  assert.ok(unicode.records.every(r => r.snippet.includes("🙂".repeat(128))));
});

test("long matching query remains within a centered snippet", () => {
  const result = searchRecords(path, { query: "z".repeat(256) });
  assert.equal(result.total_matches, 40);
  assert.ok(result.records.every(r => r.snippet.includes("z".repeat(256)) && Array.from(r.snippet).length <= 300));
});
