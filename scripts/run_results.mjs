// Operator-side run collection. Never registered as a model Tool.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, lstatSync,
  existsSync, realpathSync, renameSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const TOOLS = new Set(["dataset_overview", "search_records", "get_record", "get_context"]);
const TERMINAL = new Set(["eosFound", "stopStringFound", "userStopped", "modelUnloaded", "failed", "maxPredictedTokensReached", "contextLengthReached"]);
const COMPLETE = new Set(["eosFound", "stopStringFound"]);
const utf8 = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const json = bytes => JSON.parse(utf8(bytes).replace(/^\uFEFF/, ""));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => JSON.stringify(value, null, 2) + "\n";
function fail(message, code = "INVALID_RUN") { throw Object.assign(new Error(message), { code }); }
function check(condition, message, code) { if (!condition) fail(message, code); }
function regular(path) {
  const info = lstatSync(path);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, `Expected an unlinked regular file: ${path}`);
  return info;
}
function read(path) { regular(path); return readFileSync(path); }
function newFile(path, data) { writeFileSync(path, data, { flag: "wx", mode: 0o600 }); }
function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) &&
    !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(id);
}
async function fingerprint(path) {
  const before = regular(path), digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = regular(path);
  check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino,
    "Source changed while hashing; stop the run before collecting", "SOURCE_CHANGED");
  return { sha256: digest.digest("hex"), bytes: after.size, mtime_ms: after.mtimeMs };
}
async function databaseSnapshot(path) {
  return { ...await fingerprint(path), sidecars: Object.fromEntries(await Promise.all(
    ["-journal", "-wal", "-shm"].map(async suffix => [suffix, existsSync(path + suffix) ? await fingerprint(path + suffix) : null]))) };
}

export async function initRun({ runId, db, prompt, resultsRoot = "outputs/results" }) {
  check(validId(runId), "Use a unique run ID: 1..80 letters/digits/_/-, no Windows reserved names");
  const databasePath = realpathSync(resolve(db)), promptBytes = read(resolve(prompt));
  check(utf8(promptBytes).trim().length > 0, "Prompt must be nonempty UTF-8 text");
  // Inspect only the SQLite file header; no database connection or write is needed.
  regular(databasePath);
  const fd = openSync(databasePath, "r"), header = Buffer.alloc(16);
  try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
  check(header.toString("ascii") === "SQLite format 3\0", "Expected a SQLite database file");
  const before = await databaseSnapshot(databasePath);
  const root = resolve(resultsRoot);
  mkdirSync(root, { recursive: true });
  const runDir = join(realpathSync(root), runId);
  mkdirSync(runDir); // Existing runs are never reused or overwritten.
  const manifest = {
    format: "dfir-sherpa-run", version: 1, run_id: runId, status: "prepared",
    prepared_at: new Date().toISOString(), collected_at: null,
    database: { path: databasePath, filename: basename(databasePath), before },
    prompt: { sha256: sha(promptBytes), bytes: promptBytes.length },
    model: null, generation_settings: null,
    files: { prompt: "prompt.txt", tools: `${runId}_tools.jsonl`, conversation: "conversation.json", response: "model-response.md" },
  };
  newFile(join(runDir, "prompt.txt"), promptBytes);
  newFile(join(runDir, `${runId}_tools.jsonl`), "");
  newFile(join(runDir, "run.json"), encode(manifest));
  return { run_dir: runDir, plugin_settings: { databasePath, SHERPA_RUN_ID: runId, SHERPA_LOG_DIR: runDir } };
}

function readRun(runDir) {
  const info = lstatSync(runDir);
  check(info.isDirectory() && !info.isSymbolicLink(), "Run directory must be a real directory");
  const manifest = json(read(join(runDir, "run.json")));
  check(manifest.format === "dfir-sherpa-run" && manifest.version === 1 && validId(manifest.run_id), "Invalid run.json");
  check(manifest.status === "prepared", "This run has already been collected");
  check(basename(runDir) === manifest.run_id, "Run directory and run ID differ");
  const prompt = read(join(runDir, "prompt.txt"));
  check(sha(prompt) === manifest.prompt.sha256, "Saved prompt changed after preparation");
  return { manifest, prompt };
}

function textContent(content) {
  check(Array.isArray(content) && content.every(c => c.type === "text" && typeof c.text === "string"),
    "Only text-only prompts are supported; attachments require a separate capture workflow");
  return content.map(c => c.text).join("");
}

export function extractConversation(chat, { interrupted = false } = {}) {
  check(Array.isArray(chat.messages), "Unsupported LM Studio conversation format");
  const selected = chat.messages.map(message => {
    const version = message.versions?.[message.currentlySelected];
    check(version, "Missing selected message version");
    return version;
  });
  check(selected.length === 2 && selected[0].role === "user" && selected[1].role === "assistant",
    "Use a fresh chat with exactly one user prompt and one assistant turn", "NOT_READY");
  const [user, assistant] = selected;
  check(user.type === "singleStep" && assistant.type === "multiStep" && Array.isArray(assistant.steps),
    "Unsupported LM Studio message format");
  const steps = assistant.steps, generations = steps.filter(s => s.genInfo).map(s => s.genInfo);
  const stopReason = generations.at(-1)?.stats?.stopReason ?? null;
  check(interrupted || TERMINAL.has(stopReason), "Model has not reached a terminal state", "NOT_READY");
  let lastTool = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === "toolStatus" || steps[i].type === "requestConfirmToolCall" ||
      steps[i].content?.some(c => c.type === "toolCallRequest" || c.type === "toolCallResult")) lastTool = i;
  }
  // Exclude reasoning, tool text and pre-tool commentary. Preserve final text chunks verbatim.
  const response = steps.slice(lastTool + 1).filter(s => s.type === "contentBlock" &&
    (!s.roleOverride || s.roleOverride === "assistant") && (!s.style || s.style.type === "default"))
    .flatMap(s => s.content ?? []).filter(c => c.type === "text" && c.isStructural !== true)
    .map(c => { check(typeof c.text === "string", "Invalid response text chunk"); return c.text; }).join("");
  const content = steps.flatMap(s => s.content ?? []);
  const requests = content.filter(c => c.type === "toolCallRequest");
  const results = content.filter(c => c.type === "toolCallResult");
  check(new Set(requests.map(r => r.callId)).size === requests.length &&
    new Set(results.map(r => r.callId)).size === results.length, "Duplicate Tool call IDs in saved conversation");
  const status = interrupted ? "interrupted" : COMPLETE.has(stopReason) ? "completed" : stopReason === "failed" ? "failed" : "interrupted";
  check(status !== "completed" || response.length > 0, "Completed turn has no extractable final response", "NOT_READY");
  return { prompt: textContent(user.content), response, stopReason, status, generations, requests, results,
    selected_versions: chat.messages.map(m => m.currentlySelected), assistant };
}

function verifyLogs(bytes, manifest, extracted) {
  const problems = [];
  const content = utf8(bytes);
  let logs = [];
  try {
    check(!content || content.endsWith("\n"), "JSONL ends with an incomplete line");
    logs = content ? content.slice(0, -1).split("\n").map(line => JSON.parse(line)) : [];
  } catch (error) { problems.push(error.message); }
  if (logs.length !== extracted.results.length) problems.push("Tool log count differs from saved Tool result count");
  if (extracted.requests.length !== extracted.results.length) problems.push("Some Tool requests have no saved result");
  logs.forEach((entry, index) => {
    try {
      const result = extracted.results[index];
      const request = extracted.requests.find(r => r.callId === result?.callId);
      check(result && request && TOOLS.has(entry.tool) && entry.tool === result.name && entry.tool === request.name,
        "Tool names or call IDs do not match");
      const value = JSON.parse(result.content);
      check(entry.run_id === manifest.run_id && Number.isFinite(Date.parse(entry.timestamp)), "Wrong run ID or invalid log timestamp");
      check(entry.output_bytes === Buffer.byteLength(result.content, "utf8") && entry.elapsed_ms === value.elapsed_ms &&
        entry.returned === (value.returned ?? 0) && entry.success === (value.ok === true), "Tool log metrics differ from the saved response");
      if (entry.tool === "search_records") {
        const filters = Object.fromEntries(["source", "event_type", "timestamp_from", "timestamp_to"]
          .filter(key => request.parameters[key] !== undefined).map(key => [key, request.parameters[key]]));
        check(entry.query === (request.parameters.query ?? "") && entry.total_matches === (value.total_matches ?? null) &&
          entry.truncated === (value.truncated ?? null) && entry.max_results === (value.limit ?? request.parameters.limit ?? 8) &&
          isDeepStrictEqual(entry.filters, filters), "Search log differs from request/response");
      }
      if (entry.tool === "get_record" || entry.tool === "get_context")
        check(entry.requested_line_id === request.parameters.line_id, "Requested line ID differs");
      if (entry.tool === "get_record") check(entry.found === (value.found ?? null) && entry.truncated === (value.truncated ?? null), "Record log metadata differs");
      if (entry.tool === "get_context") check(entry.before === (value.before_requested ?? request.parameters.before ?? 3) &&
        entry.after === (value.after_requested ?? request.parameters.after ?? 3), "Context bounds differ");
      if (entry.tool === "dataset_overview") check(entry.total_records === (value.total_records ?? null), "Dataset count differs");
      if (entry.returned_line_ids) check(isDeepStrictEqual(entry.returned_line_ids, (value.records ?? []).map(r => r.line_id)), "Returned line IDs differ");
    } catch (error) { problems.push(`Log ${index + 1}: ${error.message}`); }
  });
  return { consistent: problems.length === 0, lines: logs.length, problems };
}

function prepareCollection(runDir, conversation, interrupted) {
  const { manifest, prompt } = readRun(runDir);
  const conversationBytes = read(conversation), chat = json(conversationBytes);
  const extracted = extractConversation(chat, { interrupted });
  // A text editor's BOM/newline convention must not cause a false prompt mismatch.
  const normalizePrompt = value => value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  check(normalizePrompt(extracted.prompt) === normalizePrompt(utf8(prompt)), "Conversation prompt differs from prompt.txt");
  const fields = chat.pluginConfigs?.["local/dfir-sherpa"]?.config?.fields;
  const setting = key => fields?.find(f => f.key === key)?.value;
  check(setting("SHERPA_RUN_ID") === manifest.run_id, "Chat must explicitly set this SHERPA_RUN_ID");
  check(typeof setting("databasePath") === "string" && realpathSync(setting("databasePath")) === realpathSync(manifest.database.path), "Chat uses a different database");
  check(typeof setting("SHERPA_LOG_DIR") === "string" && realpathSync(setting("SHERPA_LOG_DIR")) === realpathSync(runDir), "Chat uses a different log directory");
  const logBytes = read(join(runDir, `${manifest.run_id}_tools.jsonl`));
  const logs = verifyLogs(logBytes, manifest, extracted);
  check(extracted.status !== "completed" || logs.consistent, "Tool logs do not match this completed conversation: " + logs.problems.join("; "), "NOT_READY");
  return { manifest, prompt, chat, extracted, conversationBytes, logBytes, logs };
}

export async function collectRun({ runDir, conversation, interrupted = false }) {
  runDir = resolve(runDir); conversation = resolve(conversation);
  const ready = prepareCollection(runDir, conversation, interrupted);
  for (const name of ["conversation.json", "model-response.md", ".collect.lock"])
    check(!existsSync(join(runDir, name)), `Refusing to overwrite ${name}`);
  const lock = join(runDir, ".collect.lock");
  newFile(lock, String(process.pid));
  try {
    const { manifest, chat, extracted, conversationBytes, logBytes, logs } = ready;
    const after = await databaseSnapshot(manifest.database.path);
    check(read(conversation).equals(conversationBytes) && read(join(runDir, `${manifest.run_id}_tools.jsonl`)).equals(logBytes),
      "Conversation or Tool log changed during collection; retry after generation stops", "SOURCE_CHANGED");
    const responseBytes = Buffer.from(extracted.response, "utf8");
    const unchanged = isDeepStrictEqual(manifest.database.before, after);
    const complete = { ...manifest, status: extracted.status, collected_at: new Date().toISOString(),
      // Preparation/collection times bracket a run, not model inference start/end timestamps.
      timing_note: "prepared_at and collected_at are archive boundaries; generation stats come from LM Studio",
      database: { ...manifest.database, after, unchanged },
      integrity: unchanged && logs.consistent ? "passed" : "failed",
      model: chat.lastUsedModel ?? null,
      generation_settings: extracted.generations.map(g => ({ identifier: g.identifier ?? null,
        indexed_model_identifier: g.indexedModelIdentifier ?? null, load: g.loadModelConfig ?? null,
        prediction: g.predictionConfig ?? null, stats: g.stats ?? null })),
      system_prompt: chat.systemPrompt ?? null,
      selected_versions: extracted.selected_versions,
      stop_reason: extracted.stopReason, operator_marked_interrupted: interrupted,
      response: { available: responseBytes.length > 0, bytes: responseBytes.length, sha256: sha(responseBytes),
        scope: "Selected assistant turn, plain text after last tool event; reasoning and structural tokens excluded" },
      conversation: { source_path: conversation, sha256: sha(conversationBytes), bytes: conversationBytes.length },
      tool_log: { ...logs, sha256: sha(logBytes), bytes: logBytes.length },
    };
    newFile(join(runDir, "conversation.json"), conversationBytes);
    newFile(join(runDir, "model-response.md"), responseBytes);
    const temp = join(runDir, `.run-${randomUUID()}.tmp`);
    newFile(temp, encode(complete));
    regular(join(runDir, "run.json"));
    renameSync(temp, join(runDir, "run.json"));
    return complete;
  } finally { unlinkSync(lock); }
}

export async function watchRun(options, { intervalMs = 1000, timeoutMs = 3600000 } = {}) {
  readRun(resolve(options.runDir));
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    try {
      const ready = prepareCollection(resolve(options.runDir), resolve(options.conversation), false);
      const signature = sha(Buffer.concat([ready.conversationBytes, ready.logBytes]));
      if (previous === signature) return await collectRun(options);
      previous = signature;
    } catch (error) {
      if (!["NOT_READY", "SOURCE_CHANGED", "ENOENT", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
      previous = undefined;
    }
    await delay(intervalMs);
  }
  fail("Watch timed out; run remains uncollected. Stop generation before using --interrupted", "WATCH_TIMEOUT");
}

const HELP = `Usage:
  node scripts/run_results.mjs init --run-id ID --db PATH --prompt FILE [--results-root outputs/results]
  node scripts/run_results.mjs collect --run-dir PATH --conversation FILE [--watch] [--timeout-seconds 3600]
  node scripts/run_results.mjs collect --run-dir PATH --conversation FILE --interrupted
Use one fresh text-only chat per run. Configure the plugin with the settings printed by init.
--watch collects after a terminal generation and two unchanged snapshots. Stop with Ctrl+C.
--interrupted archives a stopped/incomplete turn; never marks it completed.`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "run-id": { type: "string" }, db: { type: "string" }, prompt: { type: "string" }, "results-root": { type: "string" },
    "run-dir": { type: "string" }, conversation: { type: "string" }, watch: { type: "boolean" },
    interrupted: { type: "boolean" }, "timeout-seconds": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) return console.log(HELP);
  check(positionals.length === 1, HELP);
  if (positionals[0] === "init") {
    check(values["run-id"] && values.db && values.prompt, HELP);
    console.log(JSON.stringify(await initRun({ runId: values["run-id"], db: values.db, prompt: values.prompt, resultsRoot: values["results-root"] }), null, 2));
  } else {
    check(positionals[0] === "collect" && values["run-dir"] && values.conversation && !(values.watch && values.interrupted), HELP);
    const seconds = Number(values["timeout-seconds"] ?? 3600);
    check(Number.isFinite(seconds) && seconds > 0, "timeout-seconds must be positive");
    const options = { runDir: values["run-dir"], conversation: values.conversation, interrupted: values.interrupted ?? false };
    const result = await (values.watch ? watchRun(options, { timeoutMs: seconds * 1000 }) : collectRun(options));
    console.log(JSON.stringify({ run_id: result.run_id, status: result.status, integrity: result.integrity,
      response_bytes: result.response.bytes, database_unchanged: result.database.unchanged, run_dir: resolve(options.runDir) }));
    if (result.integrity !== "passed") process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ error: error.code ?? "COLLECTION_FAILED", message: error.message })); process.exitCode = 1; });
}
