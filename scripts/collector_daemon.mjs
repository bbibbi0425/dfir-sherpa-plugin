import {spawn, spawnSync} from "node:child_process";
import {mkdirSync, openSync, closeSync} from "node:fs";
import {dirname, resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const script=join(root,"scripts","collector.mjs");
if(process.argv.includes("--stop")) {
  const result=spawnSync(process.execPath,[script,"--stop"],{windowsHide:true,stdio:"inherit",cwd:root});
  process.exitCode=result.status??1;
} else {
  const dir=join(root,"outputs","results",".collector");
  mkdirSync(dir,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,"-")+"-"+process.pid;
  const out=openSync(join(dir,`daemon-${stamp}.log`),"wx",0o600);
  const err=openSync(join(dir,`daemon-${stamp}.stderr.log`),"wx",0o600);
  const child=spawn(process.execPath,[script],{detached:true,windowsHide:true,stdio:["ignore",out,err],cwd:root});
  child.once("error",error=>{console.error(error.message);process.exitCode=1;});
  child.once("spawn",()=>console.log(JSON.stringify({collector_pid:child.pid,logs:dir})));
  child.unref();closeSync(out);closeSync(err);
}
