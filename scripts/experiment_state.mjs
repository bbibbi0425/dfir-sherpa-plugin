import {readFileSync, writeFileSync, lstatSync, existsSync, mkdirSync} from "node:fs";
import {replaceFile} from "./atomic_file.mjs";
import {randomUUID, createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {join} from "node:path";

export const now = () => new Date().toISOString();
export function regular(path) {
  const st=lstatSync(path);
  if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1)throw Error(`Refusing linked/nonregular file: ${path}`);
  return st;
}
export function directory(path) {
  mkdirSync(path,{recursive:true});
  const st=lstatSync(path);
  if(!st.isDirectory() || st.isSymbolicLink())throw Error(`Refusing linked directory: ${path}`);
}
export function readJson(path) {regular(path);return JSON.parse(readFileSync(path,"utf8"));}
export function writeJson(path,value) {
  if(existsSync(path))regular(path);
  const temp=path+"."+randomUUID()+".tmp";
  writeFileSync(temp,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});replaceFile(temp,path);
}
export function processIdentity(pid) {
  if(!Number.isInteger(pid)||pid<1)throw Error("Invalid process ID");
  let identity;
  if(process.platform==="win32") {
    const command=`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{started=$p.StartTime.ToUniversalTime().ToString('o'); executable=$p.Path} | ConvertTo-Json -Compress}else{exit 0}`;
    const raw=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true,encoding:"utf8",timeout:10000}).trim();
    if(!raw)return null;
    identity=JSON.parse(raw);
    if(!identity.started || !identity.executable)throw Error("Cannot verify process creation identity");
  } else {
    try {
      const stat=readFileSync(`/proc/${pid}/stat`,"utf8");
      identity={started:stat.slice(stat.lastIndexOf(")")+2).split(" ")[19],command:readFileSync(`/proc/${pid}/cmdline`,"utf8")};
    } catch(error) {if(error.code==="ENOENT")return null;throw error;}
  }
  return {pid,fingerprint:createHash("sha256").update(JSON.stringify(identity)).digest("hex")};
}
export function alive(pid) {try{process.kill(pid,0);return true;}catch(e){if(e.code==="ESRCH")return false;throw e;}}
export function stopOwned(identity) {
  if(!identity)return;
  const current=processIdentity(identity.pid);
  if(!current)return;
  if(current.fingerprint!==identity.fingerprint)throw Error("PID was reused; refusing to terminate an unrelated process");
  process.kill(identity.pid);
}
export function paths(runDir) {return {manifest:join(runDir,"run.json"),runtime:join(runDir,"runtime.json"),stop:join(runDir,"stop-request.json")};}
