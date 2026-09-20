import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {startExperiment,stopExperiment} from "../scripts/experiment_core.mjs";
import {readJson,stopOwned,alive,processIdentity} from "../scripts/experiment_state.mjs";
import {activeExperiment} from "../src/experimentBridge.mjs";
import {createSearchFixture} from "./searchFixture.mjs";
import {digest} from "../scripts/collector_core.mjs";
import {datasetOverview} from "../src/datasetOverview.mjs";
import {searchRecords} from "../src/searchRecords.mjs";
import {getRecord,getContext} from "../src/recordTools.mjs";

const names=["dataset_overview","search_records","get_record","get_context"];
const stats={stopReason:"eosFound",promptTokensCount:120,totalTimeSec:1.234,timeToFirstTokenSec:0.15};
const prompt="Synthetic experiment lifecycle check";
function conversation(db,id,{text='{"ok":true}',reason="eosFound"}={}) {
  const args=[{},{query:"quartz"},{line_id:"sample-020"},{line_id:"sample-020"}];
  const funcs=[datasetOverview,searchRecords,getRecord,getContext];
  const steps=names.flatMap((name,i)=>[
    {type:"contentBlock",stepIdentifier:`r${i}`,content:[{type:"toolCallRequest",callId:String(i),name,parameters:args[i],pluginIdentifier:"local/dfir-sherpa"}]},
    {type:"toolStatus",stepIdentifier:`s${i}`,callId:String(i),statusState:{customStatus:`DFIR_SHERPA_RUN:${id}`,status:{type:"toolCallSucceeded"}}},
    {type:"contentBlock",stepIdentifier:`o${i}`,roleOverride:"tool",content:[{type:"toolCallResult",callId:String(i),name,content:JSON.stringify(funcs[i](db,args[i],()=>{}))}]},
  ]);
  steps.push({type:"contentBlock",stepIdentifier:"final",content:[{type:"text",text}],genInfo:{identifier:"fixture-model",stats:{...stats,stopReason:reason}}});
  return {plugins:["local/dfir-sherpa"],pluginConfigs:{"local/dfir-sherpa":{config:{fields:[{key:"databasePath",value:db}]}}},
    lastUsedModel:{identifier:"fixture-model"},messages:[
      {currentlySelected:0,versions:[{role:"user",content:[{type:"text",text:prompt}]}]},
      {currentlySelected:0,versions:[{role:"assistant",steps}]}]};
}
async function fixture(fn) {
  const root=mkdtempSync(join(tmpdir(),"sherpa-experiment-"));
  const conversationDir=join(root,"conversations"),resultsRoot=join(root,"results"),controlDir=join(root,"control"),db=join(root,"fixture.sqlite"),fake=join(root,"fake-lms.mjs");
  mkdirSync(conversationDir);createSearchFixture(db);const original=digest(readFileSync(db));
  const modelLines=[JSON.stringify({timestamp:1,data:{type:"llm.prediction.input",modelIdentifier:"fixture-model",input:names.join(" ")+"\n"+prompt}}),
    JSON.stringify({timestamp:2,data:{type:"llm.prediction.output",modelIdentifier:"fixture-model",stats,output:'{"ok":true}'}})];
  writeFileSync(fake,`console.error("Streaming logs from LM Studio");
    console.log(${JSON.stringify(modelLines.join("\n"))});
    if(process.argv.includes("--exit"))process.exit(3);
    setInterval(()=>{},1000);`);
  const options={conversationDir,resultsRoot,controlDir,db,loggerCommand:[process.execPath,fake],startupTimeoutMs:5000};
  try {await fn({root,db,options,modelLines,save:(id,chat)=>writeFileSync(join(conversationDir,id+".conversation.json"),JSON.stringify(chat))});}
  finally {
    const active=join(controlDir,"active-experiment.json");
    if(existsSync(active))await stopExperiment({runId:readJson(active).run_id,resultsRoot}).catch(()=>{});
    assert.equal(digest(readFileSync(db)),original);
    rmSync(root,{recursive:true,force:true});
  }
}

test("single start/stop owns collector/logger processes, connects four tools, preserves JSON/stats and rejects reuse",async()=>fixture(async f=>{
  const started=await startExperiment({...f.options,runId:"fixture_one"});
  assert.equal(started.runtime.status,"ready");
  assert.ok(started.runtime.collector.pid && started.runtime.model_logger.pid);
  assert.equal(activeExperiment(f.db,f.options.controlDir).run_id,"fixture_one");
  assert.throws(()=>activeExperiment(join(f.root,"other.sqlite"),f.options.controlDir),/different database/);
  await assert.rejects(startExperiment({...f.options,runId:"fixture_one"}),/already exists/);
  await assert.rejects(startExperiment({...f.options,runId:"another"}),/active/);
  const chat=conversation(f.db,"fixture_one");f.save("new",chat);
  const source=digest(readFileSync(join(f.options.conversationDir,"new.conversation.json")));
  const stopped=await stopExperiment({runId:"fixture_one",resultsRoot:f.options.resultsRoot});
  assert.equal(stopped.status,"completed");
  assert.equal(digest(readFileSync(join(f.options.conversationDir,"new.conversation.json"))),source);
  const dir=started.run_dir,manifest=readJson(join(dir,"run.json"));
  assert.equal(manifest.database.unchanged_since_baseline,true);assert.ok(manifest.ended_at);
  assert.deepEqual(readJson(join(dir,"model-response.json")),{ok:true});
  assert.equal(readFileSync(join(dir,"model.log"),"utf8"),f.modelLines.join("\n")+"\n");
  const summary=readFileSync(join(dir,"fixture_one_tools.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(summary.map(s=>s.tool),names);assert.equal(manifest.event_ids.length,12);
  assert.equal(existsSync(join(f.options.controlDir,"active-experiment.json")),false);
  assert.equal(alive(started.runtime.collector.pid),false);assert.equal(alive(started.runtime.model_logger.pid),false);
  const events=readFileSync(join(dir,"tool-events.jsonl"));
  await stopExperiment({runId:"fixture_one",resultsRoot:f.options.resultsRoot});
  assert.deepEqual(readFileSync(join(dir,"tool-events.jsonl")),events);
  await assert.rejects(startExperiment({...f.options,runId:"fixture_one"}),/already exists/);
}));

test("PID identity mismatch never terminates the reused process",()=>{
  assert.throws(()=>stopOwned({...processIdentity(process.pid),fingerprint:"incorrect"}),/reused/);
  assert.equal(alive(process.pid),true);
});

test("collector crash before readiness fails start and releases the logger IPC lifeline",async()=>fixture(async f=>{
  const pending=startExperiment({...f.options,runId:"early_crash"});pending.catch(()=>{});
  const runtimePath=join(f.options.resultsRoot,"early_crash","runtime.json");
  for(let i=0;i<150&&!existsSync(runtimePath);i++)await delay(50);
  const runtime=readJson(runtimePath);
  assert.equal(runtime.status,"starting");
  stopOwned(runtime.collector);
  await assert.rejects(pending);
  assert.equal(readJson(join(f.options.resultsRoot,"early_crash","run.json")).status,"start_failed");
  assert.equal(existsSync(join(f.options.controlDir,"active-experiment.json")),false);
}));

test("dead collector/orphan logger recovery, interrupted response and sequential Run separation",async()=>fixture(async f=>{
  const a=await startExperiment({...f.options,runId:"fixture_recover"});
  stopOwned(a.runtime.collector);
  for(let i=0;i<40&&alive(a.runtime.collector.pid);i++)await delay(100);
  f.save("recover",conversation(f.db,"fixture_recover",{text:"Partial answer",reason:"userStopped"}));
  const recovered=await stopExperiment({runId:"fixture_recover",resultsRoot:f.options.resultsRoot});
  assert.equal(recovered.status,"interrupted");assert.equal(alive(a.runtime.model_logger.pid),false);
  assert.equal(readFileSync(join(a.run_dir,"model-response.md"),"utf8"),"Partial answer");
  assert.equal(existsSync(join(a.run_dir,"model-response.json")),false);
  const before=digest(readFileSync(join(a.run_dir,"tool-events.jsonl")));
  const b=await startExperiment({...f.options,runId:"fixture_second"});
  f.save("second",conversation(f.db,"fixture_second"));
  assert.equal((await stopExperiment({runId:"fixture_second",resultsRoot:f.options.resultsRoot})).status,"completed");
  assert.equal(digest(readFileSync(join(a.run_dir,"tool-events.jsonl"))),before);
  assert.equal(readJson(join(b.run_dir,"run.json")).run_id,"fixture_second");
}));

test("missing/early exiting model logger fails startup and preserves failed Run without ownership leaks",async()=>fixture(async f=>{
  for(const [id,command] of [["missing",[join(f.root,"missing.exe")]],["exits",[...f.options.loggerCommand,"--exit"]]]) {
    await assert.rejects(startExperiment({...f.options,runId:id,loggerCommand:command}));
    const dir=join(f.options.resultsRoot,id);
    assert.equal(readJson(join(dir,"run.json")).status,"start_failed");
    assert.equal(readJson(join(dir,"runtime.json")).status,"failed");
    assert.equal(existsSync(join(f.options.controlDir,"active-experiment.json")),false);
  }
}));

test("two fresh conversations with one Run ID are preserved as ambiguous, never completed",async()=>fixture(async f=>{
  const run=await startExperiment({...f.options,runId:"ambiguous"});
  f.save("one",conversation(f.db,"ambiguous"));f.save("two",conversation(f.db,"ambiguous"));
  const result=await stopExperiment({runId:"ambiguous",resultsRoot:f.options.resultsRoot});
  assert.equal(result.status,"unknown");assert.match(result.capture_error,/Multiple conversations/);
  assert.equal(readFileSync(join(run.run_dir,"model-response.md"),"utf8"),"");
}));

test("conversation database mismatch is reported without archiving the wrong database records",async()=>fixture(async f=>{
  const run=await startExperiment({...f.options,runId:"database_mismatch"});
  const other=join(f.root,"other.sqlite");createSearchFixture(other);
  f.save("wrong",conversation(other,"database_mismatch"));
  const result=await stopExperiment({runId:"database_mismatch",resultsRoot:f.options.resultsRoot});
  assert.equal(result.status,"unknown");assert.match(result.capture_error,/database differs/);
  assert.equal(existsSync(join(run.run_dir,"conversation.json")),false);
}));
