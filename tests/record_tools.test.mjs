import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getRecord, getContext, RECORD_FIELDS, MAX_OUTPUT_BYTES } from "../src/recordTools.mjs";
import { createSearchFixture } from "./searchFixture.mjs";

const root = mkdtempSync(join(tmpdir(), "sherpa-record-test-"));
const path = join(root, "fixture.sqlite");
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const silent = () => {};
let originalHash;
let originalTime;
before(() => { createSearchFixture(path); originalHash = hash(path); originalTime = statSync(path).mtimeMs; });
after(() => {
  assert.equal(hash(path), originalHash);
  assert.equal(statSync(path).mtimeMs, originalTime);
  assert.equal(readdirSync(root).some(name => /-(journal|wal|shm)$/.test(name)), false);
  rmSync(root, { recursive: true });
});

function fullRow(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT ${RECORD_FIELDS.map(f => `CAST(${f} AS BLOB) AS ${f}`).join(",")} FROM timeline WHERE line_id=?`).get(id);
    return Object.fromEntries(RECORD_FIELDS.map(f => [f, Buffer.from(row[f] ?? []).toString("utf8")]));
  }
  finally { db.close(); }
}

function checkRecord(result, expected) {
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.returned, 1);
  assert.deepEqual(Object.keys(result.record), RECORD_FIELDS);
  for (const field of RECORD_FIELDS) {
    assert.ok(expected[field].startsWith(result.record[field]), field);
    assert.equal(result.field_status[field].truncated, expected[field] !== result.record[field], field);
    assert.equal(result.field_status[field].original_bytes, Buffer.byteLength(expected[field]), field);
    assert.equal(result.field_status[field].returned_bytes, Buffer.byteLength(result.record[field]), field);
  }
  assert.equal(result.truncated, Object.values(result.field_status).some(s => s.truncated));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT_BYTES);
  assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
}

test("existing exact line_id returns all nine complete fields when small", () => {
  const result = getRecord(path, { line_id: "sample-020" }, silent);
  checkRecord(result, fullRow(path, "sample-020"));
  assert.equal(result.truncated, false);
});

test("not found is explicit for both tools; IDs are exact and not SQL", () => {
  for (const id of ["missing", "SAMPLE-020", "sample-%", "' OR 1=1 --", " sample-020"]) {
    for (const fn of [getRecord, getContext]) {
      const result = fn(path, { line_id: id }, silent);
      assert.equal(result.error, "NOT_FOUND");
      assert.equal(result.found, false);
      assert.equal(result.returned, 0);
      assert.ok(!result.record && !result.records);
    }
  }
});

test("first record context clips the missing preceding side", () => {
  const result = getContext(path, { line_id: "sample-001" }, silent);
  assert.equal(result.ok, true);
  assert.equal(result.before_returned, 0);
  assert.equal(result.after_returned, 3);
  assert.equal(result.target_index, 0);
  assert.deepEqual(result.records.map(r => r.rowid), ["3", "6", "9", "12"]);
});

test("last record context clips the missing following side", () => {
  const result = getContext(path, { line_id: "sample-040" }, silent);
  assert.equal(result.before_returned, 3);
  assert.equal(result.after_returned, 0);
  assert.equal(result.target_index, 3);
  assert.deepEqual(result.records.map(r => r.rowid), ["111", "114", "117", "120"]);
});

test("middle context uses nearest stored rows despite rowid gaps; default 7", () => {
  const result = getContext(path, { line_id: "sample-020" }, silent);
  assert.equal(result.returned, 7);
  assert.deepEqual(result.records.map(r => r.rowid), ["51", "54", "57", "60", "63", "66", "69"]);
  assert.equal(result.records.filter(r => r.is_target).length, 1);
  assert.equal(result.records[result.target_index].line_id, "sample-020");
  for (const row of result.records) {
    assert.equal("detail" in row || "payload" in row, false);
    assert.ok(Array.from(row.snippet).length <= 180);
    assert.equal(row.field_truncated.snippet, true);
  }
});

test("0..5 context bounds: zero gives anchor only, maximum gives 11; out of range rejects", () => {
  assert.equal(getContext(path, { line_id: "sample-020", before: 0, after: 0 }, silent).returned, 1);
  const maximum = getContext(path, { line_id: "sample-020", before: 5, after: 5 }, silent);
  assert.equal(maximum.returned, 11);
  assert.equal(maximum.target_index, 5);
  assert.equal(getContext(path, { line_id: "sample-020", before: 1 }, silent).returned, 5);
  for (const value of [-1, 6, 1.5, "3", null, NaN]) {
    for (const key of ["before", "after"]) {
      assert.equal(getContext(path, { line_id: "sample-020", [key]: value }, silent).error, "INVALID_ARGUMENT");
    }
  }
});

test("invalid input, missing DB and schema errors do not create or alter files", () => {
  for (const input of [null, [], {}, { line_id: "" }, { line_id: "x".repeat(257) }, { line_id: "\0" }, { line_id: 2 }, { line_id: "id", sql: "SELECT 1" }]) {
    for (const fn of [getRecord, getContext]) assert.equal(fn(path, input, silent).error, "INVALID_ARGUMENT");
  }
  assert.equal(getRecord(path, { line_id: "sample-020", before: 1 }, silent).error, "INVALID_ARGUMENT");
  assert.equal(getRecord("", { line_id: "id" }, silent).error, "DB_NOT_CONFIGURED");
  const missing = join(root, "missing.sqlite");
  assert.equal(getRecord(missing, { line_id: "id" }, silent).error, "DB_READ_FAILED");
  assert.equal(existsSync(missing), false);
  const wrong = join(root, "wrong.sqlite");
  const db = new DatabaseSync(wrong); db.exec("CREATE TABLE records(line_id TEXT)"); db.close();
  const previous = hash(wrong);
  assert.equal(getContext(wrong, { line_id: "id" }, silent).error, "INVALID_SCHEMA");
  assert.equal(hash(wrong), previous);
});

test("long fields, escaped controls and Unicode fit envelope with accurate truncation", (t) => {
  const large = join(root, "large.sqlite");
  createSearchFixture(large);
  const db = new DatabaseSync(large);
  const value = "\uFEFF\x00\x01\"\\🙂한글\r\n".repeat(10000);
  const fields = RECORD_FIELDS.filter(f => f !== "line_id");
  db.prepare(`UPDATE timeline SET ${fields.map(f => `${f}=?`).join(",")}`).run(...fields.map(() => value));
  db.close();
  const previous = hash(large);
  const result = getRecord(large, { line_id: "sample-020" }, silent);
  checkRecord(result, fullRow(large, "sample-020"));
  assert.ok(fields.every(f => result.field_status[f].truncated));
  assert.ok(result.record.detail.startsWith("\uFEFF\0\x01"));
  const context = getContext(large, { line_id: "sample-020", before: 5, after: 5 }, silent);
  assert.equal(context.ok, true);
  assert.equal(context.returned, 11);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= MAX_OUTPUT_BYTES);
  assert.ok(context.records.every(r => Array.from(r.snippet).length <= 180 && r.field_truncated.subject && r.field_truncated.snippet));
  t.diagnostic(JSON.stringify({ stress_output_bytes: { get_record: Buffer.byteLength(JSON.stringify(result)), get_context: Buffer.byteLength(JSON.stringify(context)) } }));
  assert.equal(hash(large), previous);
});

test("empty fields, BOM and embedded NUL remain complete without replacement", () => {
  const special = join(root, "special.sqlite");
  createSearchFixture(special);
  const db = new DatabaseSync(special);
  db.prepare("UPDATE timeline SET subject=?,detail=?,payload=? WHERE line_id=?").run("\uFEFFa\0b🙂", "", "", "sample-001");
  db.close();
  const result = getRecord(special, { line_id: "sample-001" }, silent);
  checkRecord(result, fullRow(special, "sample-001"));
  assert.equal(result.truncated, false);
  assert.equal(result.record.subject, "\uFEFFa\0b🙂");
  const context = getContext(special, { line_id: "sample-001", before: 0, after: 0 }, silent);
  assert.equal(context.records[0].snippet_field, "subject");
  assert.equal(context.records[0].snippet, "\uFEFFa\0b🙂");
  assert.equal(context.records[0].field_truncated.snippet, false);
});

test("ordering preserves signed 64-bit rowids, not numeric ID suffixes or timestamps", () => {
  const special = join(root, "rowids.sqlite");
  createSearchFixture(special);
  const db = new DatabaseSync(special);
  db.prepare("UPDATE timeline SET rowid=? WHERE line_id=?").run(-9007199254740993n, "sample-020");
  db.prepare("UPDATE timeline SET rowid=? WHERE line_id=?").run(9007199254740993n, "sample-001");
  db.close();
  const result = getContext(special, { line_id: "sample-020", before: 5, after: 3 }, silent);
  assert.deepEqual(result.records.map(r => r.rowid), ["-9007199254740993", "6", "9", "12"]);
  const last = getContext(special, { line_id: "sample-001", before: 1, after: 1 }, silent);
  assert.deepEqual(last.records.map(r => r.rowid), ["120", "9007199254740993"]);
});

test("audit contains only tool, input line_id, returned count and elapsed_ms", () => {
  const logs = [];
  for (const fn of [getRecord, getContext]) {
    for (const id of ["sample-020", "missing\nline"]) fn(path, { line_id: id }, entry => logs.push(entry));
  }
  assert.equal(logs.length, 4);
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry), ["tool", "line_id", "returned", "elapsed_ms"]);
    assert.ok(!JSON.stringify(entry).includes("\n"));
  }
  assert.equal(logs[1].line_id, "missing\nline");
  assert.equal(getRecord(path, { line_id: "sample-020" }, () => { throw new Error("sink failed"); }).ok, true);
});
