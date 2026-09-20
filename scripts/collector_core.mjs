import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync,
  lstatSync, existsSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { logEntry } from "../src/toolLogging.mjs";
import { makeRunId, validRunId, RUN_STATUS_PREFIX } from "../src/runIdentity.mjs";
import { replaceFile } from "./atomic_file.mjs";
import { DB_STATUS_PREFIX, normalizedDbPath } from "../src/databaseBinding.mjs";

const PLUGIN = "local/dfir-sherpa";
const TOOLS = new Set(["dataset_overview", "search_records", "get_record", "get_context"]);
const NORMAL_END = new Set(["eosFound", "stopStringFound"]);
const STOPPED = new Set(["userStopped", "modelUnloaded", "maxPredictedTokensReached", "contextLengthReached"]);
const FAILED_TOOL = new Set(["toolCallFailed", "toolCallDenied", "toolCallGenerationFailed"]);
export const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => JSON.stringify(value, null, 2) + "\n";
const parse = bytes => JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
const stable = value => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
  ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);
const statsKey = (model, stats) => stats && typeof stats === "object" && Number.isFinite(stats.promptTokensCount) && Number.isFinite(stats.totalTimeSec)
  ? digest(stable({model, stats})) : null;

function file(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw Error(`Refusing linked/nonregular file: ${path}`);
  return st;
}
function directory(path) {
  mkdirSync(path, {recursive:true});
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error(`Refusing linked directory: ${path}`);
}
function read(path) { file(path); return readFileSync(path); }
function atomic(path, bytes) {
  if (existsSync(path)) file(path);
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, bytes, {flag:"wx", mode:0o600});
  replaceFile(temp, path);
}
function append(path, bytes) {
  if (existsSync(path)) file(path);
  appendFileSync(path, bytes, {mode:0o600});
}
const configOf = chat => {
  const fields = chat.pluginConfigs?.[PLUGIN]?.config?.fields ?? [];
  return Object.fromEntries(fields.map(f => [f.key, f.value]));
};
const selectedOf = chat => (chat.messages ?? []).map((m, messageIndex) => ({
  ...m.versions?.[m.currentlySelected], messageIndex, versionIndex: m.currentlySelected,
}));
// SDK call IDs are unique within an act, not across an entire conversation.
const callKey = captured => `${captured.message_index}:${captured.version_index}:${captured.event.callId}`;
const comparableDatabase = path => {try {return normalizedDbPath(realpathSync(path));} catch {return normalizedDbPath(path);}};

export function inspectConversation(chat, {idle = false} = {}) {
  const versions = selectedOf(chat), calls = [], generations = [], prompts = [], promptGroups = [];
  for (const version of versions) {
    if (version.role === "user") prompts.push((version.content ?? []).filter(c => c.type === "text").map(c => c.text).join(""));
    for (const [index, step] of (version.steps ?? []).entries()) {
      if (step.genInfo) { generations.push(step.genInfo); promptGroups.push([...prompts]); }
      if (step.type === "toolStatus") {
        calls.push({message_index:version.messageIndex, version_index:version.versionIndex,
          step_identifier:step.stepIdentifier ?? String(index), event:{...step}});
      }
      for (const event of step.content ?? []) {
        if (event.type !== "toolCallRequest" && event.type !== "toolCallResult") continue;
        calls.push({message_index:version.messageIndex, version_index:version.versionIndex,
          step_identifier:step.stepIdentifier ?? String(index), event});
      }
    }
  }
  const requests = calls.filter(c => c.event.type === "toolCallRequest" && TOOLS.has(c.event.name) &&
    (c.event.pluginIdentifier === PLUGIN || (!c.event.pluginIdentifier && chat.plugins?.includes(PLUGIN))));
  const requestIds = new Set(requests.map(callKey));
  const events = calls.filter(c => requests.includes(c) || (["toolCallResult","toolStatus"].includes(c.event.type) && requestIds.has(callKey(c))));
  const results = events.filter(c => c.event.type === "toolCallResult");
  const markers = events.filter(c => c.event.type === "toolStatus").map(c => c.event.statusState?.customStatus).filter(s => typeof s === "string" && s.startsWith(RUN_STATUS_PREFIX))
    .map(s => s.slice(RUN_STATUS_PREFIX.length).split("\n")[0]).filter(validRunId);
  const databaseBindings = events.filter(c => c.event.type === "toolStatus")
    .flatMap(c => String(c.event.statusState?.customStatus ?? "").split("\n"))
    .filter(s => s.startsWith(DB_STATUS_PREFIX)).flatMap(s => {
      try {const value=JSON.parse(s.slice(DB_STATUS_PREFIX.length));return value && typeof value === "object" ? [value] : [];} catch {return [];}
    });
  const finalVersion = versions.at(-1), steps = finalVersion?.role === "assistant" ? finalVersion.steps ?? [] : [];
  let lastToolIndex = -1;
  steps.forEach((s, i) => { if (s.type === "toolStatus" || s.type === "requestConfirmToolCall" ||
    s.content?.some(c => ["toolCallRequest", "toolCallResult"].includes(c.type))) lastToolIndex = i; });
  const response = steps.slice(lastToolIndex + 1).filter(s => s.type === "contentBlock" &&
    (!s.roleOverride || s.roleOverride === "assistant") && (!s.style || s.style.type === "default"))
    .flatMap(s => s.content ?? []).filter(c => c.type === "text" && !c.isStructural).map(c => c.text).join("");
  const lastGenerationStep = steps.findLastIndex(s => s.genInfo);
  const reason = lastGenerationStep >= 0 ? steps[lastGenerationStep].genInfo.stats?.stopReason : null;
  const allRequests = calls.filter(c => c.event.type === "toolCallRequest");
  const allResults = calls.filter(c => c.event.type === "toolCallResult");
  const statusesById = new Map(calls.filter(c => c.event.type === "toolStatus").map(c => [callKey(c), c.event.statusState]));
  const closed = allRequests.every(c => allResults.some(r => callKey(r) === callKey(c)) &&
    statusesById.get(callKey(c))?.status?.type === "toolCallSucceeded");
  let status = idle ? "unknown" : "running";
  if (STOPPED.has(reason)) status = "interrupted";
  else if (reason === "failed") status = "interrupted";
  else if (NORMAL_END.has(reason) && response && lastGenerationStep > lastToolIndex && closed && finalVersion?.role === "assistant") status = "completed";
  else if (allRequests.some(c => FAILED_TOOL.has(statusesById.get(callKey(c))?.status?.type))) status = "interrupted";
  return {detected:requests.length > 0, prompts, promptGroups, events, requests, results, generations, markers,
    response, stop_reason:reason ?? null, status, all_tools_succeeded:closed, config:configOf(chat), database_bindings:databaseBindings,
    model:chat.lastUsedModel ?? null, selected_versions:versions.map(v => v.versionIndex)};
}

export async function snapshotDatabase(path) {
  async function hashFile(target) {
    const before = file(target), sha = createHash("sha256");
    for await (const chunk of createReadStream(target)) sha.update(chunk);
    const after = file(target);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw Error("Database changed while hashing");
    return {sha256:sha.digest("hex"), bytes:after.size, mtime_ms:after.mtimeMs};
  }
  return {...await hashFile(path), sidecars:Object.fromEntries(await Promise.all(["-wal","-shm","-journal"].map(async suffix =>
    [suffix, existsSync(path + suffix) ? await hashFile(path + suffix) : null])))};
}

export class Collector {
  constructor({conversationDir, resultsRoot, idleMs = 120000, settleMs = 3000, onDiagnostic = () => {}, experiment = null, desktop = false}) {
    this.desktop = desktop;
    this.experiment = experiment;
    this.conversationDir = resolve(conversationDir); this.root = resolve(resultsRoot);
    this.idleMs = idleMs; this.settleMs = settleMs; this.diagnostic = onDiagnostic;
    directory(this.root);
    this.stateDir = experiment ? join(this.root, experiment.runId, ".collector") : join(this.root, ".collector");
    directory(this.stateDir); directory(join(this.stateDir, "model-events"));
    this.records = new Map(); this.cache = new Map();
    this.baselines = new Map(); this.preToolBaselines = new Map(); this.models = new Map(); this.modelRevision = 0; this.routingRevision = 0; this.lockToken = null;
    this.manualRuns = new Set();
    this.streamHealth = {state:"not_started"};
    // Each manifest is authoritative; recovery does not depend on an external index surviving.
    for (const entry of readdirSync(this.root, {withFileTypes:true})) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (experiment && entry.name !== experiment.runId) continue;
      const manifest = join(this.root, entry.name, "run.json");
      try {
        const record = parse(read(manifest));
        if (record.format === "dfir-sherpa-run") { this.manualRuns.add(entry.name); continue; }
        if (!(record.format === "dfir-sherpa-auto-run" || (experiment && record.format === "dfir-sherpa-experiment")) || record.run_id !== entry.name || !record.conversation_key) continue;
        if (this.records.has(record.conversation_key)) throw Error("Duplicate conversation manifests");
        this.records.set(record.conversation_key, record);
      } catch (error) { this.diagnostic({event:"manifest_scan_error", file:entry.name, message:error.message}); }
    }
    for (const name of readdirSync(join(this.stateDir, "model-events"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try { this.indexModel(read(join(this.stateDir,"model-events",name)).toString("utf8"), name.slice(0,-5)); }
      catch (error) { this.diagnostic({event:"model_replay_error", message:error.message}); }
    }
  }
  acquire() {
    const path = join(this.stateDir,"collector.lock");
    if (existsSync(path)) {
      const owner = parse(read(path));
      try { process.kill(owner.pid, 0); throw Error("Collector already running"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      unlinkSync(path);
    }
    this.lockToken = randomUUID();
    writeFileSync(path, encode({pid:process.pid, token:this.lockToken}), {flag:"wx", mode:0o600});
  }
  release() {
    const path = join(this.stateDir,"collector.lock");
    if (this.lockToken && existsSync(path) && parse(read(path)).token === this.lockToken) unlinkSync(path);
    this.lockToken = null;
  }
  indexModel(raw, id = digest(raw)) {
    const event = JSON.parse(raw), data = event.data;
    if (!["llm.prediction.input","llm.prediction.output"].includes(data?.type)) return;
    this.models.set(id, {id, type:data.type, model:data.modelIdentifier, stats_key:statsKey(data.modelIdentifier, data.stats)});
    this.modelRevision++;
  }
  ingestModelLine(raw) {
    raw = raw.replace(/\r?\n$/, "");
    if (!raw.trim()) return;
    try {
      const event = JSON.parse(raw);
      if (!["llm.prediction.input","llm.prediction.output"].includes(event.data?.type)) return;
      const id = digest(raw);
      if (this.models.has(id)) return;
      const path = join(this.stateDir,"model-events",id + ".json");
      if (!existsSync(path)) atomic(path,raw);
      this.indexModel(raw,id);
    } catch (error) { this.diagnostic({event:"invalid_model_event", message:error.message}); }
  }
  async baseline(path) {
    if (!normalizedDbPath(path)) return null;
    try {
      path = realpathSync(path);
      const signature = stable([file(path).size,file(path).mtimeMs]);
      let value = this.baselines.get(path);
      if (!value || value.signature !== signature) {
        value = {path, signature, captured_at:new Date().toISOString(), snapshot:await snapshotDatabase(path)};
        this.baselines.set(path,value);
      }
      return value;
    } catch (error) { this.diagnostic({event:"database_snapshot_error", message:error.message}); return null; }
  }
  async discover(path, chat, info, st, sourceHash) {
    const key = digest(realpathSync(path).toLowerCase());
    let record = this.records.get(key);
    if (record) return record;
    if (this.experiment) {
      record = parse(read(join(this.root, this.experiment.runId, "run.json")));
      if (record.conversation_key && record.conversation_key !== key) throw Error("Experiment already bound to another conversation");
      Object.assign(record, {conversation_key:key, conversation_path:realpathSync(path), first_detected_at:new Date().toISOString(),
        identity:{source:"experiment_start",plugin_markers:info.markers}, event_ids:[], summary_ids:[], archived_at:null});
      if (!record.database?.before) {
        const baseline = await this.baseline(info.config.databasePath);
        record.database = {path:baseline?.path ?? info.config.databasePath ?? null, before:baseline?.snapshot ?? null,
          baseline_scope:"first_detection",before_captured_at:baseline?.captured_at ?? null};
      }
      this.records.set(key, record);
      return record;
    }
    // An explicitly initialized manual run remains under init/collect ownership.
    if (!this.desktop && this.manualRuns.has(info.config.SHERPA_RUN_ID)) return null;
    if (!this.desktop && validRunId(info.config.SHERPA_RUN_ID)) {
      const manualManifest = join(this.root, info.config.SHERPA_RUN_ID, "run.json");
      if (existsSync(manualManifest) && ["dfir-sherpa-run","dfir-sherpa-experiment"].includes(parse(read(manualManifest)).format)) {
        this.manualRuns.add(info.config.SHERPA_RUN_ID); return null;
      }
    }
    const requested = this.desktop ? null : validRunId(info.config.SHERPA_RUN_ID) ? info.config.SHERPA_RUN_ID : info.markers[0];
    if (requested && existsSync(join(this.root,requested,"run.json")) && parse(read(join(this.root,requested,"run.json"))).format === "dfir-sherpa-experiment") return null;
    // Desktop auto mode never guesses a case ID from a filename or a previous chat setting.
    let id = requested || makeRunId(this.desktop ? null : info.config.databasePath, new Date(), "");
    let dir = join(this.root,id);
    if (existsSync(dir)) { id = id.slice(0,65) + "_" + key.slice(0,10); dir = join(this.root,id); }
    if (existsSync(dir)) throw Error("Run ID collision; refusing to overwrite");
    mkdirSync(dir);
    const usedPath = info.database_bindings.length ? info.database_bindings[0].path : info.config.databasePath;
    const observed = this.preToolBaselines.get(path);
    const existingBaseline = observed && comparableDatabase(observed.path) === comparableDatabase(usedPath) ? observed : null;
    const baseline = existingBaseline ?? await this.baseline(usedPath);
    const detectedAt = new Date().toISOString();
    record = {format:"dfir-sherpa-auto-run", version:1, run_id:id, conversation_key:key,
      conversation_path:realpathSync(path), first_detected_at:detectedAt, status:"unknown",
      recovered:Date.now() - st.mtimeMs > this.settleMs,
      identity:{source:this.desktop ? "desktop_auto" : validRunId(info.config.SHERPA_RUN_ID) ? "chat_setting" : info.markers.length ? "plugin_status" : "collector",
        requested_run_id:requested ?? null, plugin_markers:info.markers},
      database:{path:baseline?.path ?? (normalizedDbPath(usedPath) ? resolve(usedPath) : null), before:baseline?.snapshot ?? null,
        filename:normalizedDbPath(usedPath) ? basename(baseline?.path ?? usedPath) : null,
        sha256:baseline?.snapshot.sha256 ?? null, bytes:baseline?.snapshot.bytes ?? null,
        binding_source:info.database_bindings.length ? "tool_status" : "chat_setting_at_detection",
        binding_error:baseline ? null : "DB_METADATA_UNAVAILABLE",
        before_captured_at:baseline?.captured_at ?? null, baseline_scope:existingBaseline ? "observed_before_first_tool" : "first_detection_or_recovery",
        unchanged_since_baseline:null},
      event_ids:[], summary_ids:[], source_sha256:sourceHash, archived_at:null,
      model_capture:{state:"pending", input_events:0, output_events:0, missing_outputs:null},
    };
    atomic(join(dir,"run.json"),encode(record));
    this.records.set(key,record);
    this.diagnostic({event:"run_detected", run_id:id, recovered:record.recovered});
    return record;
  }
  async poll() {
    let entries;
    try { entries = readdirSync(this.conversationDir, {withFileTypes:true}); }
    catch (error) { this.diagnostic({event:"conversation_directory_unavailable",message:error.message}); return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".conversation.json")) continue;
      const path = join(this.conversationDir,entry.name);
      try {
        const st = file(path), signature = `${st.size}:${st.mtimeMs}`;
        let cached = this.cache.get(path);
        if (!cached || cached.signature !== signature) {
          const bytes = read(path), chat = parse(bytes);
          if (!chat.plugins?.includes(PLUGIN) && !chat.pluginConfigs?.[PLUGIN]) continue;
          const info = inspectConversation(chat);
          if (this.experiment && path !== this.experiment.conversationPath) continue;
          if (!info.detected) {
            const baseline = await this.baseline(info.config.databasePath);
            if (baseline) this.preToolBaselines.set(path,baseline);
            continue;
          }
          const sourceHash = digest(bytes), record = await this.discover(path,chat,info,st,sourceHash);
          if (!record) continue;
          cached = {signature, sourceHash, changedAt:Date.now(), record, info, bytes, chat};
          this.cache.set(path,cached);
        }
        if (!cached?.chat) continue;
        const idle = Date.now() - st.mtimeMs >= this.idleMs;
        const info = inspectConversation(cached.chat,{idle});
        if (info.status === "completed" && Date.now() - cached.changedAt < this.settleMs) info.status = "running";
        if (cached.publishedHash !== cached.sourceHash || cached.record.status !== info.status) {
          await this.publish(cached,info);
          cached.publishedHash = cached.sourceHash;
          if (["completed","interrupted","unknown"].includes(info.status)) { cached.chat = null; cached.bytes = null; }
        }
      } catch (error) {
        // An editor/app may be in the middle of replacing or serializing the conversation.
        if (!(error instanceof SyntaxError) && !["ENOENT","ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code))
          this.diagnostic({event:"conversation_read_error",file:entry.name,message:error.message});
      }
    }
    this.routeModelEvents();
    atomic(join(this.stateDir,"health.json"),encode({updated_at:new Date().toISOString(), pid:process.pid,
      runs:this.records.size, model_events:this.models.size, stream:this.streamHealth, routing:this.routingHealth}));
  }
  async publish(cached, info) {
    const {record, bytes, chat, sourceHash} = cached, dir = join(this.root,record.run_id);
    const bound = comparableDatabase(record.database.path);
    if (comparableDatabase(info.config.databasePath) !== bound || info.database_bindings.some(b =>
        b.error === "DB_PATH_CHANGED" || comparableDatabase(b.path) !== bound)) {
      record.database.path_changed = true;
      record.database.binding_error = "DB_PATH_CHANGED";
      record.database.requested_path = info.config.databasePath ?? null;
      this.diagnostic({event:"database_path_changed",run_id:record.run_id,
        message:"One Run must use one database. Start a new LM Studio chat. The original DB binding is retained."});
    }
    record.database.filename ??= record.database.path ? basename(record.database.path) : null;
    record.database.sha256 ??= record.database.before?.sha256 ?? null;
    record.database.bytes ??= record.database.before?.bytes ?? null;
    if (record.database.path_changed) info.status = "interrupted";
    else if (!record.database.before && info.status === "completed") {
      record.database.binding_error = "DB_METADATA_UNAVAILABLE"; info.status = "unknown";
    }
    const eventPath = join(dir,"tool-events.jsonl"), summaryPath = join(dir,this.desktop ? "tools-summary.jsonl" : record.run_id + "_tools.jsonl");
    record.files = {...record.files, tools_summary:basename(summaryPath),tool_events:"tool-events.jsonl",
      model_log:"model.log",response:"model-response.md",response_json:"model-response.json",conversation:"conversation.json",prompt:"prompt.txt"};
    // Recover append IDs from journal files, including a crash between append and manifest update.
    const replayIds = (path, field) => {
      if (!existsSync(path)) return new Set();
      let raw = read(path).toString("utf8");
      if (raw && !raw.endsWith("\n")) {
        const backup = path + ".partial-" + digest(raw).slice(0,12);
        if (!existsSync(backup)) writeFileSync(backup,raw,{flag:"wx",mode:0o600});
        raw = raw.slice(0,raw.lastIndexOf("\n") + 1);
        atomic(path,raw); // Only collector-owned journals; original partial bytes remain in backup.
        this.diagnostic({event:"recovered_partial_journal",run_id:record.run_id,file:basename(path)});
      }
      return new Set(raw.split("\n").filter(Boolean).map(line => JSON.parse(line)[field]));
    };
    const eventIds = replayIds(eventPath,"event_id"), summaryIds = replayIds(summaryPath,"event_id");
    for (const captured of info.events) {
      const eventId = digest(stable(captured));
      if (!eventIds.has(eventId)) {
        append(eventPath, JSON.stringify({event_id:eventId, observed_at:new Date().toISOString(), ...captured}) + "\n"); eventIds.add(eventId);
      }
      const event = captured.event;
      if (event.type !== "toolCallResult" || summaryIds.has(eventId)) continue;
      const request = info.requests.find(r => callKey(r) === callKey(captured))?.event;
      try {
        const result = JSON.parse(event.content), line = logEntry(event.name, request?.parameters, result, record.run_id);
        line.output_bytes = Buffer.byteLength(event.content,"utf8");
        append(summaryPath,JSON.stringify({...line,event_id:eventId,call_id:event.callId,timestamp_source:"collector_observation",source:"saved_conversation"}) + "\n");
        summaryIds.add(eventId);
      } catch (error) { this.diagnostic({event:"summary_parse_error",run_id:record.run_id,message:error.message}); }
    }
    if (!existsSync(eventPath)) writeFileSync(eventPath,"",{flag:"wx"});
    if (!existsSync(summaryPath)) writeFileSync(summaryPath,"",{flag:"wx"});
    const prompt = info.prompts.length === 1 ? info.prompts[0] : info.prompts.map((p,i) => `--- User message ${i+1} ---\n${p}`).join("\n\n");
    atomic(join(dir,"prompt.txt"),prompt);
    atomic(join(dir,"conversation.json"),bytes);
    atomic(join(dir,"model-response.md"),info.response);
    let structured = null, parseError = null;
    try { structured = JSON.parse(info.response); } catch (error) { parseError = info.response ? error.message : "No final text"; }
    if (this.experiment) {
      if (!parseError) atomic(join(dir,"model-response.json"),info.response);
      else if (existsSync(join(dir,"model-response.json"))) { file(join(dir,"model-response.json")); unlinkSync(join(dir,"model-response.json")); }
      record.response_json = {valid:!parseError, parse_error:parseError};
    } else atomic(join(dir,"model-response.json"),encode({status:info.status,stop_reason:info.stop_reason,text:info.response,
      parsed_json:structured,parse_error:parseError}));
    atomic(join(dir,"model-statistics.json"),encode(info.generations));
    if (!existsSync(join(dir,"model.log"))) writeFileSync(join(dir,"model.log"),"",{flag:"wx"});
    record.status = info.status; record.stop_reason = info.stop_reason; record.all_tools_succeeded = info.all_tools_succeeded;
    record.identity.plugin_markers = info.markers; record.source_sha256 = sourceHash;
    record.selected_versions = info.selected_versions; record.model = info.model;
    record.event_ids = [...eventIds]; record.summary_ids = [...summaryIds];
    record.updated_at = new Date().toISOString(); record.response_bytes = Buffer.byteLength(info.response);
    if (["completed","interrupted","unknown"].includes(info.status)) record.ended_at ??= record.updated_at;
    else record.ended_at = null;
    record.routing = {prompts:info.prompts, prompt_groups:info.promptGroups, generation_keys:info.generations.map(g => statsKey(g.identifier ?? info.model?.identifier,g.stats)).filter(Boolean),
      model_identifiers:[...new Set(info.generations.map(g => g.identifier ?? info.model?.identifier).filter(Boolean))]};
    this.routingRevision++;
    if (["completed","interrupted","unknown"].includes(info.status)) {
      if (record.database.path) {
        try {
          record.database.after = await snapshotDatabase(record.database.path);
          record.database.unchanged_since_baseline = record.database.before ? isDeepStrictEqual(record.database.before,record.database.after) : null;
        } catch (error) { record.database.error = error.message; record.database.unchanged_since_baseline = null; }
      }
      record.archived_at ??= new Date().toISOString();
    }
    atomic(join(dir,"run.json"),encode(record));
  }
  routeModelEvents() {
    const revision = `${this.modelRevision}:${this.routingRevision}:${this.streamHealth.state}`;
    if (this.lastRoutingRevision === revision) return;
    this.lastRoutingRevision = revision;
    const records = [...this.records.values()].filter(r => r.routing), assignments = new Map(records.map(r => [r.conversation_key,[]]));
    let ambiguous = 0, unassigned = 0;
    for (const meta of this.models.values()) {
      const raw = read(join(this.stateDir,"model-events",meta.id+".json")).toString("utf8"), event = JSON.parse(raw);
      let matches;
      if (meta.type === "llm.prediction.output") matches = meta.stats_key ? records.filter(r => r.routing.generation_keys.includes(meta.stats_key)) : [];
      else {
        const input = event.data.input;
        matches = typeof input === "string" && [...TOOLS].every(tool => input.includes(tool)) ? records.filter(r =>
          r.routing.model_identifiers.includes(meta.model) &&
          (r.routing.prompt_groups ?? [r.routing.prompts]).some(group => group.length > 0 && group.every(prompt => prompt && input.includes(prompt)))) : [];
      }
      if (matches.length === 1) assignments.get(matches[0].conversation_key).push({raw,meta,timestamp:event.timestamp});
      else if (matches.length > 1) ambiguous++; else unassigned++;
    }
    for (const record of records) {
      const assigned = assignments.get(record.conversation_key).sort((a,b) => a.timestamp-b.timestamp || a.meta.id.localeCompare(b.meta.id));
      const inputs = assigned.filter(e => e.meta.type.endsWith("input")), outputs = assigned.filter(e => e.meta.type.endsWith("output"));
      const observedKeys = new Set(outputs.map(e => e.meta.stats_key));
      const missing = record.routing.generation_keys.filter(key => !observedKeys.has(key)).length;
      const capture = {state:missing === 0 && inputs.length >= record.routing.generation_keys.length && outputs.length > 0 ? "matched" : "partial_or_unavailable",
        input_events:inputs.length,output_events:outputs.length,missing_outputs:missing,
        matching:"unique prompt+tool definitions for input; exact model+full statistics for output",
        historical_events_may_be_unavailable:true,stream:this.streamHealth.state};
      const ids = assigned.map(e => e.meta.id);
      if (!isDeepStrictEqual(record.model_event_ids,ids) || !isDeepStrictEqual(record.model_capture,capture)) {
        atomic(join(this.root,record.run_id,"model.log"),assigned.map(e => e.raw+"\n").join(""));
        record.model_event_ids = ids; record.model_capture = capture;
        atomic(join(this.root,record.run_id,"run.json"),encode(record));
      }
    }
    this.routingHealth = {ambiguous_events:ambiguous,unassigned_events:unassigned};
  }
  stopRequested() {
    const path = join(this.stateDir,"stop.json");
    if (!existsSync(path)) return false;
    try { return parse(read(path)).token === this.lockToken; } catch { return false; }
  }
}
