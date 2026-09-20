import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, watch, existsSync, unlinkSync } from "node:fs";
import { Collector } from "./collector_core.mjs";
import { defaultControlDir } from "../src/experimentBridge.mjs";
import { directory, writeJson, processIdentity } from "./experiment_state.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {values} = parseArgs({options:{
  "conversation-dir":{type:"string"}, "results-root":{type:"string"}, lms:{type:"string"},
  "poll-ms":{type:"string"}, "idle-ms":{type:"string"}, "settle-ms":{type:"string"},
  once:{type:"boolean"}, "no-model-stream":{type:"boolean"}, stop:{type:"boolean"}, help:{type:"boolean"},
  desktop:{type:"boolean"}, "desktop-config":{type:"string"},
}});
if (values.help) {
  console.log("DFIR Sherpa always-on collector\nOptions: --conversation-dir DIR --results-root DIR --lms EXE --poll-ms 1000 --idle-ms 120000 --settle-ms 3000 --once --no-model-stream --stop\nDefault: watch native LM Studio chats and stream model input/output/stats. Ctrl+C stops this collector only.");
} else {
  const root = resolve(values["results-root"] ?? join(projectRoot,"outputs","results"));
  if (values.stop) {
    const lock = JSON.parse(readFileSync(join(root,".collector","collector.lock"),"utf8"));
    writeFileSync(join(root,".collector","stop.json"),JSON.stringify({token:lock.token}));
    console.log("Stop requested for this collector.");
  } else {
    if (existsSync(join(defaultControlDir(),"active-experiment.json"))) throw Error("An experiment is active or needs recovery; stop it before running the legacy collector");
    const numeric = (key,fallback) => {
      const n = Number(values[key] ?? fallback);
      if (!Number.isFinite(n) || n < 0 || (key === "poll-ms" && n < 100)) throw Error(`Invalid ${key}`);
      return n;
    };
    const report = event => console.log(JSON.stringify({timestamp:new Date().toISOString(),...event}));
    const collector = new Collector({conversationDir:values["conversation-dir"] ?? join(homedir(),".lmstudio","conversations"),
      resultsRoot:root,idleMs:numeric("idle-ms",120000),settleMs:numeric("settle-ms",3000),onDiagnostic:report,desktop:values.desktop});
    collector.acquire();
    let stopping = false, child, watcher, wake, nextStreamStart = 0;
    const ownIdentity=values.desktop?processIdentity(process.pid):null;
    let loggerIdentity=null,supervisorIdentity=null,streamAnnounced=false;
    const runtimePath=join(collector.stateDir,"desktop-runtime.json");
    const desktopConfig=values["desktop-config"]?JSON.parse(readFileSync(values["desktop-config"],"utf8")):{};
    const desktopControlDir=desktopConfig.control_dir??defaultControlDir();
    function runtime() {
      if(values.desktop)writeJson(runtimePath,{mode:"desktop_auto",status:stopping?"stopped":collector.streamHealth.state==="running"?"ready":"starting",
        heartbeat_at:new Date().toISOString(),collector:ownIdentity,model_logger:loggerIdentity,model_supervisor:supervisorIdentity,
        stream:collector.streamHealth,token:collector.lockToken});
      if(values.desktop && !stopping) {
        directory(desktopControlDir);
        writeJson(join(desktopControlDir,"desktop-collector.json"),{mode:"desktop_auto",status:collector.streamHealth.state==="running"?"ready":"starting",
          pid:process.pid,heartbeat_at:new Date().toISOString(),results_root:root,token:collector.lockToken});
      }
    }
    const stop = () => {stopping=true; wake?.();};
    process.on("SIGINT",stop); process.on("SIGTERM",stop);
    function startStream() {
      const lms = values.lms ?? join(homedir(),".lmstudio","bin",process.platform === "win32" ? "lms.exe" : "lms");
      const args = ["log","stream","--source","model","--filter","input,output","--stats","--json"];
      streamAnnounced=false;loggerIdentity=null;
      if(values.desktop) {
        const session=join(collector.stateDir,"stream-"+collector.lockToken);
        directory(session);
        writeJson(join(session,"run.json"),{logger_command:desktopConfig.logger_command??[lms],environment:{}});
        child=spawn(process.execPath,[join(projectRoot,"scripts","experiment_model_logger.mjs"),session],
          {windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
        child.on("message",message=>{
          if(message?.type==="model_identity") {loggerIdentity=message.identity;if(streamAnnounced)collector.streamHealth.state="running";}
        });
        supervisorIdentity=child.pid?processIdentity(child.pid):null;
      } else child = spawn(lms,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
      const processRef = child;
      collector.streamHealth = {state:"starting",started_at:new Date().toISOString(),command:[lms,...args]};
      child.once("spawn",() => {if(!values.desktop)collector.streamHealth.state="running";});
      createInterface({input:child.stdout}).on("line",line => collector.ingestModelLine(line));
      let streamStderr="";
      child.stderr.on("data",chunk => {
        streamStderr=(streamStderr+chunk.toString("utf8")).slice(-4096);
        collector.streamHealth.last_stderr=streamStderr;
        if(streamStderr.includes("Streaming logs from LM Studio")) {
          streamAnnounced=true;if(loggerIdentity)collector.streamHealth.state="running";
        }
      });
      child.once("error",error => {collector.streamHealth={state:"error",error:error.message};report({event:"model_stream_error",message:error.message});});
      child.once("close",code => {
        if (child === processRef) child=undefined;
        collector.streamHealth={...collector.streamHealth,state:stopping?"stopped":"disconnected",exit_code:code};
        nextStreamStart=Date.now()+5000;
      });
    }
    try {
      try { watcher=watch(collector.conversationDir,()=>wake?.()); watcher.on("error",()=>{}); } catch { /* Polling also handles a directory created later. */ }
      if (values["no-model-stream"]) collector.streamHealth={state:"disabled"}; else startStream();
      report({event:"collector_started",pid:process.pid,results_root:root});
      do {
        if (!values["no-model-stream"] && !child && Date.now() >= nextStreamStart) startStream();
        await collector.poll();
        runtime();
        if (values.once || collector.stopRequested()) break;
        if (!stopping) await new Promise(resolveWait => {
          const timer=setTimeout(() => {wake=undefined;resolveWait();},numeric("poll-ms",1000));
          wake=() => {clearTimeout(timer);wake=undefined;resolveWait();};
        });
      } while (!stopping);
    } finally {
      stopping=true; watcher?.close();
      if(child?.connected) {
        child.send({type:"stop"});
        await Promise.race([new Promise(resolveClose=>child.once("close",resolveClose)),new Promise(resolveWait=>setTimeout(resolveWait,5000))]);
      } else child?.kill();
      collector.streamHealth.state="stopped";runtime();
      const modePath=join(desktopControlDir,"desktop-collector.json");
      if(values.desktop && existsSync(modePath) && JSON.parse(readFileSync(modePath,"utf8")).token===collector.lockToken)unlinkSync(modePath);
      collector.release(); report({event:"collector_stopped"});
    }
  }
}
