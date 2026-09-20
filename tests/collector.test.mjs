import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, appendFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Collector, digest, inspectConversation} from "../scripts/collector_core.mjs";
import {makeRunId, validRunId, RUN_STATUS_PREFIX} from "../src/runIdentity.mjs";
import {createSearchFixture} from "./searchFixture.mjs";
import {DB_STATUS_PREFIX} from "../src/databaseBinding.mjs";
import {datasetOverview} from "../src/datasetOverview.mjs";
import {searchRecords} from "../src/searchRecords.mjs";
import {getRecord, getContext} from "../src/recordTools.mjs";

const TOOLS=["dataset_overview","search_records","get_record","get_context"];
const json = path => JSON.parse(readFileSync(path,"utf8"));
const stats = n => ({stopReason:"toolCalls",promptTokensCount:100+n,totalTimeSec:1.234567+n,timeToFirstTokenSec:0.123456+n,predictedTokensCount:20+n});
const generation = (n,reason="toolCalls") => ({identifier:"synthetic-model",loadModelConfig:{fields:[]},predictionConfig:{fields:[]},stats:{...stats(n),stopReason:reason}});
async function fixture(fn) {
  const root=mkdtempSync(join(tmpdir(),"sherpa-collector-"));
  try {
    const conversationDir=join(root,"conversations"),resultsRoot=join(root,"results"),db=join(root,"CaseAlpha.sqlite");
    mkdirSync(conversationDir);createSearchFixture(db);
    const original=digest(readFileSync(db)),mtime=statSync(db).mtimeMs;
    const options={conversationDir,resultsRoot,settleMs:0,idleMs:0};
    await fn({root,conversationDir,resultsRoot,db,options,collector:new Collector(options)});
    assert.equal(digest(readFileSync(db)),original);assert.equal(statSync(db).mtimeMs,mtime);
  } finally {rmSync(root,{recursive:true});}
}
function chatFor(db,prompt="Synthetic test A",offset=0) {
  return {plugins:["local/dfir-sherpa"],lastUsedModel:{identifier:"synthetic-model"},
    pluginConfigs:{"local/dfir-sherpa":{config:{fields:[{key:"databasePath",value:db},{key:"SHERPA_RUN_ID",value:""},{key:"SHERPA_LOG_DIR",value:""}]}}},
    messages:[{currentlySelected:0,versions:[{type:"singleStep",role:"user",content:[{type:"text",text:prompt}]}]},
      {currentlySelected:0,versions:[{type:"multiStep",role:"assistant",steps:[]}]}],offset};
}
function finish(chat, db, reason="eosFound", marker=null) {
  const steps=chat.messages[1].versions[0].steps;
  const params=[{}, {query:"quartz"}, {line_id:"sample-020"}, {line_id:"sample-020"}];
  const functions=[datasetOverview,searchRecords,getRecord,getContext];
  TOOLS.forEach((name,i)=>{
    const result=functions[i](db,params[i],()=>{}),callId=String(i);
    steps.push({type:"contentBlock",stepIdentifier:`request-${i}`,genInfo:generation(chat.offset+i),content:[{type:"toolCallRequest",callId,name,parameters:params[i],pluginIdentifier:"local/dfir-sherpa"}]},
      {type:"toolStatus",stepIdentifier:`status-${i}`,callId,statusState:{customStatus:marker?RUN_STATUS_PREFIX+marker:"",status:{type:"toolCallSucceeded",timeMs:result.elapsed_ms}}},
      {type:"contentBlock",stepIdentifier:`result-${i}`,roleOverride:"tool",content:[{type:"toolCallResult",callId,name,content:JSON.stringify(result)}]});
  });
  steps.push({type:"contentBlock",style:{type:"thinking"},content:[{type:"text",text:"Synthetic reasoning excluded"}]});
  steps.push({type:"contentBlock",stepIdentifier:"final",genInfo:generation(chat.offset+4,reason),content:[{type:"text",text:'{"ok":true,"message":"한글🙂"}\n'}]});
  return chat;
}
function save(f,name,chat) { const path=join(f.conversationDir,`${name}.conversation.json`);writeFileSync(path,JSON.stringify(chat));return path; }
const runDirs = f => readdirSync(f.resultsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith(".")).map(e=>join(f.resultsRoot,e.name));
function modelLines(chat) {
  const prompt=chat.messages[0].versions[0].content[0].text;
  const gens=chat.messages[1].versions[0].steps.filter(s=>s.genInfo).map(s=>s.genInfo);
  return gens.flatMap((g,i)=>[
    JSON.stringify({timestamp:10000+chat.offset*100+i*2,data:{type:"llm.prediction.input",modelIdentifier:"synthetic-model",input:TOOLS.join(" ")+"\n"+prompt+"\nround "+i}}),
    JSON.stringify({timestamp:10001+chat.offset*100+i*2,data:{type:"llm.prediction.output",modelIdentifier:"synthetic-model",output:"Synthetic raw output",stats:g.stats}}),
  ]);
}

test("automatic detection, generated ID, four Tools, final artifacts and unchanged source DB/conversation",async()=>fixture(async f=>{
  const chat=chatFor(f.db),path=save(f,"a",chat);
  await f.collector.poll();assert.equal(runDirs(f).length,0); // Baseline before any Tool.
  finish(chat,f.db);save(f,"a",chat);const source=readFileSync(path);
  const lines=modelLines(chat);lines.forEach(line=>f.collector.ingestModelLine(line));
  await f.collector.poll();
  const [dir]=runDirs(f),record=json(join(dir,"run.json"));
  assert.match(record.run_id,/^CaseAlpha_\d{8}_\d{6}/);assert.equal(record.status,"completed");
  assert.equal(record.database.unchanged_since_baseline,true);assert.equal(record.database.baseline_scope,"observed_before_first_tool");
  assert.equal(record.database.path,f.db);assert.equal(record.database.filename,"CaseAlpha.sqlite");
  assert.equal(record.database.sha256,digest(readFileSync(f.db)));assert.equal(record.database.bytes,statSync(f.db).size);
  assert.equal(record.summary_ids.length,4);assert.equal(record.event_ids.length,12);
  assert.deepEqual(readFileSync(path),source);assert.deepEqual(readFileSync(join(dir,"conversation.json")),source);
  assert.equal(readFileSync(join(dir,"prompt.txt"),"utf8"),"Synthetic test A");
  assert.equal(json(join(dir,"model-response.json")).parsed_json.message,"한글🙂");
  assert.equal(readFileSync(join(dir,"model-response.md"),"utf8"),'{"ok":true,"message":"한글🙂"}\n');
  assert.equal(readFileSync(join(dir,"model.log"),"utf8"),lines.join("\n")+"\n");
  assert.equal(record.model_capture.state,"matched");
  const output=json(join(dir,"model-statistics.json"));assert.deepEqual(output.at(-1).stats,generation(4,"eosFound").stats);
}));

test("changing DB after first Tool interrupts the Run and retains the first DB across restart",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db);save(f,"binding",chat);await f.collector.poll();
  const [dir]=runDirs(f),before=json(join(dir,"run.json")).database;
  const other=join(f.root,"Other.sqlite");createSearchFixture(other);
  chat.pluginConfigs["local/dfir-sherpa"].config.fields[0].value=other;
  save(f,"binding",chat);await f.collector.poll();
  let record=json(join(dir,"run.json"));assert.equal(record.status,"interrupted");
  assert.equal(record.database.binding_error,"DB_PATH_CHANGED");assert.equal(record.database.path,f.db);
  assert.deepEqual(record.database.before,before.before);
  chat.pluginConfigs["local/dfir-sherpa"].config.fields[0].value=f.db;save(f,"binding",chat);
  await new Collector(f.options).poll();record=json(join(dir,"run.json"));
  assert.equal(record.status,"interrupted");assert.equal(record.database.path,f.db);
}));

test("saved Tool DB marker identifies the actual first DB even if chat setting changed before detection",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db),other=join(f.root,"Other.sqlite");createSearchFixture(other);
  const status=chat.messages[1].versions[0].steps.find(s=>s.type==="toolStatus");
  status.statusState.customStatus=RUN_STATUS_PREFIX+"fixture_run\n"+DB_STATUS_PREFIX+JSON.stringify({path:f.db,requested_path:f.db,error:null});
  chat.pluginConfigs["local/dfir-sherpa"].config.fields[0].value=other;
  save(f,"marker",chat);await f.collector.poll();
  const record=json(join(runDirs(f)[0],"run.json"));
  assert.equal(record.database.path,f.db);assert.equal(record.database.binding_source,"tool_status");
  assert.equal(record.database.sha256,digest(readFileSync(f.db)));assert.equal(record.status,"interrupted");
  assert.deepEqual(record.identity.plugin_markers,["fixture_run"]);
}));

test("DB can change before the first Tool without borrowing the previous pre-Tool baseline",async()=>fixture(async f=>{
  const chat=chatFor(f.db);save(f,"before",chat);await f.collector.poll();
  const other=join(f.root,"Other.sqlite");createSearchFixture(other);
  chat.pluginConfigs["local/dfir-sherpa"].config.fields[0].value=other;
  finish(chat,other);save(f,"before",chat);await f.collector.poll();
  const record=json(join(runDirs(f)[0],"run.json"));
  assert.equal(record.database.path,other);assert.equal(record.database.filename,"Other.sqlite");assert.equal(record.status,"completed");
  assert.equal(record.database.baseline_scope,"first_detection_or_recovery");
}));

test("sequential and interleaved two Runs keep their model.log events separated",async()=>fixture(async f=>{
  const a=finish(chatFor(f.db,"Run A unique prompt",0),f.db),b=finish(chatFor(f.db,"Run B unique prompt",20),f.db);
  save(f,"a",a);modelLines(a).forEach(l=>f.collector.ingestModelLine(l));await f.collector.poll();
  save(f,"b",b);modelLines(b).reverse().forEach(l=>f.collector.ingestModelLine(l));await f.collector.poll();
  const dirs=runDirs(f);assert.equal(dirs.length,2);
  for(const dir of dirs){const prompt=readFileSync(join(dir,"prompt.txt"),"utf8"),log=readFileSync(join(dir,"model.log"),"utf8");
    assert.ok(log.includes(prompt));assert.ok(!log.includes(prompt.includes("Run A")?"Run B":"Run A"));
    assert.equal(log.trimEnd().split("\n").length,10);}
}));

test("restart recovers uncollected conversations, replayed logs and prevents duplicate archives/events",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db);save(f,"a",chat);
  modelLines(chat).forEach(l=>f.collector.ingestModelLine(l));
  const restarted=new Collector(f.options);await restarted.poll();
  const [dir]=runDirs(f),before=readFileSync(join(dir,"tool-events.jsonl"));
  await restarted.poll();await new Collector(f.options).poll();
  assert.equal(runDirs(f).length,1);assert.deepEqual(readFileSync(join(dir,"tool-events.jsonl")),before);
  assert.equal(json(join(dir,"run.json")).model_capture.state,"matched");
}));

test("interrupted/ambiguous end is preserved and missing historical model events are explicit",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db,"userStopped");save(f,"a",chat);await f.collector.poll();
  let record=json(join(runDirs(f)[0],"run.json"));assert.equal(record.status,"interrupted");
  assert.equal(record.model_capture.state,"partial_or_unavailable");assert.equal(record.model_capture.output_events,0);
  chat.messages[1].versions[0].steps.at(-1).genInfo.stats.stopReason="toolCalls";
  save(f,"a",chat);await f.collector.poll();record=json(join(runDirs(f)[0],"run.json"));assert.equal(record.status,"unknown");
}));

test("normal text stop cannot complete with a pending/failed Tool or newer user message",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db);
  chat.messages[1].versions[0].steps.find(s=>s.type==="toolStatus").statusState.status.type="callingTool";
  assert.equal(inspectConversation(chat,{idle:true}).status,"unknown");
  chat.messages[1].versions[0].steps.find(s=>s.type==="toolStatus").statusState.status.type="toolCallDenied";
  assert.equal(inspectConversation(chat).status,"interrupted");
  chat.messages[1].versions[0].steps.find(s=>s.type==="toolStatus").statusState.status.type="toolCallSucceeded";
  chat.messages.push(chat.messages[0]);assert.equal(inspectConversation(chat,{idle:true}).status,"unknown");
}));

test("plugin marker and explicit run IDs are honored with collision protection",async()=>fixture(async f=>{
  const marker=makeRunId(f.db,new Date(2025,0,2,3,4,5),"test");
  save(f,"a",finish(chatFor(f.db,"A",0),f.db,"eosFound",marker));await f.collector.poll();
  assert.equal(json(join(runDirs(f)[0],"run.json")).run_id,marker);
  const b=finish(chatFor(f.db,"B",20),f.db);b.pluginConfigs["local/dfir-sherpa"].config.fields.find(x=>x.key==="SHERPA_RUN_ID").value=marker;
  save(f,"b",b);await f.collector.poll();assert.equal(runDirs(f).length,2);
  assert.equal(validRunId("../unsafe"),false);assert.match(makeRunId(null),/^run_/);
}));

test("reused call IDs in separate assistant turns do not borrow results or parameters",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db),f.db),next=finish(chatFor(f.db),f.db);
  const second=next.messages[1];
  second.versions[0].steps.find(s=>s.content?.[0]?.name==="search_records").content[0].parameters.query="second unique query";
  chat.messages.push(next.messages[0],second);
  save(f,"reused",chat);await f.collector.poll();
  const summaries=readFileSync(join(runDirs(f)[0],json(join(runDirs(f)[0],"run.json")).run_id+"_tools.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(summaries.filter(s=>s.tool==="search_records").map(s=>s.query),["quartz","second unique query"]);
  second.versions[0].steps=second.versions[0].steps.filter(s=>!(s.roleOverride==="tool"&&s.content[0].callId==="0"));
  assert.equal(inspectConversation(chat,{idle:true}).status,"unknown");
}));

test("follow-up messages retain earlier model inputs in the same Run",async()=>fixture(async f=>{
  const chat=finish(chatFor(f.db,"Initial unique prompt",0),f.db);
  const first=modelLines(chat);
  save(f,"followup",chat);first.forEach(line=>f.collector.ingestModelLine(line));await f.collector.poll();
  const next=finish(chatFor(f.db,"Follow-up unique prompt",20),f.db);
  const later=modelLines(next).map(raw=>{
    const event=JSON.parse(raw);
    if(event.data.type.endsWith("input"))event.data.input+="\nInitial unique prompt";
    return JSON.stringify(event);
  });
  chat.messages.push(...next.messages);
  save(f,"followup",chat);later.forEach(line=>f.collector.ingestModelLine(line));await f.collector.poll();
  assert.equal(runDirs(f).length,1);
  const stored=readFileSync(join(runDirs(f)[0],"model.log"),"utf8").trimEnd().split("\n");
  assert.deepEqual(new Set(stored),new Set([...first,...later]));
}));

test("identical prompts/statistics are ambiguous and never copied to both Run model logs",async()=>fixture(async f=>{
  const a=finish(chatFor(f.db,"Same prompt"),f.db),b=structuredClone(a);
  save(f,"a",a);save(f,"b",b);modelLines(a).forEach(l=>f.collector.ingestModelLine(l));await f.collector.poll();
  for(const dir of runDirs(f)) assert.equal(readFileSync(join(dir,"model.log"),"utf8"),"");
  assert.equal(f.collector.routingHealth.ambiguous_events,10);
}));

test("crash after journal append recovers exact events and a partial tail without touching source",async()=>fixture(async f=>{
  save(f,"a",finish(chatFor(f.db),f.db));await f.collector.poll();const [dir]=runDirs(f);
  const original=readFileSync(join(dir,"tool-events.jsonl"));
  appendFileSync(join(dir,"tool-events.jsonl"),'{"interrupted":');
  const manifest=json(join(dir,"run.json"));manifest.event_ids=[];writeFileSync(join(dir,"run.json"),JSON.stringify(manifest));
  await new Collector(f.options).poll();
  assert.deepEqual(readFileSync(join(dir,"tool-events.jsonl")),original);
  assert.ok(readdirSync(dir).some(n=>n.startsWith("tool-events.jsonl.partial-")));
}));

test("non-Sherpa chat ignored and manual initialized run not duplicated",async()=>fixture(async f=>{
  const other=finish(chatFor(f.db),f.db);other.plugins=[];other.pluginConfigs={};
  other.messages[1].versions[0].steps.forEach(s=>s.content?.forEach(e=>{if(e.pluginIdentifier)e.pluginIdentifier="other/plugin";}));
  save(f,"other",other);await f.collector.poll();assert.equal(runDirs(f).length,0);
  const dir=join(f.resultsRoot,"manual_run");mkdirSync(dir);writeFileSync(join(dir,"run.json"),JSON.stringify({format:"dfir-sherpa-run",run_id:"manual_run",status:"prepared"}));
  const chat=finish(chatFor(f.db),f.db);chat.pluginConfigs["local/dfir-sherpa"].config.fields.find(x=>x.key==="SHERPA_RUN_ID").value="manual_run";
  save(f,"manual",chat);await f.collector.poll();assert.equal(runDirs(f).length,1);
  await new Collector(f.options).poll();assert.equal(runDirs(f).length,1);
}));

test("singleton lock prevents two background writers and can be released",async()=>fixture(async f=>{
  f.collector.acquire();const second=new Collector(f.options);
  assert.throws(()=>second.acquire(),/already running/);f.collector.release();second.acquire();second.release();
}));
