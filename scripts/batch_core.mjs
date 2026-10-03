import {existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, unlinkSync} from "node:fs";
import {join, isAbsolute, resolve} from "node:path";
import {randomUUID, createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import {directory, readJson, writeJson, alive} from "./experiment_state.mjs";
import {inspectConversation, snapshotDatabase} from "./collector_core.mjs";
import {openTimelineDatabase} from "../src/timelineSchema.mjs";

const PLUGIN="local/dfir-sherpa";
const samePath=(a,b)=>typeof a==="string" && typeof b==="string" && resolve(a).toLowerCase()===resolve(b).toLowerCase();
const textHash=text=>createHash("sha256").update(text).digest("hex");
const cleanText=text=>text.replace(/\r\n/g,"\n");

export function validatePlan(plan) {
  if (!plan || typeof plan.prompt!=="string" || !plan.prompt.trim() || plan.prompt.length>100000)
    throw Error("Enter a common prompt (1..100000 characters).");
  if (!Array.isArray(plan.databases) || !plan.databases.length || plan.databases.length>100)
    throw Error("Select 1..100 databases in the desired order.");
  const databases=plan.databases.map(path=>{
    if(typeof path!=="string" || !isAbsolute(path))throw Error("All database paths must be absolute.");
    const canonical=realpathSync(path),db=openTimelineDatabase(canonical);db.close();return canonical;
  });
  return {databases,prompt:plan.prompt};
}

function conversations(dir) {
  return readdirSync(dir).filter(name=>name.endsWith(".conversation.json")).map(name=>join(dir,name));
}
function configOf(chat) {return Object.fromEntries((chat.pluginConfigs?.[PLUGIN]?.config?.fields??[]).map(f=>[f.key,f.value]));}
export function findBatchConversation(dir,token) {
  const matches=[];
  for(const path of conversations(dir)) {
    try {const chat=readJson(path);if(configOf(chat).SHERPA_RUN_ID===token)matches.push({path,chat});}
    catch(error){if(error instanceof SyntaxError || error.code==="ENOENT")continue;throw error;}
  }
  if(matches.length>1)throw Error("Batch token appears in multiple chats; refusing ambiguous execution.");
  return matches[0]??null;
}
export function verifyConversation(chat,job,prompt,{empty=false}={}) {
  const config=configOf(chat);
  if(config.SHERPA_RUN_ID!==job.token || !samePath(config.databasePath,job.database))throw Error("Chat identity or database changed. Batch stopped.");
  if(!Array.isArray(chat.plugins) || chat.plugins.length!==1 || chat.plugins[0]!==PLUGIN)
    throw Error("Enable only local/dfir-sherpa for a batch experiment.");
  if(empty && chat.messages?.length)throw Error("The target chat is not empty. No prompt was sent.");
  const info=inspectConversation(chat);
  if(!empty && (info.prompts.length>1 || info.prompts.some(p=>cleanText(p)!==cleanText(prompt))))
    throw Error("Chat prompt differs from this batch. Batch stopped.");
  return info;
}
export function preparedPromptMatches(chat,prompt) {
  return typeof chat.clientInput==="string" && cleanText(chat.clientInput)===cleanText(prompt);
}
export function completedArchive(resultsRoot,conversationPath,job,prompt) {
  const matches=[];
  for(const entry of readdirSync(resultsRoot,{withFileTypes:true})) {
    if(!entry.isDirectory() || entry.name.startsWith("."))continue;
    const dir=join(resultsRoot,entry.name),file=join(dir,"run.json");
    if(!existsSync(file))continue;
    const run=readJson(file);
    if(samePath(run.conversation_path,conversationPath))matches.push({run,dir});
  }
  if(matches.length>1)throw Error("Multiple Run archives matched the same conversation.");
  if(!matches.length)return null;
  const {run,dir}=matches[0];
  if(run.database?.path_changed || (run.database?.path && !samePath(run.database.path,job.database)))throw Error("Run database mismatch.");
  if(run.status==="interrupted")throw Error("Run interrupted; remaining databases were not started.");
  if(run.status!=="completed")return null;
  if(run.database?.unchanged_since_baseline!==true || !run.all_tools_succeeded)throw Error("Run integrity/Tool completion was not verified.");
  const capture=run.model_capture;
  // Identical prompts can make input attribution ambiguous in the unchanged Collector.
  // Wait for all matching output/statistics events, but preserve its explicit input warning.
  if(capture?.state!=="matched" && !(capture?.missing_outputs===0 && capture?.output_events>0))return null;
  for(const name of ["run.json","prompt.txt","tools-summary.jsonl","tool-events.jsonl","model.log","model-response.md","model-response.json","conversation.json"])
    if(!existsSync(join(dir,name)))return null;
  if(cleanText(readFileSync(join(dir,"prompt.txt"),"utf8"))!==cleanText(prompt))throw Error("Archived prompt mismatch.");
  verifyConversation(readJson(join(dir,"conversation.json")),job,prompt);
  return {run_id:run.run_id,path:dir,model_capture:capture};
}

/** UI is injected. Only new chats are configured; original chat files are read, never written. */
export async function runBatch({plan,driver,conversationDir,resultsRoot,batchesRoot,
  pollMs=1000,timeoutMs=7200000,prepareTimeoutMs=30000,ensureReady=async()=>{},sleep=delay,
  snapshot=snapshotDatabase,findConversation=findBatchConversation,findArchive=completedArchive,onProgress=()=>{}}) {
  const input=validatePlan(plan);
  directory(batchesRoot);directory(resultsRoot);
  const lockPath=join(batchesRoot,"active.json");
  if(existsSync(lockPath)) {
    const old=readJson(lockPath);
    if(!Number.isInteger(old.pid)||old.pid<1)throw Error("Invalid batch lock.");
    if(alive(old.pid))throw Error("A batch is already running.");
    // A stopped batch is never automatically resent. Preserve uncertain submission state.
    if(old.manifest && existsSync(old.manifest)) {
      const previous=readJson(old.manifest);
      if(previous.status==="running") {previous.status="interrupted";previous.error="Runner exited; inspect the recorded chat before retrying.";writeJson(old.manifest,previous);}
    }
    unlinkSync(lockPath);
  }
  const id="batch_"+new Date().toISOString().replace(/[-:.TZ]/g,"")+"_"+randomUUID().slice(0,8);
  const dir=join(batchesRoot,id);directory(dir);
  const manifest=join(dir,"batch.json"),stopPath=join(dir,"stop.json");
  const state={batch_id:id,status:"running",started_at:new Date().toISOString(),prompt_sha256:textHash(input.prompt),
    jobs:input.databases.map((database,index)=>({index,database,token:"batch_"+randomUUID().replaceAll("-",""),status:"pending"}))};
  writeFileSync(join(dir,"prompt.txt"),input.prompt,{flag:"wx"});
  writeFileSync(lockPath,JSON.stringify({pid:process.pid,manifest,stop_path:stopPath}),{flag:"wx"});
  const persist=()=>{writeJson(manifest,state);try{onProgress(state);}catch{}};
  const check=()=>{if(existsSync(stopPath))throw Error("Batch stopped by user; current chat and results are preserved.");};
  const waitFor=async(fn,deadline,timeoutMessage="Timed out; remaining databases were not started.")=>{while(Date.now()<deadline){check();await ensureReady();const value=await fn();if(value)return value;await sleep(pollMs);}throw Error(timeoutMessage);};
  persist();
  try {
    await ensureReady();await driver.preflight();
    let model=null,chatSettings=null;
    for(const job of state.jobs) {
      check();job.before=await snapshot(job.database);job.status="preparing";persist();
      await driver.newChat();check();await driver.configure({token:job.token,database:job.database});
      const found=await waitFor(()=>{
        const current=findConversation(conversationDir,job.token);
        // The token and DB edits can be persisted in separate native saves.
        // Wait for both before applying the strict identity/empty-chat checks.
        return current && samePath(configOf(current.chat).databasePath,job.database)?current:null;
      },Date.now()+prepareTimeoutMs,"Chat database changed or its configuration was not saved. No prompt was sent.");
      verifyConversation(found.chat,job,input.prompt,{empty:true});
      // LM Studio may omit lastUsedModel on an empty chat. Read the loaded model via SDK.
      const currentModel=await driver.getModel();
      if(!currentModel?.identifier)throw Error("No model recorded for the new chat. Load your experiment model first.");
      if(model && !isDeepStrictEqual(model,currentModel))throw Error("Model settings changed between chats.");
      if(found.chat.lastUsedModel?.identifier && found.chat.lastUsedModel.identifier!==currentModel.identifier)throw Error("Model settings changed between chats.");
      const settings={preset:found.chat.preset??null,system_prompt:found.chat.systemPrompt??"",
        per_chat:found.chat.usePerChatPredictionConfig??false,prediction:found.chat.perChatPredictionConfig??null};
      if(chatSettings && !isDeepStrictEqual(chatSettings,settings))throw Error("Chat prediction/system prompt settings changed between cases.");
      chatSettings??=settings;state.chat_settings=chatSettings;
      model??=currentModel;state.model=model;
      job.conversation_path=found.path;
      if(driver.prepare) {
        job.status="preparing_prompt";persist();
        await driver.prepare({token:job.token,database:job.database,prompt:input.prompt});
        await waitFor(()=>{
          const current=findConversation(conversationDir,job.token);
          if(!current)return null;
          if(!samePath(current.path,job.conversation_path))throw Error("Prepared chat identity changed.");
          verifyConversation(current.chat,job,input.prompt,{empty:true});
          return preparedPromptMatches(current.chat,input.prompt);
        },Date.now()+prepareTimeoutMs);
      }
      job.status="submitting";persist();
      // Never retry this action: a crash here leaves an explicitly uncertain submission.
      await driver.submit({token:job.token,database:job.database,prompt:input.prompt});
      job.status="running";persist();
      const archive=await waitFor(async()=>{
        const current=findConversation(conversationDir,job.token);
        if(!current)return null; // LM Studio may be replacing/serializing its file right now.
        if(!samePath(current.path,job.conversation_path))throw Error("Active batch conversation changed.");
        const info=verifyConversation(current.chat,job,input.prompt);
        if(info.generations.some(g=>g.identifier && g.identifier!==model.identifier))throw Error("The generation used a different model.");
        if(info.status==="interrupted")throw Error("Model/Tool execution interrupted. Batch stopped.");
        for(const result of info.results) {
          try {if(JSON.parse(result.event.content).ok===false)throw Error("A retrieval Tool returned an error. Batch stopped.");}
          catch(error){if(!(error instanceof SyntaxError))throw error;}
        }
        // Approval settings are not modified. Ask-mode pauses require the user's confirmation.
        if(info.events.some(e=>e.event.type==="toolStatus" && e.event.statusState?.status?.type==="confirmingToolCall")) {
          job.waiting_for_tool_approval=true;persist();
        }
        if(info.status!=="completed")return null;
        return findArchive(resultsRoot,job.conversation_path,job,input.prompt);
      },Date.now()+timeoutMs);
      job.after=await snapshot(job.database);
      if(!isDeepStrictEqual(job.before,job.after))throw Error("Database changed during the batch Run.");
      job.run_id=archive.run_id;job.result_path=archive.path;job.model_capture_at_completion=archive.model_capture;
      job.status="completed";job.finished_at=new Date().toISOString();persist();
    }
    state.status="completed";
  } catch(error) {
    state.status="interrupted";state.error=error.message;
    const current=state.jobs.find(j=>!["completed","pending"].includes(j.status));
    if(current)current.status="interrupted";
    throw error;
  } finally {
    state.finished_at=new Date().toISOString();persist();
    if(existsSync(lockPath) && readJson(lockPath).manifest===manifest)unlinkSync(lockPath);
  }
  return {manifest,...state};
}
