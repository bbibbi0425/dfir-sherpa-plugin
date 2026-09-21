import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {searchRecords} from "../src/searchRecords.mjs";
import {getRecord, getContext} from "../src/recordTools.mjs";
import {datasetOverview} from "../src/datasetOverview.mjs";
import {openTimelineDatabase} from "../src/timelineSchema.mjs";

const fields=["line_id","timestamp","source","event_type","subject","detail","payload","source_file","raw_ref"];
const hash=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(primaryKey, run) {
  const dir=mkdtempSync(join(tmpdir(),"sherpa-schema-")),path=join(dir,"fixture.sqlite");
  try {
    const db=new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE timeline (${fields.map(name=>`${name} TEXT NOT NULL`).join(",")}, PRIMARY KEY(${primaryKey}))`);
      const insert=db.prepare("INSERT INTO timeline VALUES (?,?,?,?,?,?,?,?,?)");
      insert.run("fixture-id","2025-01-01","fixture","test","generic","detail","{}","fixture.csv","ref");
      if(primaryKey.includes(",")) insert.run("fixture-id","2025-01-02","fixture","test","generic","detail","{}","fixture.csv","ref");
    } finally {db.close();}
    const before=hash(path),files=readdirSync(dir);
    run(path);
    assert.equal(hash(path),before,"read-only calls must preserve fixture bytes");
    assert.deepEqual(readdirSync(dir),files,"no DB sidecar files may be created");
  } finally {rmSync(dir,{recursive:true});}
}
function responses(path) {
  return {
    search_records:searchRecords(path,{}),
    dataset_overview:datasetOverview(path,{},()=>{}),
    get_record:getRecord(path,{line_id:"fixture-id"},()=>{}),
    get_context:getContext(path,{line_id:"fixture-id"},()=>{}),
  };
}
for(const primaryKey of ["line_id, timestamp","timestamp, line_id"]) {
  test(`all four Tools reject composite PRIMARY KEY(${primaryKey}) consistently`,()=>fixture(primaryKey,path=>{
    for(const [tool,result] of Object.entries(responses(path))) {
      assert.equal(result.ok,false,tool);
      assert.equal(result.error,"INVALID_SCHEMA",tool);
    }
  }));
}
test("all four Tools accept the documented single-column line_id primary key",()=>fixture("line_id",path=>{
  const results=responses(path);
  for(const [tool,result] of Object.entries(results)) assert.equal(result.ok,true,tool);
  assert.equal(results.search_records.total_matches,1);
  assert.equal(results.dataset_overview.total_records,1);
  assert.equal(results.get_record.returned,1);
  assert.equal(results.get_context.returned,1);
}));

test("shared connection starts a transaction with read-only safeguards",()=>fixture("line_id",path=>{
  const db=openTimelineDatabase(path);
  try {
    assert.equal(db.prepare("PRAGMA query_only").get().query_only,1);
    assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema,0);
    assert.equal(db.prepare("PRAGMA temp_store").get().temp_store,2);
    assert.equal(db.isTransaction,true);
    assert.throws(()=>db.exec("UPDATE timeline SET subject='forbidden'"),/readonly/i);
    // Even disabling the per-connection guard cannot make the underlying handle writable.
    db.exec("PRAGMA query_only=OFF");
    assert.throws(()=>db.exec("UPDATE timeline SET subject='forbidden'"),/readonly/i);
  } finally {db.close();}
}));
