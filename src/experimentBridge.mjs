import {readFileSync, lstatSync} from "node:fs";
import {homedir} from "node:os";
import {join, isAbsolute, resolve} from "node:path";
import {validRunId} from "./runIdentity.mjs";

export const defaultControlDir = () => join(homedir(), ".lmstudio", "dfir-sherpa");

// Only instrumentation reads this operator-owned rendezvous; no model Tool can write it.
export function activeExperiment(databasePath, controlDir = defaultControlDir()) {
  const path = join(controlDir,"active-experiment.json");
  let st;
  try { st=lstatSync(path); } catch(error) { if(error.code==="ENOENT")return activeDesktopCollector(controlDir); throw error; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || st.size>16384) throw Error("Unsafe experiment state file");
  const state=JSON.parse(readFileSync(path,"utf8"));
  if(state.status!=="ready")return null;
  if(!validRunId(state.run_id) || !isAbsolute(state.run_dir) || !Number.isInteger(state.pid) || state.pid<1 ||
    !Number.isFinite(Date.parse(state.heartbeat_at)) || Math.abs(Date.now()-Date.parse(state.heartbeat_at))>15000)
    throw Error("Experiment collector state is invalid or stale; check experiment:stop");
  process.kill(state.pid,0);
  if(state.database_path && resolve(state.database_path).toLowerCase()!==resolve(databasePath || ".").toLowerCase())
    throw Error("Active experiment uses a different database; retrieval is unchanged but this call is not attached");
  return state;
}

function activeDesktopCollector(controlDir) {
  const path=join(controlDir,"desktop-collector.json");
  let st;
  try {st=lstatSync(path);}catch(error){if(error.code==="ENOENT")return null;throw error;}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16384)throw Error("Unsafe desktop collector state");
  const state=JSON.parse(readFileSync(path,"utf8"));
  if(state.status==="stopped")return null;
  if(!["ready","starting"].includes(state.status))throw Error("Invalid desktop collector status");
  if(state.mode!=="desktop_auto"||!Number.isInteger(state.pid)||state.pid<1||
    !Number.isFinite(Date.parse(state.heartbeat_at))||Math.abs(Date.now()-Date.parse(state.heartbeat_at))>15000)
    throw Error("Desktop collector is stale; reopen DFIR Sherpa Experiment");
  process.kill(state.pid,0);
  // Deliberately no shared run ID: each conversation is bound independently by the collector.
  return {mode:"desktop_auto",pid:state.pid};
}
