import { basename } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openTimelineDatabase, TimelineSchemaError, TIMELINE_FIELDS } from "./timelineSchema.mjs";

export const OVERVIEW_MAX_BYTES = 2048;
const SUPPORTED_TOOLS = {
  dataset_overview: "Read dataset metadata only.",
  search_records: "Count matches and return bounded coverage samples.",
  get_record: "Read one exact line_id with explicit field truncation.",
  get_context: "Read compact neighbors in stored rowid order.",
};

class OverviewError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function datasetOverview(path, input = {}, logger = entry => console.error(JSON.stringify(entry))) {
  const started = performance.now();
  let db;
  let result;
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
      throw new OverviewError("INVALID_ARGUMENT", "dataset_overview accepts no arguments.");
    }
    db = openTimelineDatabase(path);
    // Separate indexed extrema; never select record bodies or example rows.
    const bounds = db.prepare(`SELECT
      (SELECT min(timestamp) FROM timeline WHERE timestamp <> '') AS first_timestamp,
      (SELECT max(timestamp) FROM timeline WHERE timestamp <> '') AS last_timestamp`).get();
    // Fail explicitly on abnormal metadata instead of presenting a partial timestamp.
    for (const value of Object.values(bounds)) {
      if (value !== null && (typeof value !== "string" || Buffer.byteLength(JSON.stringify(value)) > 256)) {
        throw new OverviewError("INVALID_METADATA", "Timestamp metadata exceeds the bounded overview format.");
      }
    }
    const filename = basename(path);
    const identifier = Buffer.byteLength(JSON.stringify(filename)) <= 256 ? filename
      : `dataset-${createHash("sha256").update(filename).digest("hex").slice(0, 16)}`;
    result = {
      ok: true, dataset: identifier,
      total_records: db.prepare("SELECT count(*) AS n FROM timeline").get().n,
      available_fields: [...TIMELINE_FIELDS],
      ...bounds, timestamp_order: "text_min_max_nonempty",
      distinct_source_count: db.prepare("SELECT count(DISTINCT source) AS n FROM timeline").get().n,
      supported_tools: { ...SUPPORTED_TOOLS },
    };
  } catch (error) {
    const known = error instanceof OverviewError || error instanceof TimelineSchemaError;
    result = { ok: false, error: known ? error.code : "DB_READ_FAILED",
      message: known ? error.message : "Unable to read the configured canonical timeline database." };
  } finally { if (db) db.close(); }
  result.elapsed_ms = Math.round((performance.now() - started) * 1000) / 1000;
  if (Buffer.byteLength(JSON.stringify(result)) > OVERVIEW_MAX_BYTES) {
    result = { ok: false, error: "OUTPUT_LIMIT", message: "Overview exceeds the output limit.", elapsed_ms: result.elapsed_ms };
  }
  try { logger({ tool: "dataset_overview", line_id: null, returned: 0, elapsed_ms: result.elapsed_ms }); }
  catch { /* Logging does not change retrieval results. */ }
  return result;
}
