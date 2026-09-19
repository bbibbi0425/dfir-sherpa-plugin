import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

export const RECORD_FIELDS = ["line_id", "timestamp", "source", "event_type", "subject", "detail", "payload", "source_file", "raw_ref"];
export const MAX_OUTPUT_BYTES = 24576;
export const CONTEXT_SNIPPET_CHARS = 180;
// Each budget includes the JSON string's quotes and escaping, not just UTF-8 text.
export const RECORD_FIELD_BUDGETS = {
  line_id: 1538, timestamp: 256, source: 256, event_type: 512, subject: 2048,
  detail: 6144, payload: 6144, source_file: 1024, raw_ref: 1024,
};
export const CONTEXT_FIELD_BUDGETS = {
  line_id: 256, timestamp: 96, source: 96, event_type: 128, subject: 384, snippet: 640,
};

class RecordError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validate(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RecordError("INVALID_ARGUMENT", "Expected an argument object.");
  }
  const allowed = context ? ["line_id", "before", "after"] : ["line_id"];
  if (Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof input.line_id !== "string" || input.line_id.length < 1 ||
      input.line_id.length > 256 || input.line_id.includes("\0")) {
    throw new RecordError("INVALID_ARGUMENT", "Use a nonempty line_id of at most 256 UTF-16 units, without NUL; no extra arguments.");
  }
  const result = { line_id: input.line_id };
  if (context) {
    for (const key of ["before", "after"]) {
      result[key] = input[key] === undefined ? 3 : input[key];
      if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > 5) {
        throw new RecordError("INVALID_ARGUMENT", "before and after must each be integers from 0 to 5.");
      }
    }
  }
  return result;
}

function openDatabase(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new RecordError("DB_NOT_CONFIGURED", "Set an absolute canonical timeline DB path in plugin settings.");
  }
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;");
    const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='timeline'").get();
    const columns = db.prepare("PRAGMA table_info(timeline)").all();
    if (!table || table.type !== "table" || /CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql) ||
        !RECORD_FIELDS.every(name => columns.some(c => c.name === name && c.type.toUpperCase() === "TEXT")) ||
        !columns.some(c => c.name === "line_id" && c.pk === 1) ||
        columns.filter(c => c.pk > 0).length !== 1 ||
        columns.some(c => ["rowid", "_rowid_", "oid"].includes(c.name.toLowerCase()))) {
      throw new RecordError("INVALID_SCHEMA", "Expected canonical timeline TEXT columns, line_id primary key and SQLite rowid.");
    }
    db.prepare("SELECT rowid FROM timeline LIMIT 0").all();
    return db;
  } catch (error) { db.close(); throw error; }
}

function projection(budgets) {
  return Object.entries(budgets).flatMap(([field, budget]) => [
    `coalesce(substr(CAST(${field} AS BLOB),1,${budget}),X'') AS ${field}_prefix`,
    `length(CAST(${field} AS BLOB)) AS ${field}_bytes`,
    `typeof(${field}) AS ${field}_type`,
  ]).join(",");
}

function statement(db, sql) {
  const result = db.prepare(sql);
  result.setReadBigInts(true);
  return result;
}

// BLOB substr preserves embedded NUL and bounds transfer even for enormous fields.
// Trimming up to three trailing bytes avoids splitting a valid UTF-8 character.
function utf8Prefix(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim++) {
    try { return decoder.decode(bytes.subarray(0, bytes.length - trim)); }
    catch { /* A boundary may bisect one code point; never insert replacement text. */ }
  }
  throw new RecordError("INVALID_TEXT", "A record field is not valid UTF-8 text.");
}

function boundedField(row, field, budget, maxChars = Infinity) {
  if (row[field + "_type"] !== "text") {
    throw new RecordError("INVALID_TEXT", "Expected TEXT values in normalized record fields.");
  }
  const originalBytes = Number(row[field + "_bytes"]);
  const bytes = row[field + "_prefix"];
  let text;
  // A complete field must decode without discarding any byte.
  if (bytes.length === originalBytes) {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } else text = utf8Prefix(bytes);
  const chars = Array.from(text);
  let lo = 0;
  let hi = Math.min(chars.length, maxChars);
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify(chars.slice(0, middle).join("")), "utf8") <= budget) lo = middle;
    else hi = middle - 1;
  }
  const value = chars.slice(0, lo).join("");
  const returnedBytes = Buffer.byteLength(value, "utf8");
  return { value, status: { truncated: returnedBytes < originalBytes, original_bytes: originalBytes, returned_bytes: returnedBytes } };
}

function lookupRecord(db, args) {
  const row = statement(db, `SELECT rowid AS record_rowid, ${projection(RECORD_FIELD_BUDGETS)}
    FROM timeline WHERE line_id = ? COLLATE BINARY LIMIT 1`).get(args.line_id);
  if (!row) throw new RecordError("NOT_FOUND", "No record has this exact line_id.");
  const record = {};
  const fieldStatus = {};
  for (const [field, budget] of Object.entries(RECORD_FIELD_BUDGETS)) {
    const part = boundedField(row, field, budget);
    record[field] = part.value;
    fieldStatus[field] = part.status;
  }
  return { ok: true, found: true, returned: 1, rowid: row.record_rowid.toString(), record,
    truncated: Object.values(fieldStatus).some(status => status.truncated), field_status: fieldStatus };
}

const CONTEXT_PROJECTION = `WITH excerpts AS (
  SELECT rowid AS record_rowid, line_id, timestamp, source, event_type, subject,
    CASE WHEN length(CAST(detail AS BLOB))>0 THEN 'detail'
         WHEN length(CAST(payload AS BLOB))>0 THEN 'payload' ELSE 'subject' END AS snippet_field,
    CASE WHEN length(CAST(detail AS BLOB))>0 THEN detail
         WHEN length(CAST(payload AS BLOB))>0 THEN payload ELSE subject END AS snippet
  FROM timeline WHERE rowid IN (SELECT rowid FROM timeline WHERE ROW_CONDITION ORDER BY rowid ROW_ORDER LIMIT ?)
) SELECT record_rowid, snippet_field, ${projection(CONTEXT_FIELD_BUDGETS)} FROM excerpts ORDER BY record_rowid ROW_ORDER`;

function contextRows(db, condition, order, id, count) {
  return statement(db, CONTEXT_PROJECTION.replace("ROW_CONDITION", condition).replaceAll("ROW_ORDER", order)).all(id, count);
}

function lookupContext(db, args) {
  const anchor = statement(db, "SELECT rowid AS id FROM timeline WHERE line_id = ? COLLATE BINARY LIMIT 1").get(args.line_id);
  if (!anchor) throw new RecordError("NOT_FOUND", "No record has this exact line_id.");
  const before = contextRows(db, "rowid < ?", "DESC", anchor.id, args.before).reverse();
  const center = contextRows(db, "rowid = ?", "ASC", anchor.id, 1);
  const after = contextRows(db, "rowid > ?", "ASC", anchor.id, args.after);
  if (center.length !== 1) throw new RecordError("DB_READ_FAILED", "Target record unavailable in read snapshot.");
  const records = [...before, ...center, ...after].map(row => {
    const record = { rowid: row.record_rowid.toString(), is_target: row.record_rowid === anchor.id };
    const truncated = {};
    for (const [field, budget] of Object.entries(CONTEXT_FIELD_BUDGETS)) {
      const part = boundedField(row, field, budget, field === "snippet" ? CONTEXT_SNIPPET_CHARS : Infinity);
      record[field] = part.value;
      truncated[field] = part.status.truncated;
    }
    record.snippet_field = row.snippet_field;
    record.field_truncated = truncated;
    return record;
  });
  return { ok: true, found: true, returned: records.length,
    before_requested: args.before, after_requested: args.after,
    before_returned: before.length, after_returned: after.length, target_index: before.length,
    ordering: "rowid_ascending", records };
}

const defaultAudit = entry => console.error(JSON.stringify(entry));

function execute(tool, path, input, context, logger) {
  const started = performance.now();
  let db;
  let response;
  try {
    const args = validate(input, context);
    db = openDatabase(path);
    response = context ? lookupContext(db, args) : lookupRecord(db, args);
  } catch (error) {
    response = { ok: false, returned: 0, error: error instanceof RecordError ? error.code : "DB_READ_FAILED",
      message: error instanceof RecordError ? error.message : "Unable to read the configured canonical timeline database." };
    if (response.error === "NOT_FOUND") response.found = false;
  } finally { if (db) db.close(); }
  response.elapsed_ms = Math.round((performance.now() - started) * 1000) / 1000;
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_OUTPUT_BYTES) {
    response = { ok: false, returned: 0, error: "OUTPUT_LIMIT", message: "Record exceeds the safe output envelope.", elapsed_ms: response.elapsed_ms };
  }
  // No evidence fields, snippets, paths, SQL or error stack in audit output.
  const lineId = typeof input?.line_id === "string" && input.line_id.length <= 256 ? input.line_id : null;
  try { logger({ tool, line_id: lineId, returned: response.returned, elapsed_ms: response.elapsed_ms }); }
  catch { /* A failed log sink must not change a successful read result. */ }
  return response;
}

export function getRecord(path, input, logger = defaultAudit) {
  return execute("get_record", path, input, false, logger);
}

export function getContext(path, input, logger = defaultAudit) {
  return execute("get_context", path, input, true, logger);
}
