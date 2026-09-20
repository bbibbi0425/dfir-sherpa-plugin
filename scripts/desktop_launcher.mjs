import {spawn} from "node:child_process";
import {existsSync,readFileSync,openSync,closeSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {homedir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {directory,readJson,writeJson,processIdentity,alive} from "./experiment_state.mjs";
import {defaultControlDir} from "../src/experimentBridge.mjs";
import {readLocalConfig} from "../src/localConfig.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export async function launchDesktop({resultsRoot=join(root,"outputs","results"),
  conversationDir=join(homedir(),".lmstudio","conversations"),
  appCommand=[join(process.env.LOCALAPPDATA??join(homedir(),"AppData","Local"),"Programs","LM Studio","LM Studio.exe")],
  loggerCommand=[join(homedir(),".lmstudio","bin","lms.exe")],controlDir=defaultControlDir(),timeoutMs=60000}={}) {
  resultsRoot=resolve(resultsRoot);conversationDir=resolve(conversationDir);
  if(existsSync(join(controlDir,"active-experiment.json")))throw Error("A manual experiment is active or needs recovery. Finish it before using automatic mode.");
  if(!existsSync(appCommand[0]))throw Error("LM Studio executable not found. Set app_command in outputs/launcher-settings.json.");
  directory(resultsRoot);directory(conversationDir);
  const stateDir=join(resultsRoot,".collector");directory(stateDir);
  const runtimePath=join(stateDir,"desktop-runtime.json"),lockPath=join(stateDir,"collector.lock");
  let existing=false,worker,workerError;
  if(existsSync(lockPath)) {
    const lock=readJson(lockPath);
    if(alive(lock.pid)) {
      const state=existsSync(runtimePath)?readJson(runtimePath):null;
      if(!state || state.collector?.pid!==lock.pid || processIdentity(lock.pid)?.fingerprint!==state.collector.fingerprint)
        throw Error("A different collector is already running. Stop the old collector before switching to desktop mode.");
      existing=true;
    }
  }
  if(!existing) {
    const settings=join(stateDir,"desktop-options.json");writeJson(settings,{logger_command:loggerCommand,control_dir:controlDir});
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    const out=openSync(join(stateDir,`desktop-${stamp}.log`),"wx"),err=openSync(join(stateDir,`desktop-${stamp}.stderr.log`),"wx");
    try {
      worker=spawn(process.execPath,[join(root,"scripts","collector.mjs"),"--desktop","--desktop-config",settings,
        "--results-root",resultsRoot,"--conversation-dir",conversationDir],
        {detached:true,windowsHide:true,stdio:["ignore",out,err],cwd:root});
      worker.on("error",error=>{workerError=error;});worker.unref();
    } finally {closeSync(out);closeSync(err);}
  }
  try {
  const app=spawn(appCommand[0],appCommand.slice(1),{detached:true,windowsHide:false,stdio:"ignore"});
  let appError;app.on("error",error=>{appError=error;});app.unref();
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    if(appError)throw appError;
    if(workerError)throw workerError;
    if(worker?.exitCode!==null && worker?.exitCode!==undefined)throw Error("Collector failed to start; see outputs/results/.collector desktop stderr log.");
    if(existsSync(runtimePath)) {
      const state=readJson(runtimePath);
      if(state.status==="ready" && Date.now()-Date.parse(state.heartbeat_at)<10000 &&
        (!worker || state.collector?.pid===worker.pid) && alive(state.collector.pid) && state.model_logger?.pid && alive(state.model_logger.pid)) {
        const result={status:"ready",reused:existing,results_root:resultsRoot,collector_pid:state.collector.pid,model_logger_pid:state.model_logger.pid};
        writeJson(join(stateDir,"launcher-ready.json"),{...result,at:new Date().toISOString()});return result;
      }
    }
    await delay(200);
  }
  throw Error("Collector/model stream did not become ready. Do not begin analysis; see outputs/results/.collector logs.");
  } catch(error) {
    if(worker?.pid) {
      if(existsSync(lockPath)) {
        const lock=readJson(lockPath);if(lock.pid===worker.pid)writeJson(join(stateDir,"stop.json"),{token:lock.token});
      } else worker.kill();
      for(let i=0;i<75 && worker.exitCode===null;i++)await delay(100);
      if(worker.exitCode===null)worker.kill();
    }
    throw error;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const settings=join(root,"outputs","launcher-settings.json");
  Promise.resolve().then(()=>{
    const value=existsSync(settings)?JSON.parse(readFileSync(settings,"utf8")):{};
    const local=readLocalConfig();
    if (!local) throw Error("Run setup.cmd first to install the plugin and launcher.");
    if (resolve(local.repository_path).toLowerCase() !== root.toLowerCase()) throw Error("Repository location changed. Run setup.cmd in this folder again.");
    return launchDesktop({appCommand:value.app_command ?? [local.app_path],loggerCommand:value.logger_command ?? [local.lms_path]});
  })
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{directory(join(root,"outputs"));writeJson(join(root,"outputs","launcher-error.json"),{at:new Date().toISOString(),message:error.message});console.error(error.message);process.exitCode=1;});
}
