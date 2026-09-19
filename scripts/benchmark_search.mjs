import { DatabaseSync } from "node:sqlite";
import { createReadStream, mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import assert from "node:assert/strict";
import { searchRecords, coverageRanks, MAX_RESPONSE_BYTES } from "../src/searchRecords.mjs";
import { createSearchFixture } from "../tests/searchFixture.mjs";

const INTERACTIVE_P95_MS = 2000;
const hashText = text => createHash("sha256").update(text).digest("hex");
async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const block of createReadStream(path)) digest.update(block);
  return digest.digest("hex");
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const sidecars = path => ["-journal", "-wal", "-shm"].filter(suffix => existsSync(path + suffix));

function parseArgs() {
  const args = { runs: 5, fixture: false };
  const values = process.argv.slice(2);
  while (values.length) {
    const flag = values.shift();
    if (flag === "--fixture") { args.fixture = true; continue; }
    if (!["--db", "--report", "--runs"].includes(flag) || !values.length) {
      throw new Error("Usage: node scripts/benchmark_search.mjs (--fixture | --db PATH) [--runs 5] [--report NEW_PATH]");
    }
    args[flag.slice(2)] = values.shift();
  }
  args.runs = Number(args.runs);
  if (Boolean(args.db) === args.fixture || !Number.isInteger(args.runs) || args.runs < 2 || args.runs > 20) {
    throw new Error("Choose exactly one of --fixture or --db; --runs must be 2..20.");
  }
  if (args.report && existsSync(args.report)) throw new Error("Report already exists; choose a new path.");
  return args;
}

function genericCases(db, count) {
  // Fixed row quantiles and lexical token selection: no dataset-specific terms or IDs.
  const samples = coverageRanks(count, 9).map(rank => db.prepare(
    "SELECT timestamp, substr(subject,1,256) AS subject, substr(detail,1,256) AS detail, substr(payload,1,256) AS payload FROM timeline ORDER BY rowid LIMIT 1 OFFSET ?"
  ).get(rank));
  const source = db.prepare("SELECT source FROM timeline GROUP BY source ORDER BY count(*) DESC, source LIMIT 1").get()?.source;
  const eventType = db.prepare("SELECT event_type FROM timeline GROUP BY event_type ORDER BY count(*) DESC, event_type LIMIT 1").get()?.event_type;
  const cases = [{ label: "all_rows", args: {} }];
  if (source) cases.push({ label: "source_filter", args: { source } });
  if (eventType) cases.push({ label: "event_type_filter", args: { event_type: eventType } });
  const timestamp = samples[Math.floor(samples.length / 2)]?.timestamp;
  if (timestamp) cases.push({ label: "timestamp_point", args: { timestamp_from: timestamp, timestamp_to: timestamp } });
  for (const field of ["subject", "detail", "payload"]) {
    const tokens = [...new Set(samples.flatMap(row => row[field].match(/[\p{L}\p{N}_]{4,24}/gu) ?? []))].sort();
    if (tokens.length) cases.push({ label: `text_${field}_token`, args: { query: tokens[Math.floor(tokens.length / 2)] } });
  }
  cases.push({ label: "text_common_character", args: { query: "a", limit: 10 } });
  const fragment = samples.find(row => row.subject.length >= 24)?.subject.slice(0, 64);
  if (fragment) cases.push({ label: "text_literal_fragment", args: { query: fragment } });
  const query = cases.find(item => item.label === "text_subject_token")?.args.query;
  if (query && source) cases.push({ label: "text_with_source", args: { query, source } });
  cases.push({ label: "text_absent_probe", args: { query: "sherpa_benchmark_absent_6b8f764ecf15412aa959" } });
  return cases;
}

function oracle(db, args) {
  // Independent LIKE-based predicate (literal escaping) checks count AND coverage IDs.
  const where = [];
  const values = [];
  for (const key of ["source", "event_type"]) {
    if (args[key] !== undefined) { where.push(`${key}=?`); values.push(args[key]); }
  }
  if (args.timestamp_from) { where.push("timestamp>=?"); values.push(args.timestamp_from); }
  if (args.timestamp_to) { where.push("timestamp<=?"); values.push(args.timestamp_to); }
  if (args.query) {
    where.push("(subject LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\')");
    const literal = "%" + args.query.replace(/[\\%_]/g, "\\$&") + "%";
    values.push(literal, literal, literal);
  }
  const statement = db.prepare("SELECT rowid AS id FROM timeline" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY rowid");
  statement.setReadBigInts(true);
  const ids = [];
  for (const row of statement.iterate(...values)) ids.push(row.id.toString());
  return { count: ids.length, ids: coverageRanks(ids.length, args.limit ?? 8).map(rank => ids[rank]) };
}

async function main() {
  const args = parseArgs();
  let fixtureDirectory;
  let db;
  try {
    if (args.fixture) {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "sherpa-search-benchmark-"));
      args.db = join(fixtureDirectory, "fixture.sqlite");
      createSearchFixture(args.db);
    }
    const path = resolve(args.db);
    const initialStat = statSync(path);
    const initialHash = await hashFile(path);
    const initialSidecars = sidecars(path);
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; BEGIN;");
    const count = db.prepare("SELECT count(*) AS n FROM timeline").get().n;
    const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
    const cases = genericCases(db, count);
    const measured = [];
    for (const { label, args: input } of cases) {
      const expected = oracle(db, input);
      const times = [];
      let bytes = 0;
      let maxSnippet = 0;
      let prior;
      for (let run = 0; run <= args.runs; run++) {
        const result = searchRecords(path, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.total_matches, expected.count);
        assert.deepEqual(result.records.map(row => row.rowid), expected.ids);
        assert.ok(result.returned <= 10);
        if (prior) assert.deepEqual(result.records, prior.records);
        const size = Buffer.byteLength(JSON.stringify(result));
        assert.ok(size <= MAX_RESPONSE_BYTES);
        bytes = Math.max(bytes, size);
        for (const row of result.records) {
          assert.equal("detail" in row || "payload" in row, false);
          maxSnippet = Math.max(maxSnippet, Array.from(row.snippet).length);
        }
        assert.ok(maxSnippet <= 300);
        times.push(result.elapsed_ms);
        prior = result;
      }
      if (label === "text_absent_probe") assert.equal(expected.count, 0, "Absent probe unexpectedly matched");
      const result = {
        case: label, input_sha256: hashText(JSON.stringify(input)),
        query_characters: Array.from(input.query ?? "").length,
        filters: Object.keys(input).filter(key => key !== "query" && key !== "limit"),
        total_matches: expected.count, returned: prior.returned,
        first_measured_ms: times[0], repeated_ms: times.slice(1),
        p50_ms: percentile(times.slice(1), 0.5), p95_ms: percentile(times.slice(1), 0.95),
        max_response_bytes: bytes, max_snippet_characters: maxSnippet,
        correctness_and_determinism: "passed",
      };
      measured.push(result);
      console.error(`${label}: count=${expected.count}, p95=${result.p95_ms}ms, returned=${prior.returned}`);
    }
    db.close(); db = undefined;
    const finalHash = await hashFile(path);
    const finalStat = statSync(path);
    assert.equal(finalHash, initialHash, "Canonical DB bytes changed");
    assert.equal(finalStat.mtimeMs, initialStat.mtimeMs, "Canonical DB modified time changed");
    assert.deepEqual(sidecars(path), initialSidecars, "New SQLite sidecar file detected");
    const textCases = measured.filter(result => result.case.startsWith("text_"));
    const acceptable = textCases.every(result => result.p95_ms <= INTERACTIVE_P95_MS);
    const report = {
      status: "passed", benchmark_version: 1, created_at_utc: new Date().toISOString(),
      database: args.fixture ? "synthetic fixture" : path, database_size_bytes: initialStat.size,
      database_sha256: initialHash, data_rows: count, node_version: process.version,
      sqlite_version: sqliteVersion, cpu: cpus()[0]?.model, logical_cpus: cpus().length,
      ram_bytes: totalmem(), repeats_after_first: args.runs,
      cache_note: "Hashes, case selection and an independent oracle precede timings. These are warm-cache measurements, not cold-disk latency. Each search opens/closes its own read-only connection.",
      sampling: "evenly spaced ranks in the full matching rowid order",
      text_search: "literal substring, ASCII case-insensitive; no FTS",
      criterion_p95_ms: INTERACTIVE_P95_MS,
      text_search_meets_interactive_criterion: acceptable,
      database_unchanged: true, no_new_sqlite_sidecars: true, cases: measured,
    };
    if (args.report) writeFileSync(resolve(args.report), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (db) db.close();
    // Only the synthetic directory owned by this invocation is removed.
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
