import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 10;
export const SNIPPET_CHARS = 300;
export const MAX_RESPONSE_BYTES = 24576;

const COLUMNS = ["line_id", "timestamp", "source", "event_type", "subject", "detail", "payload", "source_file", "raw_ref"];
const ALLOWED_ARGS = new Set(["query", "source", "event_type", "timestamp_from", "timestamp_to", "limit"]);

class SearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validate(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new SearchError("INVALID_ARGUMENT", "Expected an argument object.");
  }
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGS.has(key)) throw new SearchError("INVALID_ARGUMENT", "Unknown search argument.");
  }
  const result = { ...args, query: args.query === undefined ? "" : args.query,
    limit: args.limit === undefined ? DEFAULT_LIMIT : args.limit };
  for (const key of ["query", "source", "event_type", "timestamp_from", "timestamp_to"]) {
    if (result[key] === undefined) continue;
    const value = result[key];
    if (typeof value !== "string" || value.includes("\0") || Array.from(value).length > 256) {
      throw new SearchError("INVALID_ARGUMENT", "Search strings must be at most 256 characters and contain no NUL.");
    }
    if (key !== "query" && !value.length) {
      throw new SearchError("INVALID_ARGUMENT", "Omit unused filters instead of passing an empty string.");
    }
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > MAX_LIMIT) {
    throw new SearchError("INVALID_ARGUMENT", "limit must be an integer from 1 to 10.");
  }
  if (result.timestamp_from !== undefined && result.timestamp_to !== undefined && result.timestamp_from > result.timestamp_to) {
    throw new SearchError("INVALID_ARGUMENT", "timestamp_from must not exceed timestamp_to.");
  }
  return result;
}

/** Zero-based evenly spaced ranks, including both ends when at least two are returned. */
export function coverageRanks(count, limit) {
  const take = Math.min(count, limit);
  if (take === 0) return [];
  if (take === 1) return [Math.floor((count - 1) / 2)];
  return Array.from({ length: take }, (_, i) => Math.floor(i * (count - 1) / (take - 1)));
}

function clip(text, maximum) {
  const chars = Array.from(text);
  return chars.length <= maximum ? text : chars.slice(0, maximum - 1).join("") + "…";
}

function checkSchema(db) {
  const table = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'timeline'").get();
  if (!table || table.type !== "table" || /CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)) {
    throw new SearchError("INVALID_SCHEMA", "Expected a regular timeline table.");
  }
  const info = db.prepare("PRAGMA table_info(timeline)").all();
  if (info.some(c => ["rowid", "_rowid_", "oid"].includes(c.name.toLowerCase())) ||
      !COLUMNS.every(name => info.some(c => c.name === name && c.type.toUpperCase() === "TEXT")) ||
      !info.some(c => c.name === "line_id" && c.pk === 1)) {
    throw new SearchError("INVALID_SCHEMA", "Expected normalized TEXT columns, line_id primary key and SQLite rowid.");
  }
  db.prepare("SELECT rowid FROM timeline LIMIT 0").all();
}

function conditions(args) {
  const clauses = [];
  const values = [];
  for (const name of ["source", "event_type"]) {
    if (args[name] !== undefined) { clauses.push(`${name} = ?`); values.push(args[name]); }
  }
  if (args.timestamp_from !== undefined) { clauses.push("timestamp >= ?"); values.push(args.timestamp_from); }
  if (args.timestamp_to !== undefined) { clauses.push("timestamp <= ?"); values.push(args.timestamp_to); }
  if (args.query !== "") {
    clauses.push("(instr(lower(subject), lower(?)) > 0 OR instr(lower(detail), lower(?)) > 0 OR instr(lower(payload), lower(?)) > 0)");
    values.push(args.query, args.query, args.query);
  }
  return { where: clauses.length ? " WHERE " + clauses.join(" AND ") : "", values };
}

// Only a bounded window, not the complete subject/detail/payload, crosses into JS.
const EXCERPT_SQL = `
  WITH chosen AS (
    SELECT rowid AS record_rowid, line_id, timestamp, source, event_type,
      CASE
        WHEN ? <> '' THEN CASE
          WHEN instr(lower(subject), lower(?)) > 0 THEN 'subject'
          WHEN instr(lower(detail), lower(?)) > 0 THEN 'detail'
          ELSE 'payload' END
        WHEN subject <> '' THEN 'subject'
        WHEN detail <> '' THEN 'detail'
        ELSE 'payload' END AS snippet_field,
      subject, detail, payload
    FROM timeline WHERE rowid = ?
  ), text_value AS (
    SELECT *, CASE snippet_field WHEN 'subject' THEN subject WHEN 'detail' THEN detail ELSE payload END AS value
    FROM chosen
  ), positioned AS (
    SELECT *, max(1, instr(lower(value), lower(?)) - min(80, max(0, 298 - length(?)))) AS start FROM text_value
  )
  SELECT record_rowid,
    substr(line_id, 1, 81) AS line_id, substr(timestamp, 1, 49) AS timestamp,
    substr(source, 1, 65) AS source, substr(event_type, 1, 97) AS event_type,
    snippet_field, substr(value, start, 300) AS excerpt,
    start > 1 AS has_prefix, length(value) >= start + 300 AS has_suffix
  FROM positioned`;

function runSearch(db, args) {
  const { where, values } = conditions(args);
  const total = db.prepare("SELECT count(*) AS n FROM timeline" + where).get(...values).n;
  const ranks = coverageRanks(total, args.limit);
  const selected = [];
  if (ranks.length) {
    const statement = db.prepare("SELECT rowid AS id FROM timeline" + where + " ORDER BY rowid");
    statement.setReadBigInts(true);
    let rank = 0;
    let next = 0;
    for (const row of statement.iterate(...values)) {
      if (rank === ranks[next]) {
        selected.push(row.id);
        if (++next === ranks.length) break;
      }
      rank++;
    }
    if (selected.length !== ranks.length) throw new SearchError("INCONSISTENT_RESULTS", "Match count and sample disagree.");
  }
  const excerpt = db.prepare(EXCERPT_SQL);
  excerpt.setReadBigInts(true);
  const records = selected.map(id => {
    const row = excerpt.get(args.query, args.query, args.query, id, args.query, args.query);
    const record = { rowid: id.toString() };
    const shortened = [];
    for (const [name, maximum] of [["line_id", 80], ["timestamp", 48], ["source", 64], ["event_type", 96]]) {
      record[name] = clip(row[name], maximum);
      if (record[name] !== row[name]) shortened.push(name);
    }
    record.snippet_field = row.snippet_field;
    record.snippet = clip((row.has_prefix ? "…" : "") + row.excerpt + (row.has_suffix ? "…" : ""), SNIPPET_CHARS);
    if (shortened.length) record.truncated_fields = shortened;
    return record;
  });
  return {
    ok: true, total_matches: total, returned: records.length, limit: args.limit,
    truncated: total > records.length,
    sampling: { method: "even_rank_by_rowid", ranks: ranks.map(rank => rank + 1) },
    records,
  };
}

/**
 * Read-only search. dbPath is operator configuration, never a model parameter.
 * No filesystem writes, migrations, FTS creation, or extension loading.
 */
export function searchRecords(dbPath, input = {}) {
  const started = performance.now();
  let db;
  let response;
  try {
    const args = validate(input);
    if (typeof dbPath !== "string" || !isAbsolute(dbPath) || dbPath.includes("\0")) {
      throw new SearchError("DB_NOT_CONFIGURED", "Set an absolute canonical timeline DB path in plugin settings.");
    }
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1000 });
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; BEGIN;");
    checkSchema(db);
    response = runSearch(db, args);
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof SearchError ? error.code : "DB_READ_FAILED",
      message: error instanceof SearchError ? error.message : "Unable to read the configured canonical timeline database.",
    };
  } finally {
    if (db) db.close();
  }
  response.elapsed_ms = 0;
  // JSON escaping can expand control characters. Bound the serialized response too.
  if (response.ok) {
    let budget = SNIPPET_CHARS;
    while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESPONSE_BYTES - 64 && budget > 1) {
      budget = Math.max(1, budget - 25);
      for (const record of response.records) record.snippet = clip(record.snippet, budget);
      response.snippets_shortened_for_budget = true;
    }
  }
  response.elapsed_ms = Math.round((performance.now() - started) * 1000) / 1000;
  return response;
}
