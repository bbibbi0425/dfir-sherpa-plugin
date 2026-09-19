import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { getRecord, getContext, RECORD_FIELDS, MAX_OUTPUT_BYTES } from "../src/recordTools.mjs";
import { createSearchFixture } from "../tests/searchFixture.mjs";

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
const sidecars = path => ["-journal", "-wal", "-shm"].filter(suffix => existsSync(path + suffix));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

function parse() {
  const args = { fixture: false };
  const input = process.argv.slice(2);
  while (input.length) {
    const flag = input.shift();
    if (flag === "--fixture") args.fixture = true;
    else if (["--db", "--report"].includes(flag) && input.length) args[flag.slice(2)] = input.shift();
    else throw new Error("Usage: node scripts/verify_record_tools.mjs (--fixture | --db PATH) [--report NEW_PATH]");
  }
  if (Boolean(args.db) === args.fixture) throw new Error("Choose exactly one of --fixture or --db.");
  if (args.report && existsSync(args.report)) throw new Error("Refusing to overwrite an existing report.");
  return args;
}

function original(db, id) {
  const row = db.prepare(`SELECT ${RECORD_FIELDS.map(f => `CAST(${f} AS BLOB) AS ${f}`).join(",")} FROM timeline WHERE line_id=? COLLATE BINARY`).get(id);
  return Object.fromEntries(RECORD_FIELDS.map(f => [f, Buffer.from(row[f] ?? []).toString("utf8")]));
}

function checkField(value, status, expected) {
  assert.ok(expected.startsWith(value));
  assert.equal(status.truncated, value !== expected);
  assert.equal(status.original_bytes, Buffer.byteLength(expected));
  assert.equal(status.returned_bytes, Buffer.byteLength(value));
}

async function main() {
  const args = parse();
  let root;
  let db;
  try {
    if (args.fixture) {
      root = mkdtempSync(join(tmpdir(), "sherpa-record-verification-"));
      args.db = join(root, "fixture.sqlite"); createSearchFixture(args.db);
    }
    const path = resolve(args.db);
    const beforeHash = await hashFile(path);
    const beforeStat = statSync(path);
    const beforeSidecars = sidecars(path);
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; BEGIN;");
    const count = db.prepare("SELECT count(*) AS n FROM timeline").get().n;
    assert.ok(count > 0, "Functional verification requires a nonempty fixture or database.");
    // Structural selection only; no ground truth, analytical keyword or fixed Line ID.
    const samples = [0, Math.floor((count - 1) / 2), count - 1].map(offset =>
      db.prepare("SELECT line_id FROM timeline ORDER BY rowid LIMIT 1 OFFSET ?").get(offset).line_id);
    const largest = db.prepare(`SELECT line_id FROM timeline ORDER BY ${RECORD_FIELDS.map(f => `length(CAST(${f} AS BLOB))`).join("+")} DESC, rowid LIMIT 1`).get().line_id;
    let absent = "sherpa-verification-missing";
    while (db.prepare("SELECT 1 FROM timeline WHERE line_id=?").get(absent)) absent += "_";
    const cases = [
      ...samples.map((id, i) => ({ tool: "get_record", label: ["first", "middle", "last"][i], input: { line_id: id } })),
      { tool: "get_record", label: "largest_record_bytes", input: { line_id: largest } },
      { tool: "get_record", label: "not_found", input: { line_id: absent }, error: "NOT_FOUND" },
      ...samples.map((id, i) => ({ tool: "get_context", label: ["first", "middle", "last"][i], input: { line_id: id } })),
      { tool: "get_context", label: "largest_record_neighborhood", input: { line_id: largest, before: 5, after: 5 } },
      { tool: "get_context", label: "maximum_context", input: { line_id: samples[1], before: 5, after: 5 } },
      { tool: "get_context", label: "anchor_only", input: { line_id: samples[1], before: 0, after: 0 } },
      { tool: "get_context", label: "not_found", input: { line_id: absent }, error: "NOT_FOUND" },
      { tool: "get_context", label: "invalid_before", input: { line_id: samples[1], before: 6 }, error: "INVALID_ARGUMENT" },
      { tool: "get_context", label: "invalid_after", input: { line_id: samples[1], after: 6 }, error: "INVALID_ARGUMENT" },
    ];
    let auditCount = 0;
    const results = [];
    for (const item of cases) {
      const fn = item.tool === "get_record" ? getRecord : getContext;
      const times = [];
      let maximumBytes = 0;
      let prior;
      for (let run = 0; run < 6; run++) {
        const result = fn(path, item.input, entry => {
          assert.deepEqual(Object.keys(entry), ["tool", "line_id", "returned", "elapsed_ms"]);
          assert.equal(entry.tool, item.tool); assert.equal(entry.line_id, item.input.line_id);
          auditCount++;
        });
        times.push(result.elapsed_ms);
        maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(result)));
        assert.ok(maximumBytes <= MAX_OUTPUT_BYTES);
        if (item.error) {
          assert.equal(result.ok, false); assert.equal(result.error, item.error); assert.equal(result.returned, 0);
          if (item.error === "NOT_FOUND") assert.equal(result.found, false);
        } else if (item.tool === "get_record") {
          assert.equal(result.ok, true); assert.equal(result.returned, 1);
          const expected = original(db, item.input.line_id);
          assert.deepEqual(Object.keys(result.record), RECORD_FIELDS);
          for (const f of RECORD_FIELDS) checkField(result.record[f], result.field_status[f], expected[f]);
        } else {
          assert.equal(result.ok, true);
          const position = db.prepare("SELECT count(*) AS n FROM timeline WHERE rowid < (SELECT rowid FROM timeline WHERE line_id=?)").get(item.input.line_id).n;
          const nBefore = Math.min(position, item.input.before ?? 3);
          const nAfter = Math.min(count - position - 1, item.input.after ?? 3);
          // Independent ordinal/offset oracle, not rowid subtraction.
          const expected = db.prepare("SELECT line_id FROM timeline ORDER BY rowid LIMIT ? OFFSET ?").all(nBefore + 1 + nAfter, position - nBefore);
          assert.equal(result.returned, expected.length); assert.equal(result.target_index, nBefore);
          assert.equal(result.before_returned, nBefore); assert.equal(result.after_returned, nAfter);
          assert.equal(result.records.filter(r => r.is_target).length, 1);
          for (let i = 0; i < result.records.length; i++) {
            const row = result.records[i];
            const raw = original(db, expected[i].line_id);
            if (i > 0) assert.ok(BigInt(result.records[i - 1].rowid) < BigInt(row.rowid));
            assert.ok(!("detail" in row) && !("payload" in row));
            for (const f of ["line_id", "timestamp", "source", "event_type", "subject"]) {
              assert.ok(raw[f].startsWith(row[f])); assert.equal(row.field_truncated[f], raw[f] !== row[f]);
            }
            assert.ok(raw[row.snippet_field].startsWith(row.snippet));
            assert.equal(row.field_truncated.snippet, raw[row.snippet_field] !== row.snippet);
            assert.ok(Array.from(row.snippet).length <= 180);
          }
        }
        const comparable = { ...result, elapsed_ms: 0 };
        if (prior) assert.deepEqual(comparable, prior);
        prior = comparable;
      }
      results.push({ tool: item.tool, case: item.label, passed: true, returned: prior.returned,
        first_ms: times[0], repeated_ms: times.slice(1), p50_ms: percentile(times.slice(1), 0.5),
        p95_ms: percentile(times.slice(1), 0.95), max_output_bytes: maximumBytes });
    }
    db.close(); db = undefined;
    const afterHash = await hashFile(path);
    const afterStat = statSync(path);
    assert.equal(beforeHash, afterHash); assert.equal(beforeStat.size, afterStat.size);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs); assert.deepEqual(sidecars(path), beforeSidecars);
    assert.equal(auditCount, cases.length * 6);
    const report = {
      status: "passed", created_at_utc: new Date().toISOString(), node_version: process.version,
      database: args.fixture ? "synthetic fixture" : path, rows: count, database_size_bytes: beforeStat.size,
      sha256_before: beforeHash, sha256_after: afterHash, database_unchanged: true,
      no_new_sqlite_sidecars: true, audit_entries: auditCount, audit_contract: "passed",
      output_limit_bytes: MAX_OUTPUT_BYTES, repeats_after_first: 5,
      timing_note: "Direct Tool implementation times; warm cache, source checks outside timers; no model inference. With five repetitions p95 is the maximum.",
      cases: results,
    };
    if (args.report) writeFileSync(resolve(args.report), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (db) db.close();
    if (root) rmSync(root, { recursive: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
