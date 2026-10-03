import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {buildUi,loadStudioSdk,uiDriver} from "../scripts/batch.mjs";
import {createSearchFixture} from "./searchFixture.mjs";
import {runBatch,validatePlan,findBatchConversation,completedArchive,preparedPromptMatches} from "../scripts/batch_core.mjs";
import {snapshotDatabase} from "../scripts/collector_core.mjs";

const json=path=>JSON.parse(readFileSync(path,"utf8"));
const put=(path,value)=>writeFileSync(path,JSON.stringify(value));
const fields=(token,database)=>[{key:"SHERPA_RUN_ID",value:token},{key:"databasePath",value:database}];
test("UI timeout preserves the action and last stage instead of masking it as a JSON error",()=>{
  const driver=uiDriver("fixture","fixture",{execute:()=>{throw Object.assign(Error("spawn timed out"),{
    code:"ETIMEDOUT",stdout:"",stderr:"UI stage: locating window\nUI stage: reading LM Studio controls\n"});}});
  assert.throws(()=>driver.preflight(),/UI preflight: UI inspection timed out.*reading LM Studio controls/);
});
test("UI helper failure, invalid response and uncertain submit are not retried",()=>{
  let calls=0;
  const driver=uiDriver("fixture","fixture",{execute:()=>{calls++;throw Object.assign(Error("failed"),{stdout:'{"ok":false,"error":"button unavailable"}'});}});
  assert.throws(()=>driver.submit({}),/UI submit: button unavailable/);assert.equal(calls,1);
  assert.throws(()=>uiDriver("fixture","fixture",{execute:()=>""}).preflight(),/empty or invalid response/);
  assert.throws(()=>uiDriver("fixture","fixture",{execute:()=>"null"}).preflight(),/unexpected response/);
});
test("installed SDK is resolved through package exports even with an invalid legacy main",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sherpa-sdk-"));
  try {
    put(join(dir,"package.json"),{name:"fixture-plugin",type:"module"});
    const sdk=join(dir,"node_modules","@lmstudio","sdk");mkdirSync(sdk,{recursive:true});
    put(join(sdk,"package.json"),{name:"@lmstudio/sdk",main:"missing.js",exports:{".":{require:"./entry.cjs"}}});
    writeFileSync(join(sdk,"entry.cjs"),"exports.LMStudioClient = class FixtureClient {};");
    assert.equal(typeof loadStudioSdk(dir).LMStudioClient,"function");
  } finally {rmSync(dir,{recursive:true});}
});
const chatFor=(token,database)=>({plugins:["local/dfir-sherpa"],pluginConfigs:{"local/dfir-sherpa":{config:{fields:fields(token,database)}}},
  lastUsedModel:{identifier:"synthetic-model"},messages:[]});
function finish(chat,prompt,stopReason="eosFound") {
  chat.clientInput="";
  chat.messages=[{currentlySelected:0,versions:[{role:"user",content:[{type:"text",text:prompt}]}]},
    {currentlySelected:0,versions:[{role:"assistant",steps:[
      {type:"contentBlock",content:[{type:"toolCallRequest",callId:"1",name:"dataset_overview",parameters:{},pluginIdentifier:"local/dfir-sherpa"}]},
      {type:"toolStatus",callId:"1",statusState:{status:{type:"toolCallSucceeded"}}},
      {type:"contentBlock",roleOverride:"tool",content:[{type:"toolCallResult",callId:"1",name:"dataset_overview",content:'{"ok":true,"total_records":40}'}]},
      {type:"contentBlock",genInfo:{stats:{stopReason}},content:[{type:"text",text:'{"result":"fixture"}'}]},
    ]}]}];return chat;
}
async function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),"sherpa-batch-"));
  try {
    const conversationDir=join(dir,"chats"),resultsRoot=join(dir,"results"),batchesRoot=join(dir,"batches");
    mkdirSync(conversationDir);mkdirSync(resultsRoot);
    const databases=["one.sqlite","two.sqlite","three.sqlite"].map(name=>join(dir,name));databases.forEach(createSearchFixture);
    const before=await Promise.all(databases.map(snapshotDatabase));const actions=[];let current;
    const plan={databases,prompt:"Generic fixture prompt\n한국어"};
    const driver={preflight:()=>actions.push("preflight"),getModel:()=>({identifier:"synthetic-model"}),newChat:()=>actions.push("new"),
      configure:job=>{actions.push(job.database);current={...job,path:join(conversationDir,job.token+".conversation.json")};put(current.path,chatFor(job.token,job.database));},
      prepare:job=>{const chat=json(current.path);chat.clientInput=job.prompt;put(current.path,chat);},
      submit:async job=>{
        actions.push("submit");const chat=finish(json(current.path),job.prompt);put(current.path,chat);
        const runDir=join(resultsRoot,current.token);mkdirSync(runDir);
        put(join(runDir,"run.json"),{run_id:current.token,conversation_path:current.path,status:"completed",all_tools_succeeded:true,
          database:{path:job.database,unchanged_since_baseline:true},model_capture:{state:"matched"}});
        for(const file of ["tools-summary.jsonl","tool-events.jsonl","model.log","model-response.md"])writeFileSync(join(runDir,file),"fixture");
        put(join(runDir,"model-response.json"),{});put(join(runDir,"conversation.json"),chat);writeFileSync(join(runDir,"prompt.txt"),job.prompt);
      }};
    const options={plan,driver,conversationDir,resultsRoot,batchesRoot,pollMs:1,prepareTimeoutMs:1000,timeoutMs:1000};
    await fn({dir,options,actions,driver,databases,current:()=>current});
    assert.deepEqual(await Promise.all(databases.map(snapshotDatabase)),before);
  } finally {rmSync(dir,{recursive:true});}
}
test("three databases use three empty chats and the same prompt, advancing only after archive completion",()=>fixture(async f=>{
  const result=await runBatch(f.options);assert.equal(result.status,"completed");
  assert.deepEqual(result.jobs.map(j=>j.database),f.databases);
  assert.equal(new Set(result.jobs.map(j=>j.token)).size,3);
  assert.deepEqual(result.jobs.map(j=>j.status),["completed","completed","completed"]);
  assert.deepEqual(f.actions,["preflight","new",f.databases[0],"submit","new",f.databases[1],"submit","new",f.databases[2],"submit"]);
  for(const job of result.jobs)assert.equal(readFileSync(join(job.result_path,"prompt.txt"),"utf8"),f.options.plan.prompt);
}));
test("selected subset runs in the user's order, not filename or folder order",()=>fixture(async f=>{
  const selected=[f.databases[2],f.databases[0]];
  const result=await runBatch({...f.options,plan:{...f.options.plan,databases:selected}});
  assert.deepEqual(result.jobs.map(job=>job.database),selected);
  assert.equal(f.actions.filter(action=>action==="new").length,2);
  assert.ok(!f.actions.includes(f.databases[1]));
  for(const job of result.jobs)assert.equal(readFileSync(join(job.result_path,"prompt.txt"),"utf8"),f.options.plan.prompt);
}));
test("Windows folder discovery filters direct DB files, sorts numbers and never changes file contents",{skip:process.platform!=="win32"},()=>{
  const dir=mkdtempSync(join(tmpdir(),"sherpa-folder-"));
  try {
    const names=["case10.sqlite","case2.SQLITE","case1.db","case3.sqlite3","notes.txt","case4.sqlite-wal"];
    for(const name of names)writeFileSync(join(dir,name),"untouched "+name);
    mkdirSync(join(dir,"nested"));writeFileSync(join(dir,"nested","hidden.sqlite"),"not selected");
    mkdirSync(join(dir,"directory.sqlite"));
    const binary=buildUi();
    const discover=folder=>JSON.parse(execFileSync(binary,["--list-folder",folder],{windowsHide:true,encoding:"utf8"}).replace(/^\uFEFF/,""));
    assert.deepEqual(discover(dir),["case1.db","case2.SQLITE","case3.sqlite3","case10.sqlite"].map(name=>join(dir,name)));
    for(const name of names)assert.equal(readFileSync(join(dir,name),"utf8"),"untouched "+name);
    const empty=join(dir,"empty");mkdirSync(empty);assert.deepEqual(discover(empty),[]);
    assert.throws(()=>execFileSync(binary,["--list-folder",join(dir,"missing")],{windowsHide:true,stdio:"pipe"}));
  } finally {rmSync(dir,{recursive:true});}
});
test("shipped Windows empty-chat gate accepts UIA blank newlines and protects real drafts/context",{skip:process.platform!=="win32"},()=>{
  const dir=dirname(buildUi());
  const executable=join(dir,"batch-ui-state-tests.exe");
  execFileSync(join(process.env.WINDIR,"Microsoft.NET","Framework64","v4.0.30319","csc.exe"),[
    "/nologo","/target:exe","/main:BatchUiStateTests","/out:"+executable,
    "/r:"+join(dir,"SherpaNativeUia.dll"),"/r:System.Windows.Forms.dll","/r:System.Drawing.dll","/r:System.Web.Extensions.dll",
    resolve("scripts/batch_ui.cs"),resolve("tests/batch_ui_state_tests.cs")
  ],{windowsHide:true,encoding:"utf8",timeout:60000});
  assert.match(execFileSync(executable,[],{windowsHide:true,encoding:"utf8",timeout:10000}),/12 empty-chat and draft-protection cases passed/);
});
test("invalid plan is rejected before any UI input",()=>fixture(async f=>{
  await assert.rejects(runBatch({...f.options,plan:{databases:["relative.sqlite"],prompt:"test"}}),/absolute/);
  assert.throws(()=>validatePlan({databases:f.databases,prompt:""}),/prompt/);assert.deepEqual(f.actions,[]);
}));
test("saved prompt must match before Send, including intentional whitespace",()=>fixture(async f=>{
  assert.equal(preparedPromptMatches({clientInput:"a\r\nb"},"a\nb"),true);
  assert.equal(preparedPromptMatches({clientInput:"a\n"},"a"),false);
  assert.equal(preparedPromptMatches({clientInput:" a"},"a"),false);
  f.driver.prepare=()=>{const chat=json(f.current().path);chat.clientInput="different draft";put(f.current().path,chat);};
  await assert.rejects(runBatch({...f.options,prepareTimeoutMs:50}),/Timed out/);
  assert.equal(f.actions.includes("submit"),false);
}));
test("configuration pointing to another DB never sends the prompt",()=>fixture(async f=>{
  const original=f.driver.configure;f.driver.configure=job=>original({...job,database:f.databases[1]});
  await assert.rejects(runBatch(f.options),/database changed/);assert.equal(f.actions.includes("submit"),false);
}));
test("separate native saves for run token and DB are awaited before preparing the prompt",()=>fixture(async f=>{
  let reads=0;
  const result=await runBatch({...f.options,findConversation:(dir,token)=>{
    const current=findBatchConversation(dir,token);
    if(current && ++reads===1){const lagging=structuredClone(current);lagging.chat.pluginConfigs["local/dfir-sherpa"].config.fields.find(f=>f.key==="databasePath").value=f.databases[1];return lagging;}
    return current;
  }});
  assert.equal(result.status,"completed");
  assert.equal(f.actions.filter(action=>action==="submit").length,3);
}));
test("interrupted first model response prevents the second case",()=>fixture(async f=>{
  const original=f.driver.submit;f.driver.submit=async job=>{await original(job);put(f.current().path,finish(json(f.current().path),job.prompt,"userStopped"));};
  await assert.rejects(runBatch(f.options),/interrupted/);assert.equal(f.actions.filter(a=>a==="new").length,1);
}));
test("uncertain submission is not automatically retried",()=>fixture(async f=>{
  f.driver.submit=()=>{f.actions.push("submit");throw Error("submission outcome unknown");};
  await assert.rejects(runBatch(f.options),/outcome unknown/);assert.equal(f.actions.filter(a=>a==="submit").length,1);
  const dir=readdirSync(f.options.batchesRoot).find(n=>n.startsWith("batch_"));
  const state=json(join(f.options.batchesRoot,dir,"batch.json"));
  assert.equal(state.status,"interrupted");assert.equal(state.jobs[1].status,"pending");assert.ok(state.jobs[0].conversation_path);
}));
test("new chat containing old messages is never submitted",()=>fixture(async f=>{
  const original=f.driver.configure;f.driver.configure=job=>{original(job);put(f.current().path,finish(json(f.current().path),"old prompt"));};
  await assert.rejects(runBatch(f.options),/not empty/);assert.equal(f.actions.includes("submit"),false);
}));
test("incomplete model log archive blocks advancement until it is complete",()=>fixture(async f=>{
  let attempts=0;
  const result=await runBatch({...f.options,findArchive:(...args)=>{attempts++;return attempts===1?null:completedArchive(...args);}});
  assert.equal(result.status,"completed");assert.equal(attempts,4);
}));
test("duplicate chat token and changed model both stop the batch",()=>fixture(async f=>{
  const token="duplicate",chat=chatFor(token,f.databases[0]);put(join(f.options.conversationDir,"a.conversation.json"),chat);put(join(f.options.conversationDir,"b.conversation.json"),chat);
  assert.throws(()=>findBatchConversation(f.options.conversationDir,token),/multiple chats/);
  const original=f.driver.configure;let n=0;f.driver.configure=job=>{original(job);if(++n===2){const changed=json(f.current().path);changed.lastUsedModel.identifier="different-model";put(f.current().path,changed);}};
  await assert.rejects(runBatch(f.options),/Model settings changed/);assert.equal(f.actions.filter(a=>a==="submit").length,1);
}));

test("identical-prompt input ambiguity is preserved while missing model outputs still block advancement",()=>fixture(async f=>{
  const original=f.driver.submit;
  f.driver.submit=async job=>{await original(job);const path=join(f.options.resultsRoot,job.token,"run.json"),run=json(path);
    run.model_capture={state:"partial_or_unavailable",missing_outputs:0,output_events:1,input_events:0};put(path,run);};
  const result=await runBatch(f.options);
  assert.equal(result.jobs[0].model_capture_at_completion.state,"partial_or_unavailable");
  const job=result.jobs[0],path=join(job.result_path,"run.json"),run=json(path);run.model_capture.missing_outputs=1;put(path,run);
  assert.equal(completedArchive(f.options.resultsRoot,job.conversation_path,job,f.options.plan.prompt),null);
}));

test("an empty native chat may omit lastUsedModel; loaded model identity is checked through the driver",()=>fixture(async f=>{
  const original=f.driver.configure;f.driver.configure=job=>{original(job);const chat=json(f.current().path);delete chat.lastUsedModel;put(f.current().path,chat);};
  assert.equal((await runBatch(f.options)).status,"completed");
}));
