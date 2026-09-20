import {execFileSync} from "node:child_process";
import {existsSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, resolve, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import {localConfigPath, readLocalConfig} from "../src/localConfig.mjs";
import {directory, regular, readJson, writeJson, alive, processIdentity} from "./experiment_state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedPlugin = () => join(homedir(),".lmstudio","extensions","plugins","local","dfir-sherpa");

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {cwd:root, windowsHide:true, encoding:"utf8", timeout:600000, maxBuffer:8*1024*1024, ...options});
}
export function shortcut(action, repository = root, previousRepository = repository) {
  return command(join(process.env.SystemRoot || "C:\\Windows", "System32", "cscript.exe"),
    ["//nologo", join(root,"scripts","setup-shortcut.vbs"), action, repository, previousRepository]);
}

// Stop only the collector whose PID identity and lock token agree. Never stop LM Studio.
export async function stopCollector(repository) {
  const stateDir = join(repository,"outputs","results",".collector"), lockPath = join(stateDir,"collector.lock");
  if (!existsSync(lockPath)) return;
  const lock = readJson(lockPath);
  if (!Number.isInteger(lock.pid) || lock.pid < 1) throw Error("Invalid collector lock; inspect runtime state before setup.");
  if (!alive(lock.pid)) return;
  const runtime = readJson(join(stateDir,"desktop-runtime.json"));
  if (runtime.token !== lock.token || runtime.collector?.pid !== lock.pid ||
      runtime.collector.fingerprint !== processIdentity(lock.pid)?.fingerprint) throw Error("Cannot verify collector ownership; close the active experiment before setup.");
  writeJson(join(stateDir,"stop.json"), {token:lock.token});
  for (let i=0;i<150;i++) {
    if (!alive(lock.pid)) return;
    await delay(100);
  }
  throw Error("Collector has not stopped. Configuration was not changed; retry after it exits.");
}

export async function install({appPath, lmsPath = join(homedir(),".lmstudio","bin","lms.exe"),
  repository = root, configPath = localConfigPath(), run = command, link = shortcut, stop = stopCollector} = {}) {
  const existing = readLocalConfig(configPath);
  for (const [label,path] of [["LM Studio",appPath],["LM Studio CLI",lmsPath]]) {
    if (!path || !isAbsolute(path) || !existsSync(path)) throw Error(`${label} not found. Install and open LM Studio first.`);
  }
  const help = run(lmsPath,["dev","--help"],{timeout:30000});
  if (!help.includes("--install") || !help.includes("--yes")) throw Error("LM Studio CLI does not support local plugin installation. Update LM Studio.");
  // A different application with the same shortcut name is never overwritten.
  link("check", repository, existing?.repository_path || repository);
  await stop(existing?.repository_path || repository);
  if (existing && resolve(existing.repository_path) !== resolve(repository)) await stop(repository);
  if (existsSync(join(homedir(),".lmstudio","dfir-sherpa","active-experiment.json"))) throw Error("Finish/recover the manual experiment before changing setup.");
  const output = run(lmsPath,["dev","--install","--yes"],{cwd:repository});
  const config = {application:"dfir-sherpa",version:1,
    repository_path:resolve(repository),app_path:appPath,lms_path:lmsPath,configured_at:new Date().toISOString()};
  directory(dirname(configPath));
  try { link("create", repository, existing?.repository_path || repository); }
  catch (error) { throw Error(`Plugin installed, but shortcut creation failed: ${error.message}. Configuration was not changed. Retry setup.cmd.`); }
  writeJson(configPath, config);
  return {status:"installed",config_path:configPath,results_root:join(repository,"outputs","results"),installer_output:output};
}

export function removeInstalledPlugin(path = installedPlugin()) {
  if (!existsSync(path)) return;
  // Refuse links at every ancestor before a recursive deletion.
  for (let current=resolve(path);;) {
    if (lstatSync(current).isSymbolicLink()) throw Error("Refusing to remove a linked plugin directory.");
    const parent=dirname(current); if (parent===current) break; current=parent;
  }
  const manifest=readJson(join(path,"manifest.json"));
  if (manifest.owner !== "local" || manifest.name !== "dfir-sherpa" || manifest.type !== "plugin") throw Error("Installed plugin identity mismatch; no files removed.");
  if (resolve(path).toLowerCase() !== realpathSync(path).toLowerCase()) throw Error("Plugin directory resolved to an unexpected location.");
  rmSync(path,{recursive:true});
}

export async function reset({uninstall=false,configPath=localConfigPath(),link=shortcut,stop=stopCollector,removePlugin=removeInstalledPlugin}={}) {
  const config=readLocalConfig(configPath);
  const repository=config?.repository_path || root;
  link("check",repository);
  await stop(repository);
  if (existsSync(join(homedir(),".lmstudio","dfir-sherpa","active-experiment.json"))) throw Error("Finish/recover the manual experiment first.");
  if (uninstall) {
    removePlugin(); link("remove",repository);
  }
  if (existsSync(configPath)) { regular(configPath); unlinkSync(configPath); }
  return {status:uninstall?"uninstalled":"reset",preserved:"Databases, results, models and conversations"};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values,positionals}=parseArgs({allowPositionals:true, options:{request:{type:"string"},app:{type:"string"}}});
  const action=positionals[0];
  Promise.resolve().then(async()=>{
    if (action === "install") {
      let appPath=values.app;
      if(values.request) {
        regular(values.request);
        const parts=readFileSync(values.request,"utf16le").replace(/^\uFEFF/,"").split(/\r?\n/);
        [appPath]=parts;
      }
      appPath ||= join(process.env.LOCALAPPDATA || join(homedir(),"AppData","Local"),"Programs","LM Studio","LM Studio.exe");
      return install({appPath});
    }
    if (action === "reset" || action === "uninstall") return reset({uninstall:action === "uninstall"});
    throw Error("Expected install, reset or uninstall.");
  }).then(result=>{directory(join(root,"outputs"));writeJson(join(root,"outputs","setup-result.json"),result);console.log(result.status);})
    .catch(error=>{directory(join(root,"outputs"));writeJson(join(root,"outputs","setup-error.json"),{at:new Date().toISOString(),message:error.message});console.error(error.message);process.exitCode=1;});
}
