// Supervise lms with an IPC lifeline: a collector crash must not leave a new logger orphan.
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {readJson,paths,processIdentity} from "./experiment_state.mjs";
const manifest=readJson(paths(process.argv[2]).manifest);
let child,stopping=false,closed=false;
function stop() {stopping=true;child?.kill();if(!child)process.disconnect?.();}
process.on("disconnect",stop);
process.stdout.on("error",stop);process.stderr.on("error",stop);
process.on("message",message=>{if(message?.type==="stop")stop();});
process.on("SIGINT",stop);process.on("SIGTERM",stop);
async function main() {
  if(!process.connected)return;
  const [exe,...prefix]=manifest.logger_command;
  const args=[...prefix,"log","stream","--source","model","--filter","input,output","--stats","--json"];
  child=spawn(exe,args,{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,...manifest.environment}});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  child.on("error",error=>{console.error(error.message);closed=true;process.exitCode=1;if(process.connected)process.disconnect();});
  child.on("close",code=>{closed=true;process.exitCode=stopping?0:(code??1);if(process.connected)process.disconnect();});
  await delay(100);
  if(!closed&&child.pid) {
    const identity=processIdentity(child.pid);
    if(identity&&process.connected)process.send({type:"model_identity",identity:{...identity,state:"starting",command:[exe,...args]}});
  }
  if(!process.connected&&!closed)stop();
}
main().catch(error=>{console.error(error.message);stop();process.exitCode=1;});
