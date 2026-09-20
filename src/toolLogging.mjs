import { constants, mkdirSync, lstatSync, openSync, closeSync, fstatSync, statSync, readSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const TOOLS = new Set(["dataset_overview", "search_records", "get_record", "get_context"]);
const DEFAULT_RESULTS = 8; // Logging fallback only; retrieval owns its actual limits.
const text = value => typeof value === "string" && value.length <= 1024 ? value : null;
const integer = value => Number.isInteger(value) ? value : null;

class LogError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function logEntry(tool, input, result, runId) {
  const entry = {
    run_id: runId, timestamp: new Date().toISOString(), tool,
    elapsed_ms: result.elapsed_ms, returned: result.returned ?? 0,
    output_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"), success: result.ok === true,
  };
  if (result.error) entry.error = result.error;
  if (tool === "search_records") Object.assign(entry, {
    query: text(input?.query ?? ""), total_matches: result.total_matches ?? null,
    truncated: result.truncated ?? null, max_results: integer(result.limit ?? input?.limit ?? DEFAULT_RESULTS),
    returned_line_ids: (result.records ?? []).map(row => row.line_id),
    // Exact metadata filters are needed to reproduce a filtered search.
    filters: Object.fromEntries(["source", "event_type", "timestamp_from", "timestamp_to"]
      .filter(key => input?.[key] !== undefined).map(key => [key, text(input[key])])),
  });
  if (tool === "get_record") Object.assign(entry, {
    requested_line_id: text(input?.line_id), found: result.found ?? null,
    truncated: result.truncated ?? null,
  });
  if (tool === "get_context") Object.assign(entry, {
    requested_line_id: text(input?.line_id), before: integer(result.before_requested ?? input?.before ?? 3),
    after: integer(result.after_requested ?? input?.after ?? 3),
    returned_line_ids: (result.records ?? []).map(row => row.line_id),
  });
  if (tool === "dataset_overview") entry.total_records = result.total_records ?? null;
  return entry;
}

function checkExistingLog(fd, runId) {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) throw new LogError("UNSAFE_LOG_TARGET", "Log target must be a regular file without hard links.");
  if (info.size === 0) return;
  const head = Buffer.alloc(Math.min(info.size, 65536));
  readSync(fd, head, 0, head.length, 0);
  const end = head.indexOf(10);
  const tail = Buffer.alloc(1); readSync(fd, tail, 0, 1, info.size - 1);
  let first;
  try { first = JSON.parse(head.subarray(0, end).toString("utf8")); } catch { /* Rejected below. */ }
  if (end < 0 || tail[0] !== 10 || first?.run_id !== runId || !TOOLS.has(first?.tool) ||
      typeof first?.success !== "boolean" || !Number.isFinite(first?.output_bytes) ||
      !Number.isFinite(first?.elapsed_ms) || !Number.isInteger(first?.returned)) {
    throw new LogError("INVALID_LOG_FILE", "Existing file is not a complete JSONL log for this run; choose a new run ID.");
  }
}

/** Append metadata after retrieval; never mutate the result or fail the Tool. */
export function writeToolLog(tool, input, result, getConfig, warn = () => {}) {
  let fd;
  let runId;
  let failure;
  try {
    const config = getConfig();
    runId = config.runId || process.env.SHERPA_RUN_ID || "";
    const logDir = config.logDir || process.env.SHERPA_LOG_DIR || "";
    if (!runId && !logDir) return; // Explicitly unconfigured: no logging side effects.
    if (!TOOLS.has(tool) || typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId) ||
        typeof logDir !== "string" || !isAbsolute(logDir) || logDir.includes("\0")) {
      throw new LogError("INVALID_LOG_CONFIG", "Set SHERPA_RUN_ID (1..80 letters/digits/_/-) and an absolute SHERPA_LOG_DIR.");
    }
    const target = join(logDir, `${runId}_tools.jsonl`);
    const entry = logEntry(tool, input, result, runId);
    const line = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    if (line.length > 65536) throw new LogError("LOG_ENTRY_TOO_LARGE", "Log metadata exceeds its safe envelope.");
    mkdirSync(logDir, { recursive: true });
    try {
      const existing = lstatSync(target);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw new LogError("UNSAFE_LOG_TARGET", "Refusing a linked or non-regular log target.");
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    // O_APPEND only: no truncate, rewrite, rotation, repair or deletion.
    fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    if (config.databasePath) {
      let dbInfo;
      try { dbInfo = statSync(config.databasePath); } catch { /* Retrieval may already have reported missing DB. */ }
      const logInfo = fstatSync(fd);
      if (dbInfo && dbInfo.dev === logInfo.dev && dbInfo.ino === logInfo.ino) {
        throw new LogError("UNSAFE_LOG_TARGET", "Refusing to write to the configured forensic database.");
      }
    }
    checkExistingLog(fd, runId);
    if (writeSync(fd, line) !== line.length) throw new LogError("LOG_WRITE_FAILED", "Incomplete log append; retrieval result is unchanged.");
  } catch (error) {
    failure = { event: "sherpa_log_error", tool, run_id: text(runId),
      code: error instanceof LogError ? error.code : "LOG_IO_FAILED",
      message: error instanceof LogError ? error.message : "Could not append Tool log. Check logging configuration and directory permissions; retrieval result is unchanged." };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {
      failure ??= { event: "sherpa_log_error", tool, run_id: text(runId), code: "LOG_CLOSE_FAILED", message: "Log close failed; retrieval result is unchanged." };
    }
  }
  if (failure) {
    try { console.error(JSON.stringify(failure)); } catch { /* Logging must never fail retrieval. */ }
    try { warn(`[${failure.code}] ${failure.message}`); } catch { /* Same for UI warning delivery. */ }
  }
}
