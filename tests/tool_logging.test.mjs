import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, linkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSearchFixture } from "./searchFixture.mjs";
import { datasetOverview } from "../src/datasetOverview.mjs";
import { searchRecords } from "../src/searchRecords.mjs";
import { getRecord, getContext } from "../src/recordTools.mjs";
import { writeToolLog } from "../src/toolLogging.mjs";

const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const noop = () => {};
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "sherpa-logging-"));
  const priorRun = process.env.SHERPA_RUN_ID, priorDir = process.env.SHERPA_LOG_DIR;
  delete process.env.SHERPA_RUN_ID; delete process.env.SHERPA_LOG_DIR;
  try { const databasePath = join(root, "fixture.sqlite"); createSearchFixture(databasePath); run({root, databasePath}); }
  finally {
    if (priorRun === undefined) delete process.env.SHERPA_RUN_ID; else process.env.SHERPA_RUN_ID = priorRun;
    if (priorDir === undefined) delete process.env.SHERPA_LOG_DIR; else process.env.SHERPA_LOG_DIR = priorDir;
    rmSync(root, { recursive: true });
  }
}

test("four Tools append one independent JSONL line each; exact bytes, metadata, no evidence, DB unchanged", () => fixture(({root,databasePath}) => {
  const config = {runId:"fixture_01",logDir:join(root,"new","logs"),databasePath};
  const path = join(config.logDir,"fixture_01_tools.jsonl");
  const before = digest(databasePath), mtime = statSync(databasePath).mtimeMs;
  const calls = [
    ["dataset_overview", {}, args=>datasetOverview(databasePath,args,noop)],
    ["search_records", {query:"quartz",source:"alpha"}, args=>searchRecords(databasePath,args)],
    ["get_record", {line_id:"sample-020"}, args=>getRecord(databasePath,args,noop)],
    ["get_context", {line_id:"sample-020"}, args=>getContext(databasePath,args,noop)],
  ];
  let prefix = "";
  for (const [tool,args,call] of calls) {
    const result=call(args), original=JSON.stringify(result);
    assert.equal(result.ok,true);
    writeToolLog(tool,args,result,()=>config, message=>assert.fail(message));
    assert.equal(JSON.stringify(result), original, "Logging mutated the exact result including timing");
    const content=readFileSync(path,"utf8");
    assert.ok(content.startsWith(prefix), "Existing bytes were rewritten");
    const newLines=content.slice(prefix.length).trimEnd().split("\n"); assert.equal(newLines.length,1);
    const line=JSON.parse(newLines[0]);
    assert.equal(line.run_id,config.runId); assert.equal(line.tool,tool);
    assert.ok(Number.isFinite(Date.parse(line.timestamp)));
    assert.equal(line.output_bytes,Buffer.byteLength(original,"utf8"));
    assert.equal(line.elapsed_ms,result.elapsed_ms); assert.equal(line.returned,result.returned??0);
    assert.equal(line.success,result.ok);
    assert.ok(!content.includes('"detail":')); assert.ok(!content.includes('"payload":')); assert.ok(!content.includes('"snippet":'));
    if(tool==="search_records") {
      assert.equal(line.query,args.query); assert.equal(line.total_matches,result.total_matches);
      assert.equal(line.truncated,result.truncated); assert.equal(line.max_results,result.limit);
      assert.deepEqual(line.returned_line_ids,result.records.map(r=>r.line_id)); assert.deepEqual(line.filters,{source:"alpha"});
    }
    if(tool==="dataset_overview") assert.equal(line.total_records,result.total_records);
    if(tool==="get_record") {
      assert.equal(line.found,true); assert.equal(line.truncated,result.truncated); assert.equal(line.requested_line_id,args.line_id);
      assert.ok(!content.includes(result.record.detail)); assert.ok(!content.includes(result.record.payload));
    }
    if(tool==="get_context") {
      assert.equal(line.before,3); assert.equal(line.after,3);
      assert.deepEqual(line.returned_line_ids,result.records.map(r=>r.line_id));
    }
    prefix=content;
  }
  assert.equal(prefix.trimEnd().split("\n").length,4);
  assert.equal(digest(databasePath),before); assert.equal(statSync(databasePath).mtimeMs,mtime);
  for(const suffix of ["-wal","-shm","-journal"]) assert.equal(existsSync(databasePath+suffix),false);
}));

test("Unicode and newline inputs remain one JSONL line; not found and validation failures logged", () => fixture(({root,databasePath}) => {
  const config={runId:"unicode",logDir:root,databasePath};
  const query='한글🙂\n"quoted"';
  const search=searchRecords(databasePath,{query});
  writeToolLog("search_records",{query},search,()=>config);
  const missing=getRecord(databasePath,{line_id:"absent\nline"},noop);
  writeToolLog("get_record",{line_id:"absent\nline"},missing,()=>config);
  const invalid=getContext(databasePath,{line_id:"sample-020",before:6},noop);
  writeToolLog("get_context",{line_id:"sample-020",before:6},invalid,()=>config);
  const lines=readFileSync(join(root,"unicode_tools.jsonl"),"utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(lines.length,3); assert.equal(lines[0].query,query);
  assert.equal(lines[0].output_bytes,Buffer.byteLength(JSON.stringify(search)));
  assert.equal(lines[1].success,false); assert.equal(lines[1].found,false); assert.equal(lines[1].error,"NOT_FOUND");
  assert.equal(lines[2].success,false); assert.equal(lines[2].before,6);
}));

test("configuration precedence, environment fallback and both unset disabling", () => fixture(({root,databasePath}) => {
  const result=datasetOverview(databasePath,{},noop);
  writeToolLog("dataset_overview",{},result,()=>({databasePath}));
  process.env.SHERPA_RUN_ID="environment"; process.env.SHERPA_LOG_DIR=root;
  writeToolLog("dataset_overview",{},result,()=>({databasePath,runId:"",logDir:""}));
  assert.ok(existsSync(join(root,"environment_tools.jsonl")));
  const configured=join(root,"configured");
  writeToolLog("dataset_overview",{},result,()=>({databasePath,runId:"configured",logDir:configured}));
  assert.ok(existsSync(join(configured,"configured_tools.jsonl")));
}));

test("logging failures are explicit and leave retrieval JSON unchanged, including failure of warning sink", () => fixture(({root,databasePath}) => {
  const errors=[],warnings=[]; const originalConsole=console.error;
  console.error=message=>errors.push(JSON.parse(message));
  try {
    const result=getRecord(databasePath,{line_id:"sample-020"},noop), original=JSON.stringify(result);
    const blocker=join(root,"not-a-directory");writeFileSync(blocker,"original-data");
    for(const config of [
      {runId:"../escape",logDir:root}, {runId:"only-id"}, {runId:"relative",logDir:"relative"},
      {runId:"blocked",logDir:join(blocker,"logs")},
    ]) writeToolLog("get_record",{line_id:"sample-020"},result,()=>({...config,databasePath}),m=>warnings.push(m));
    writeToolLog("get_record",{},result,()=>{throw Error("config failure");},()=>{throw Error("warning failure");});
    assert.equal(errors.length,5);assert.equal(warnings.length,4);
    assert.ok(errors.every(e=>e.event==="sherpa_log_error"&&e.code));
    assert.equal(JSON.stringify(result),original);assert.equal(readFileSync(blocker,"utf8"),"original-data");
  } finally {console.error=originalConsole;}
}));

test("existing foreign/partial JSONL and hard-linked DB targets are never overwritten or appended", () => fixture(({root,databasePath}) => {
  const result=datasetOverview(databasePath,{},noop), before=digest(databasePath);
  const originalConsole=console.error;console.error=noop;
  try {
    for(const [runId,content] of [["foreign","original,evidence\n"],["partial",'{"run_id":"partial"']]) {
      const path=join(root,`${runId}_tools.jsonl`);writeFileSync(path,content);
      const warnings=[];writeToolLog("dataset_overview",{},result,()=>({runId,logDir:root,databasePath}),m=>warnings.push(m));
      assert.equal(warnings.length,1);assert.equal(readFileSync(path,"utf8"),content);
    }
    const linked=join(root,"linked_tools.jsonl");linkSync(databasePath,linked);
    const warnings=[];writeToolLog("dataset_overview",{},result,()=>({runId:"linked",logDir:root,databasePath}),m=>warnings.push(m));
    assert.equal(warnings.length,1);assert.equal(digest(databasePath),before);
  } finally {console.error=originalConsole;}
}));
