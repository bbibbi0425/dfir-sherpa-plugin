import {DatabaseSync} from "node:sqlite";
import {isAbsolute} from "node:path";

export const TIMELINE_FIELDS = ["line_id", "timestamp", "source", "event_type", "subject", "detail", "payload", "source_file", "raw_ref"];

export class TimelineSchemaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function checkSchema(db) {
  const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='timeline'").get();
  const columns = db.prepare("PRAGMA table_info(timeline)").all();
  if (!table || table.type !== "table" || /CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql) ||
      !TIMELINE_FIELDS.every(name => columns.some(c => c.name === name && c.type.toUpperCase() === "TEXT")) ||
      !columns.some(c => c.name === "line_id" && c.pk === 1) ||
      columns.filter(c => c.pk > 0).length !== 1 ||
      columns.some(c => ["rowid", "_rowid_", "oid"].includes(c.name.toLowerCase()))) {
    throw new TimelineSchemaError("INVALID_SCHEMA", "Expected canonical timeline TEXT columns, a single-column line_id primary key and SQLite rowid.");
  }
  db.prepare("SELECT rowid FROM timeline LIMIT 0").all();
}

/** Return a validated read-only snapshot. The caller owns and must close it. */
export function openTimelineDatabase(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new TimelineSchemaError("DB_NOT_CONFIGURED", "Set an absolute canonical timeline DB path in plugin settings.");
  }
  const db = new DatabaseSync(path, {readOnly:true, allowExtension:false, timeout:1000});
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;");
    checkSchema(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
