import {execFileSync,spawn} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join,dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {parseArgs} from "node:util";
import {createRequire} from "node:module";
import {directory,readJson,writeJson,alive} from "./experiment_state.mjs";
import {readLocalConfig} from "../src/localConfig.mjs";
import {launchDesktop} from "./desktop_launcher.mjs";
import {runBatch} from "./batch_core.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export function loadStudioSdk(pluginRoot=join(homedir(),".lmstudio","extensions","plugins","local","dfir-sherpa")) {
  // Resolve the package by name so Node honors its exports map. An absolute
  // directory require uses the legacy main field, which is invalid in SDK 1.4.0.
  try {return createRequire(join(pluginRoot,"package.json"))("@lmstudio/sdk");}
  catch(error) {throw new Error("Cannot load the installed LM Studio SDK. Run setup.cmd and retry. "+error.message,{cause:error});}
}
export function buildUi() {
  if(process.platform!=="win32")throw Error("The desktop batch launcher requires Windows.");
  const framework=join(process.env.WINDIR,"Microsoft.NET","Framework64","v4.0.30319");
  const source=join(root,"scripts","batch_ui.cs"),importerSource=join(root,"scripts","build_uia_interop.cs");
  const hash=createHash("sha256").update(readFileSync(source)).update(readFileSync(importerSource)).digest("hex").slice(0,16);
  const dir=join(root,"outputs",".batch-runtime",hash);directory(dir);const binary=join(dir,"batch-ui.exe");
  const interop=join(dir,"SherpaNativeUia.dll");
  if(!existsSync(interop)) {
    const importer=join(dir,"build-uia-interop.exe");
    execFileSync(join(framework,"csc.exe"),["/nologo","/target:exe","/out:"+importer,importerSource],{windowsHide:true,encoding:"utf8",timeout:60000});
    execFileSync(importer,[join(process.env.WINDIR,"System32","UIAutomationCore.dll"),interop],{windowsHide:true,encoding:"utf8",timeout:60000});
  }
  if(!existsSync(binary))execFileSync(join(framework,"csc.exe"),["/nologo","/target:exe","/out:"+binary,
    "/r:"+interop,"/r:System.Windows.Forms.dll","/r:System.Drawing.dll","/r:System.Web.Extensions.dll",source],
    {windowsHide:true,encoding:"utf8",timeout:60000});
  return binary;
}
export function uiDriver(binary,appPath,{execute=execFileSync}={}) {
  const call=(action,input={})=>{
    let raw;
    try {raw=execute(binary,[],{input:JSON.stringify({action,app_path:appPath,...input}),encoding:"utf8",windowsHide:true,timeout:30000,stdio:["pipe","pipe","pipe"]});}
    catch(error){
      let detail;
      try {detail=JSON.parse(String(error.stdout??"").replace(/^\uFEFF/,"")).error;} catch {}
      const stage=String(error.stderr??"").trim().split(/\r?\n/).filter(Boolean).at(-1);
      const reason=detail || (error.code==="ETIMEDOUT" ? "UI inspection timed out after 30 seconds" : error.message || "UI helper failed");
      throw new Error(`LM Studio UI ${action}: ${reason}${stage?`; ${stage}`:""}`,{cause:error});
    }
    let result;
    try {result=JSON.parse(String(raw).replace(/^\uFEFF/,""));}
    catch(error){throw new Error(`LM Studio UI ${action}: helper returned an empty or invalid response`,{cause:error});}
    if(result?.ok!==true)throw Error(`LM Studio UI ${action}: ${result?.error || "unexpected response"}`);
  };
  return {preflight:()=>call("preflight"),newChat:()=>call("new"),configure:input=>call("configure",input),prepare:input=>call("prepare",input),submit:input=>call("submit",input)};
}
export async function main(argv=process.argv.slice(2)) {
  const {values}=parseArgs({args:argv,options:{plan:{type:"string"},wizard:{type:"boolean"},stop:{type:"boolean"},"build-only":{type:"boolean"}}});
  const resultsRoot=join(root,"outputs","results"),batchesRoot=join(root,"outputs","batches");directory(batchesRoot);
  if(values.stop) {
    const lock=readJson(join(batchesRoot,"active.json"));writeJson(lock.stop_path,{requested_at:new Date().toISOString()});return {status:"stop_requested"};
  }
  const binary=buildUi();if(values["build-only"])return {binary};
  const local=readLocalConfig();if(!local || resolve(local.repository_path).toLowerCase()!==root.toLowerCase())throw Error("Run setup.cmd in this repository first.");
  let planPath=values.plan;
  if(values.wizard) {
    const plans=join(batchesRoot,"plans");directory(plans);planPath=join(plans,randomUUID()+".json");
    const exit=await new Promise((res,rej)=>{const child=spawn(binary,["--wizard",planPath,join(root,"outputs","batch-prompt.txt")],{stdio:"ignore",windowsHide:false});child.on("error",rej);child.on("exit",res);});
    if(exit===2)return {status:"cancelled"};if(exit!==0)throw Error("Batch configuration window failed.");
  }
  if(!planPath)throw Error("Use --wizard or --plan PATH.");
  const {LMStudioClient}=loadStudioSdk();
  await launchDesktop({appCommand:[local.app_path],loggerCommand:[local.lms_path]});
  const client=new LMStudioClient();
  const driver=uiDriver(binary,local.app_path);
  driver.getModel=async()=>{
    const models=await client.llm.listLoaded();if(models.length!==1)throw Error("Load exactly one experiment model in LM Studio.");
    const info=await models[0].getModelInfo();
    return {identifier:info.identifier,path:info.path,context_length:await models[0].getContextLength()};
  };
  const ensureReady=()=>{
    const runtime=readJson(join(resultsRoot,".collector","desktop-runtime.json"));
    if(runtime.status!=="ready" || Date.now()-Date.parse(runtime.heartbeat_at)>15000 || !alive(runtime.collector.pid) || !alive(runtime.model_logger.pid))
      throw Error("Collector/model logger is not ready. Batch stopped.");
  };
  return runBatch({plan:readJson(resolve(planPath)),driver,
    conversationDir:join(homedir(),".lmstudio","conversations"),resultsRoot,batchesRoot,ensureReady,
    onProgress:state=>writeJson(join(batchesRoot,"latest.json"),{batch_id:state.batch_id,status:state.status,error:state.error,
      jobs:state.jobs.map(({index,database,status,result_path})=>({index,database,status,result_path}))})});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main()
  // The SDK's live connection must not keep the launcher waiting after the batch ends.
  .then(result=>process.stdout.write(JSON.stringify(result)+"\n",()=>process.exit(0)))
  .catch(error=>{directory(join(root,"outputs"));writeJson(join(root,"outputs","batch-error.json"),{at:new Date().toISOString(),error:error.message});process.stderr.write(error.message+"\n",()=>process.exit(1));});
