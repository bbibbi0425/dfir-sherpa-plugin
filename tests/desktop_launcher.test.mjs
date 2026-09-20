import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,readdirSync,existsSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {launchDesktop} from "../scripts/desktop_launcher.mjs";
import {readJson,writeJson,stopOwned,alive} from "../scripts/experiment_state.mjs";
import {activeExperiment} from "../src/experimentBridge.mjs";
import {createSearchFixture} from "./searchFixture.mjs";
import {digest,inspectConversation} from "../scripts/collector_core.mjs";
import {datasetOverview} from "../src/datasetOverview.mjs";
import {searchRecords} from "../src/searchRecords.mjs";
import {getRecord,getContext} from "../src/recordTools.mjs";

const names=["dataset_overview","search_records","get_record","get_context"];
const stats=n=>({stopReason:"eosFound",promptTokensCount:100+n,totalTimeSec:1.25+n,timeToFirstTokenSec:0.1});
function nativeChat(db,n,{pending=false}={}) {
  const inputs=[{},{query:"quartz"},{line_id:"sample-020"},{line_id:"sample-020"}], funcs=[datasetOverview,searchRecords,getRecord,getContext];
  const steps=names.flatMap((name,i)=>[
    {type:"contentBlock",stepIdentifier:`r${i}`,content:[{type:"toolCallRequest",name,callId:String(i),parameters:inputs[i],pluginIdentifier:"local/dfir-sherpa"}]},
    {type:"toolStatus",stepIdentifier:`s${i}`,callId:String(i),statusState:{customStatus:"DFIR_SHERPA_RUN:old_manual_setting",status:{type:"toolCallSucceeded"}}},
    {type:"contentBlock",stepIdentifier:`o${i}`,roleOverride:"tool",content:[{type:"toolCallResult",name,callId:String(i),content:JSON.stringify(funcs[i](db,inputs[i],()=>{}))}]},
  ]);
  if(pending)steps.splice(1);else steps.push({type:"contentBlock",content:[{type:"text",text:JSON.stringify({ok:true,run:n})}],genInfo:{identifier:"fixture-model",stats:stats(n)}});
  return {plugins:["local/dfir-sherpa"],pluginConfigs:{"local/dfir-sherpa":{config:{fields:[{key:"databasePath",value:db},{key:"SHERPA_RUN_ID",value:"old_manual_setting"}]}}},
    messages:[{currentlySelected:0,versions:[{role:"user",content:[{type:"text",text:`Desktop fixture unique ${n}`}]}]},
      {currentlySelected:0,versions:[{role:"assistant",steps}]}]};
}
function logs(n) {return [
  JSON.stringify({timestamp:100+n*2,data:{type:"llm.prediction.input",modelIdentifier:"fixture-model",input:names.join(" ")+` Desktop fixture unique ${n}`}}),
  JSON.stringify({timestamp:101+n*2,data:{type:"llm.prediction.output",modelIdentifier:"fixture-model",output:JSON.stringify({ok:true,run:n}),stats:stats(n)}}),
].join("\n")+"\n";}
async function until(predicate,timeout=18000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await predicate())return;await delay(100);}
  throw Error("Timed out waiting for automatic collection");
}
async function fixture(fn) {
  const root=mkdtempSync(join(tmpdir(),"sherpa-desktop-")),resultsRoot=join(root,"results"),conversationDir=join(root,"conversations"),controlDir=join(root,"control"),db=join(root,"CaseFilenameMustNotBeGuessed.sqlite");
  mkdirSync(conversationDir);createSearchFixture(db);const before=digest(readFileSync(db));
  const feed=join(root,"feed.jsonl"),fake=join(root,"fake-lms.mjs"),app=join(root,"fake-app.mjs");writeFileSync(feed,"");
  writeFileSync(fake,`import {readFileSync} from 'node:fs';console.error('Streaming logs from LM Studio');let count=0;setInterval(()=>{const s=readFileSync(${JSON.stringify(feed)},'utf8');if(s.length>count){process.stdout.write(s.slice(count));count=s.length;}},100);`);
  writeFileSync(app,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(root,"app-launches.txt"))},'launched\\n');`);
  const options={resultsRoot,conversationDir,controlDir,appCommand:[process.execPath,app],loggerCommand:[process.execPath,fake],timeoutMs:18000};
  const stateDir=join(resultsRoot,".collector");
  const runs=()=>existsSync(resultsRoot)?readdirSync(resultsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith(".")).map(e=>join(resultsRoot,e.name)):[];
  try{await fn({root,db,feed,options,stateDir,runs});}
  finally{
    const lock=join(stateDir,"collector.lock");
    if(existsSync(lock)){
      const owner=readJson(lock);writeJson(join(stateDir,"stop.json"),{token:owner.token});
      await until(()=>!alive(owner.pid),15000).catch(()=>{});
      if(alive(owner.pid)&&existsSync(join(stateDir,"desktop-runtime.json"))){const r=readJson(join(stateDir,"desktop-runtime.json"));stopOwned(r.model_logger);stopOwned(r.model_supervisor);stopOwned(r.collector);}
    }
    assert.equal(digest(readFileSync(db)),before);rmSync(root,{recursive:true,force:true});
  }
}

test("desktop launcher starts once, auto-detects four tools, finishes two Runs and recovers after collector crash",async()=>fixture(async f=>{
  const first=await launchDesktop(f.options);
  assert.equal(first.status,"ready");assert.equal(f.runs().length,0);
  assert.equal(activeExperiment(f.db,f.options.controlDir).mode,"desktop_auto");
  const reused=await launchDesktop(f.options);assert.equal(reused.reused,true);assert.equal(reused.collector_pid,first.collector_pid);
  const a=join(f.options.conversationDir,"a.conversation.json");
  writeFileSync(a,JSON.stringify(nativeChat(f.db,1)));const original=readFileSync(a);
  appendFileSync(f.feed,logs(1));
  await until(()=>f.runs().length===1&&readJson(join(f.runs()[0],"run.json")).status==="completed");
  const runA=f.runs()[0],manifest=readJson(join(runA,"run.json"));assert.match(manifest.run_id,/^run_\d{8}_\d{6}/);
  for(const name of ["run.json","prompt.txt","tools-summary.jsonl","tool-events.jsonl","model.log","model-response.md","model-response.json","conversation.json"])assert.ok(existsSync(join(runA,name)),name);
  assert.equal(readFileSync(join(runA,"tools-summary.jsonl"),"utf8").trim().split("\n").length,4);
  assert.equal(readFileSync(join(runA,"model.log"),"utf8"),logs(1));assert.equal(readJson(join(runA,"model-response.json")).parsed_json.ok,true);
  assert.deepEqual(readFileSync(a),original);const events=readFileSync(join(runA,"tool-events.jsonl"));
  const b=join(f.options.conversationDir,"b.conversation.json");writeFileSync(b,JSON.stringify(nativeChat(f.db,2,{pending:true})));
  await until(()=>f.runs().length===2);
  const current=readJson(join(f.stateDir,"desktop-runtime.json"));stopOwned(current.collector);
  await until(()=>!alive(current.collector.pid));
  const restarted=await launchDesktop(f.options);assert.notEqual(restarted.collector_pid,first.collector_pid);
  assert.equal(f.runs().length,2);assert.deepEqual(readFileSync(join(runA,"tool-events.jsonl")),events);
  writeFileSync(b,JSON.stringify(nativeChat(f.db,2)));appendFileSync(f.feed,logs(2));
  await until(()=>f.runs().every(p=>readJson(join(p,"run.json")).status==="completed"));
  const runB=f.runs().find(p=>p!==runA);assert.equal(readFileSync(join(runB,"model.log"),"utf8"),logs(2));
  assert.equal(readFileSync(join(runA,"model.log"),"utf8"),logs(1));
}));

test("completion waits for pending tools from any enabled plugin",async()=>fixture(async f=>{
  const chat=nativeChat(f.db,3),steps=chat.messages[1].versions[0].steps;
  steps.splice(0,0,{type:"contentBlock",content:[{type:"toolCallRequest",name:"other_safe_tool",callId:"other",pluginIdentifier:"other/plugin"}]});
  assert.equal(inspectConversation(chat,{idle:true}).status,"unknown");
}));

test("missing model logger never reports launcher ready",async()=>fixture(async f=>{
  await assert.rejects(launchDesktop({...f.options,loggerCommand:[join(f.root,"missing.exe")],timeoutMs:4000}),/not become ready/);
  assert.equal(existsSync(join(f.stateDir,"launcher-ready.json")),false);
}));
