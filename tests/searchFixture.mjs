import { DatabaseSync } from "node:sqlite";

/** Synthetic timeline schema; call only from tests/benchmarks on a NEW file. */
export function createSearchFixture(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE timeline (
      line_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, source TEXT NOT NULL,
      event_type TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL,
      payload TEXT NOT NULL, source_file TEXT NOT NULL, raw_ref TEXT NOT NULL);
      CREATE INDEX idx_timeline_timestamp ON timeline(timestamp);
      CREATE INDEX idx_timeline_source ON timeline(source);
      CREATE INDEX idx_timeline_event_type ON timeline(event_type); BEGIN;`);
    const insert = db.prepare("INSERT INTO timeline(rowid,line_id,timestamp,source,event_type,subject,detail,payload,source_file,raw_ref) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (let i = 1; i <= 40; i++) {
      insert.run(i * 3, `sample-${String(i).padStart(3, "0")}`, `2025-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        i % 2 ? "alpha" : "beta", i % 3 ? "observation" : "note", `shared quartz ${i}`,
        "context ".repeat(100) + `narrow-${i} 한글🙂 "quote" 100%_literal\\value`,
        JSON.stringify({ generic: "shared", text: "z".repeat(1000) }), "synthetic.csv", `ref-${i}`);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}
