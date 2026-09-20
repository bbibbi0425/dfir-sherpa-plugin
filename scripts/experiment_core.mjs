import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {setTimeout as delay} from "node:timers/promises";
import {readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, openSync, closeSync, realpathSync} from "node:fs";
import {join, resolve, dirname} from "node:path";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {Collector, inspectConversation, snapshotDatabase} from "./collector_core.mjs";
import {validRunId} from "../src/runIdentity.mjs";
import {defaultControlDir} from "../src/experimentBridge.mjs";
import {now, directory, regular, readJson, writeJson, processIdentity, stopOwned, paths, alive} from "./experiment_state.mjs";

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const workerScript=join(projectRoot,"scripts","experiment_worker.mjs");
const activePath=controlDir=>join(controlDir,"active-experiment.json");

function snapshotConversations(dir) {
  return Object.fromEntries(readdirSync(dir).filter(n=>n.endsWith(".conversation.json")).map(name=>{
    const path=join(dir,name);
    try{return [path,inspectConversation(readJson(path)).detected];}
    catch {return [path,true];} // Do not mistake unreadable pre-existing evidence for a new experiment.
  }));
}
function releaseActive(manifest) {
  const path=activePath(manifest.control_dir);
  if(existsSync(path) && readJson(path).token===manifest.token)unlinkSync(path);
}
function heartbeat(manifest,status) {
  const path=activePath(manifest.control_dir),previous=readJson(path);
  if(previous.token!==manifest.token)throw Error("Experiment ownership changed");
  writeJson(path,{run_id:manifest.run_id,run_dir:manifest.run_dir,token:manifest.token,status,
    pid:process.pid,heartbeat_at:now(),database_path:manifest.database?.path ?? null,
    SHERPA_RUN_ID:manifest.run_id,SHERPA_LOG_DIR:manifest.run_dir});
}
function selectConversation(manifest) {
  const matches=[];
  for(const name of readdirSync(manifest.conversation_dir)) {
    if(!name.endsWith(".conversation.json"))continue;
    const path=join(manifest.conversation_dir,name);
    if(manifest.initial_conversations[path])continue;
    try {
      const info=inspectConversation(readJson(path));
      if(info.detected && (info.markers.includes(manifest.run_id) || info.config.SHERPA_RUN_ID===manifest.run_id)) {
        if(manifest.database?.path && realpathSync(info.config.databasePath).toLowerCase()!==realpathSync(manifest.database.path).toLowerCase())
          throw Error("Conversation database differs from the experiment database");
        matches.push(path);
      }
    } catch(error) {if(!(error instanceof SyntaxError)&&error.code!=="ENOENT")throw error;}
  }
  if(matches.length>1)throw Error("Multiple conversations claimed this run ID; refusing ambiguous collection");
  if(manifest.conversation_path && matches[0] && matches[0]!==manifest.conversation_path)throw Error("Run already bound to another conversation");
  return matches[0] ?? manifest.conversation_path ?? null;
}
function collectorFor(manifest) {
  return new Collector({conversationDir:manifest.conversation_dir,resultsRoot:dirname(manifest.run_dir),
    idleMs:0,settleMs:500,experiment:{runId:manifest.run_id,conversationPath:null},
    onDiagnostic:event=>{
      appendFileSync(join(manifest.run_dir,"collector-events.jsonl"),JSON.stringify({timestamp:now(),...event})+"\n");
      if(event.event.endsWith("_error") || event.event==="conversation_directory_unavailable")throw Error(`${event.event}: ${event.message}`);
    }});
}
async function capture(collector,manifest) {
  collector.experiment.conversationPath=selectConversation(readJson(paths(manifest.run_dir).manifest));
  await collector.poll();
}
export async function finalizeExperiment(runDir,{startFailed=false,error=null}={}) {
  const p=paths(runDir),manifest=readJson(p.manifest),collector=collectorFor(manifest);
  collector.streamHealth={state:"stopped"};
  startFailed ||= manifest.status==="start_failed";
  let failure=error ?? manifest.capture_error ?? null;
  try {
    await capture(collector,manifest);await delay(550);await capture(collector,manifest);
  } catch(e){failure=failure?`${failure}; ${e.message}`:e.message;}
  const result=readJson(p.manifest);
  if(startFailed)result.status="start_failed";
  else if(failure || !["completed","interrupted"].includes(result.status))result.status="unknown";
  result.ended_at ??= now();result.collected_at=now();result.capture_error=failure;
  if(result.database?.path) {
    try {
      result.database.after=await snapshotDatabase(result.database.path);
      result.database.unchanged_since_baseline=result.database.before
        ? result.database.before.sha256===result.database.after.sha256 && JSON.stringify(result.database.before.sidecars)===JSON.stringify(result.database.after.sidecars) : null;
    } catch(e){result.database.error=e.message;result.database.unchanged_since_baseline=null;}
  }
  writeJson(p.manifest,result);
  return result;
}

export async function startExperiment({runId,resultsRoot=join(projectRoot,"outputs","results"),
  conversationDir=join(homedir(),".lmstudio","conversations"),controlDir=defaultControlDir(),db,
  loggerCommand=[join(homedir(),".lmstudio","bin",process.platform==="win32"?"lms.exe":"lms")],startupTimeoutMs=20000}) {
  if(!validRunId(runId))throw Error("Invalid --run-id; use 1..80 letters/digits/_/-");
  resultsRoot=resolve(resultsRoot);conversationDir=realpathSync(resolve(conversationDir));controlDir=resolve(controlDir);
  directory(resultsRoot);directory(controlDir);
  const runDir=join(realpathSync(resultsRoot),runId);
  if(existsSync(runDir))throw Error("Run ID already exists; no files were overwritten");
  if(existsSync(activePath(controlDir)))throw Error("An experiment is active or needs recovery; run experiment:stop with its run ID first");
  // Prevent a legacy always-on collector from racing this Run's archive writer.
  const legacyLock=join(resultsRoot,".collector","collector.lock");
  if(existsSync(legacyLock)&&alive(readJson(legacyLock).pid))throw Error("Stop the legacy collector first: npm run collector:stop");
  const database=db?{path:realpathSync(resolve(db)),baseline_scope:"experiment_start",before_captured_at:now()}:{};
  if(database.path)database.before=await snapshotDatabase(database.path);
  const token=randomUUID();
  writeFileSync(activePath(controlDir),JSON.stringify({run_id:runId,run_dir:runDir,token,status:"starting"}),{flag:"wx",mode:0o600});
  let child;
  try {
    mkdirSync(runDir);
    const manifest={format:"dfir-sherpa-experiment",version:1,run_id:runId,run_dir:runDir,token,status:"starting",
      started_at:now(),ended_at:null,control_dir:controlDir,conversation_dir:conversationDir,
      initial_conversations:snapshotConversations(conversationDir),database,
      environment:{SHERPA_RUN_ID:runId,SHERPA_LOG_DIR:runDir},logger_command:loggerCommand,startup_timeout_ms:startupTimeoutMs,
      model_capture:{state:"pending"}};
    writeJson(paths(runDir).manifest,manifest);
    for(const name of [`${runId}_tools.jsonl`,"tool-events.jsonl","model.log","model-response.md","prompt.txt"])
      writeFileSync(join(runDir,name),"",{flag:"wx",mode:0o600});
    const out=openSync(join(runDir,"collector.stdout.log"),"wx"),err=openSync(join(runDir,"collector.stderr.log"),"wx");
    try {
      child=spawn(process.execPath,[workerScript,runDir],{cwd:projectRoot,detached:true,windowsHide:true,
        stdio:["ignore",out,err],env:{...process.env,...manifest.environment}});
    } finally {closeSync(out);closeSync(err);}
    let spawnError;child.on("error",e=>{spawnError=e;});child.unref();
    const deadline=Date.now()+startupTimeoutMs+12000;
    while(Date.now()<deadline) {
      if(spawnError)throw spawnError;
      if(existsSync(paths(runDir).runtime)) {
        const runtime=readJson(paths(runDir).runtime);
        if(runtime.status==="ready" && alive(runtime.collector.pid) && alive(runtime.model_logger.pid))return {run_id:runId,run_dir:runDir,runtime};
        if(["failed","stopped"].includes(runtime.status))throw Error(runtime.error ?? "Collector stopped during startup");
      }
      if(child.exitCode!==null)throw Error("Collector exited before readiness");
      await delay(100);
    }
    throw Error("Timed out waiting for collector/model stream readiness");
  } catch(error) {
    if(existsSync(paths(runDir).manifest)) {
      try {await stopExperiment({runId,resultsRoot,startFailed:true});} catch(cleanup) {error.message+=`; cleanup: ${cleanup.message}`;}
    } else if(existsSync(activePath(controlDir)) && readJson(activePath(controlDir)).token===token)unlinkSync(activePath(controlDir));
    throw error;
  }
}

export async function stopExperiment({runId,resultsRoot=join(projectRoot,"outputs","results"),startFailed=false}) {
  if(!validRunId(runId))throw Error("Invalid --run-id");
  const runDir=join(resolve(resultsRoot),runId),p=paths(runDir),manifest=readJson(p.manifest);
  if(manifest.format!=="dfir-sherpa-experiment"||manifest.run_id!==runId||resolve(manifest.run_dir)!==runDir)throw Error("Invalid experiment manifest");
  writeJson(p.stop,{token:manifest.token,requested_at:now()});
  let runtime=existsSync(p.runtime)?readJson(p.runtime):null;
  const deadline=Date.now()+15000;
  while(runtime?.collector && alive(runtime.collector.pid) && !["failed","stopped"].includes(runtime.status) && Date.now()<deadline) {
    await delay(150);runtime=readJson(p.runtime);
  }
  // Birth time + executable fingerprint prevents killing a process that reused a saved PID.
  // Stop the producer before recovery, so the raw model spool is quiescent.
  stopOwned(runtime?.model_logger);stopOwned(runtime?.model_supervisor);stopOwned(runtime?.collector);
  for(let n=0;n<30 && runtime?.collector && alive(runtime.collector.pid);n++)await delay(100);
  if(runtime?.collector && alive(runtime.collector.pid))throw Error("Collector still running; refusing a concurrent recovery writer");
  const result=await finalizeExperiment(runDir,{startFailed});
  writeJson(p.runtime,{...runtime,status:startFailed?"failed":"stopped",stopped_at:now(),
    collector:runtime?.collector?{...runtime.collector,state:"stopped"}:null,
    model_supervisor:runtime?.model_supervisor?{...runtime.model_supervisor,state:"stopped"}:null,
    model_logger:runtime?.model_logger?{...runtime.model_logger,state:"stopped"}:null});
  releaseActive(manifest);
  return {run_id:runId,run_dir:runDir,status:result.status,capture_error:result.capture_error};
}

export async function runWorker(runDir) {
  const p=paths(runDir),manifest=readJson(p.manifest),collector=collectorFor(manifest);
  const runtime={status:"starting",started_at:now(),collector:{...processIdentity(process.pid),state:"running"},model_logger:null};
  writeJson(p.runtime,runtime);
  let child,streamReady=false,streamEnded=false,stopping=false,wasReady=false,stderr="",failure=null;
  const stop=()=>{stopping=true;};process.on("SIGINT",stop);process.on("SIGTERM",stop);
  try {
    child=spawn(process.execPath,[join(projectRoot,"scripts","experiment_model_logger.mjs"),runDir],
      {windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,...manifest.environment}});
    child.on("message",message=>{
      if(message?.type==="model_identity") {runtime.model_logger=message.identity;writeJson(p.runtime,runtime);}
    });
    child.on("error",e=>{failure=e.message;streamEnded=true;});
    child.on("close",()=>{streamEnded=true;});
    createInterface({input:child.stdout}).on("line",line=>collector.ingestModelLine(line));
    child.stderr.on("data",bytes=>{
      appendFileSync(join(runDir,"model-stream.stderr.log"),bytes);
      stderr=(stderr+bytes.toString("utf8")).slice(-8192);
      if(stderr.includes("Streaming logs from LM Studio"))streamReady=true;
    });
    await delay(100);
    if(child.pid)runtime.model_supervisor={...processIdentity(child.pid),state:"running"};
    writeJson(p.runtime,runtime);
    const deadline=Date.now()+manifest.startup_timeout_ms;
    while((!streamReady||!runtime.model_logger)&&!streamEnded&&Date.now()<deadline)await delay(100);
    if(!streamReady||!runtime.model_logger||streamEnded)throw Error(failure ?? `Model stream not ready: ${stderr.trim() || "timeout"}`);
    await delay(500);
    if(streamEnded)throw Error("Model logger exited during readiness check");
    collector.streamHealth={state:"running",pid:runtime.model_logger.pid};
    await capture(collector,manifest);
    runtime.status="ready";runtime.ready_at=now();runtime.model_logger.state="running";
    const readyManifest=readJson(p.manifest);
    if(readyManifest.status==="starting")readyManifest.status="running";
    readyManifest.ready_at=runtime.ready_at;writeJson(p.manifest,readyManifest);
    heartbeat(manifest,"ready");writeJson(p.runtime,runtime);wasReady=true;
    while(!stopping) {
      if(existsSync(p.stop)&&readJson(p.stop).token===manifest.token)break;
      if(streamEnded)throw Error("Model stream disconnected during experiment");
      heartbeat(manifest,"ready");
      await capture(collector,manifest);await delay(500);
    }
  } catch(error) {failure=error.message;}
  finally {
    stopping=true;
    try {heartbeat(manifest,"stopping");} catch { /* Preserve evidence if ownership was lost. */ }
    if(child && !streamEnded) {
      if(child.connected)child.send({type:"stop"});else child.kill();
      for(let n=0;n<50&&!streamEnded;n++)await delay(100);
      if(!streamEnded){stopOwned(runtime.model_logger);child.kill();}
    }
    await finalizeExperiment(runDir,{startFailed:!wasReady,error:failure});
    runtime.status=failure?"failed":"stopped";runtime.error=failure;runtime.stopped_at=now();
    runtime.collector.state="stopped";if(runtime.model_logger)runtime.model_logger.state="stopped";
    if(runtime.model_supervisor)runtime.model_supervisor.state="stopped";
    writeJson(p.runtime,runtime);releaseActive(manifest);
  }
}
