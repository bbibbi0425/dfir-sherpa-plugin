import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, linkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { initRun, collectRun, watchRun, extractConversation } from "../scripts/run_results.mjs";
import { createSearchFixture } from "./searchFixture.mjs";
import { datasetOverview } from "../src/datasetOverview.mjs";
import { searchRecords } from "../src/searchRecords.mjs";
import { getRecord, getContext } from "../src/recordTools.mjs";
import { writeToolLog } from "../src/toolLogging.mjs";

const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const text = value => ({ type: "text", text: value });
const block = (content, extra = {}) => ({ type: "contentBlock", content, ...extra });
const final = (value, reason = "eosFound") => block([text(value)], { genInfo: {
  identifier: "synthetic-model", loadModelConfig: { fields: [{ key: "contextLength", value: 8192 }] },
  predictionConfig: { fields: [{ key: "temperature", value: 0 }] }, stats: { stopReason: reason, totalTimeSec: 1.5 },
} });
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "sherpa-results-"));
  try {
    const db = join(root, "timeline.sqlite"), prompt = join(root, "input.txt");
    createSearchFixture(db); writeFileSync(prompt, "Describe the synthetic timeline. 한글🙂");
    const before = hash(db), mtime = statSync(db).mtimeMs;
    const run = await initRun({ runId: "fixture_01", db, prompt, resultsRoot: join(root, "results") });
    const chat = {
      lastUsedModel: { identifier: "synthetic-model" }, systemPrompt: "Synthetic instructions",
      plugins: ["local/dfir-sherpa"],
      pluginConfigs: { "local/dfir-sherpa": { config: { fields: Object.entries(run.plugin_settings).map(([key, value]) => ({key, value})) } } },
      messages: [
        { currentlySelected: 0, versions: [{ type: "singleStep", role: "user", content: [text(readFileSync(prompt, "utf8"))] }] },
        { currentlySelected: 0, versions: [{ type: "multiStep", role: "assistant", steps: [] }] },
      ],
    };
    const path = join(root, "native.conversation.json"), steps = chat.messages[1].versions[0].steps;
    const save = () => writeFileSync(path, JSON.stringify(chat));
    await fn({root, db, prompt, runDir: run.run_dir, chat, steps, path, save});
    assert.equal(hash(db), before); assert.equal(statSync(db).mtimeMs, mtime);
  } finally { rmSync(root, { recursive: true }); }
}

function addCalls(f) {
  const calls = [
    ["dataset_overview", {}, () => datasetOverview(f.db, {}, () => {})],
    ["search_records", {query: "quartz"}, () => searchRecords(f.db, {query: "quartz"})],
    ["get_record", {line_id: "sample-020"}, () => getRecord(f.db, {line_id: "sample-020"}, () => {})],
    ["get_context", {line_id: "sample-020"}, () => getContext(f.db, {line_id: "sample-020"}, () => {})],
  ];
  calls.forEach(([name, parameters, retrieve], index) => {
    const response = retrieve(), callId = String(index);
    const original = JSON.stringify(response);
    writeToolLog(name, parameters, response, () => ({runId: "fixture_01", logDir: f.runDir, databasePath: f.db}), message => assert.fail(message));
    assert.equal(JSON.stringify(response), original);
    f.steps.push(block([{type: "toolCallRequest", name, parameters, callId}], {genInfo: {stats: {stopReason: "toolCalls"}}}),
      {type: "toolStatus", callId, statusState: {status: {type: "toolCallSucceeded"}}},
      block([{type: "toolCallResult", name, content: original, callId}], {roleOverride: "tool"}));
  });
}

test("four real retrieval calls collect into one run; exact raw chat, response, prompt, metrics and DB unchanged", async () => fixture(async f => {
  addCalls(f);
  f.steps.unshift(block([text("Pre-tool commentary must not be exported")]));
  f.steps.push(block([text("Reasoning must not enter final response")], {style: {type: "thinking", ended: true}}));
  const response = '```json\n{"answer":"한글🙂", "preserve": "  spaces  "}\n```\n';
  f.steps.push(final(response)); f.save();
  const logPath = join(f.runDir, "fixture_01_tools.jsonl"), logHash = hash(logPath), sourceHash = hash(f.path);
  const result = await collectRun({runDir: f.runDir, conversation: f.path});
  assert.equal(result.status, "completed"); assert.equal(result.integrity, "passed");
  assert.equal(result.database.unchanged, true); assert.equal(result.tool_log.lines, 4);
  assert.equal(readFileSync(join(f.runDir, "model-response.md"), "utf8"), response);
  assert.equal(hash(join(f.runDir, "conversation.json")), sourceHash);
  assert.equal(hash(f.path), sourceHash); assert.equal(hash(logPath), logHash);
  assert.equal(hash(join(f.runDir, "prompt.txt")), hash(f.prompt));
  assert.equal(result.response.bytes, Buffer.byteLength(response));
  assert.equal(result.generation_settings.at(-1).prediction.fields[0].value, 0);
  await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /already been collected/);
}));

test("init refuses traversal, reserved run IDs, duplicate runs, invalid SQLite and empty prompt", async () => fixture(async f => {
  for (const runId of ["../escape", "CON", "LPT1", "bad/name", ""])
    await assert.rejects(initRun({runId, db: f.db, prompt: f.prompt, resultsRoot: join(f.root, "results")}));
  await assert.rejects(initRun({runId: "fixture_01", db: f.db, prompt: f.prompt, resultsRoot: join(f.root, "results")}), /EEXIST/);
  await assert.rejects(initRun({runId: "bad_db", db: f.prompt, prompt: f.prompt, resultsRoot: join(f.root, "results")}), /SQLite/);
  const empty = join(f.root, "empty.txt"); writeFileSync(empty, "");
  await assert.rejects(initRun({runId: "empty", db: f.db, prompt: empty, resultsRoot: join(f.root, "results")}), /nonempty/);
}));

test("reasoning, structural tokens and unselected responses excluded; text chunks preserve exact spacing", async () => fixture(async f => {
  f.steps.push(block([text("private reasoning")], {style: {type: "thinking"}}),
    block([{...text("<structural>"), isStructural: true}, text("a ")]), final("b\r\n"));
  f.chat.messages[1].versions.push({role: "assistant", type: "multiStep", steps: [final("unselected")]});
  const selected = extractConversation(f.chat);
  assert.equal(selected.response, "a b\r\n");
  f.save(); assert.equal((await collectRun({runDir: f.runDir, conversation: f.path})).tool_log.lines, 0);
}));

test("stopped run without final text is archived as interrupted with empty response, never completed", async () => fixture(async f => {
  addCalls(f); f.steps.push(block([], {genInfo: {stats: {stopReason: "userStopped"}}})); f.save();
  const report = await collectRun({runDir: f.runDir, conversation: f.path});
  assert.equal(report.status, "interrupted"); assert.equal(report.response.available, false);
  assert.equal(readFileSync(join(f.runDir, "model-response.md")).length, 0);
}));

test("in-flight generation waits; explicit interrupted collection preserves unresolved requests", async () => fixture(async f => {
  f.steps.push(block([{type: "toolCallRequest", name: "dataset_overview", callId: "pending", parameters: {}}], {genInfo: {stats: {stopReason: "toolCalls"}}})); f.save();
  await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /terminal state/);
  assert.equal(existsSync(join(f.runDir, "conversation.json")), false);
  const report = await collectRun({runDir: f.runDir, conversation: f.path, interrupted: true});
  assert.equal(report.status, "interrupted"); assert.equal(report.integrity, "failed");
  assert.equal(report.tool_log.consistent, false);
}));

test("wrong prompt, run ID, DB/log path and extra turns rejected before writing artifacts", async () => fixture(async f => {
  f.steps.push(final("done"));
  const baseline = structuredClone(f.chat);
  const mutations = [
    c => {c.messages[0].versions[0].content[0].text = "wrong";},
    c => {c.pluginConfigs["local/dfir-sherpa"].config.fields.find(x => x.key === "SHERPA_RUN_ID").value = "wrong";},
    c => {c.pluginConfigs["local/dfir-sherpa"].config.fields.find(x => x.key === "databasePath").value = f.prompt;},
    c => {c.pluginConfigs["local/dfir-sherpa"].config.fields.find(x => x.key === "SHERPA_LOG_DIR").value = f.root;},
    c => {c.messages.push(c.messages[0]);},
  ];
  for (const mutate of mutations) {
    const chat = structuredClone(baseline); mutate(chat); writeFileSync(f.path, JSON.stringify(chat));
    await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}));
    assert.equal(existsSync(join(f.runDir, "conversation.json")), false);
  }
}));

test("missing, partial and wrong-size Tool logs cannot yield a completed archive", async () => fixture(async f => {
  addCalls(f); f.steps.push(final("done")); f.save();
  const path = join(f.runDir, "fixture_01_tools.jsonl"), original = readFileSync(path, "utf8");
  const entries = original.trimEnd().split("\n").map(JSON.parse); entries[0].output_bytes++;
  for (const bad of ["", original.slice(0, -1), entries.map(e => JSON.stringify(e)).join("\n") + "\n"]) {
    writeFileSync(path, bad);
    await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /Tool logs do not match/);
  }
  writeFileSync(path, original);
}));

test("refuses to overwrite an existing response including a DB hard link", async () => fixture(async f => {
  f.steps.push(final("done")); f.save();
  linkSync(f.db, join(f.runDir, "model-response.md"));
  await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /overwrite/);
  assert.equal(existsSync(join(f.runDir, "conversation.json")), false);
}));

test("changed search filter metadata and duplicate call IDs cannot pass collection", async () => fixture(async f => {
  addCalls(f); f.steps.push(final("done")); f.save();
  const path = join(f.runDir, "fixture_01_tools.jsonl"), original = readFileSync(path, "utf8");
  const entries = original.trimEnd().split("\n").map(JSON.parse);
  entries[1].filters = {source: "different"};
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /Search log differs/);
  writeFileSync(path, original);
  f.steps.unshift(structuredClone(f.steps[0])); f.save();
  await assert.rejects(collectRun({runDir: f.runDir, conversation: f.path}), /Duplicate Tool call IDs/);
}));

test("database change is retained as failed integrity, not hidden", async () => fixture(async f => {
  f.steps.push(final("done")); f.save();
  const manifestPath = join(f.runDir, "run.json"), manifest = JSON.parse(readFileSync(manifestPath));
  // Alter baseline only: the forensic fixture remains unchanged throughout the test.
  manifest.database.before.sha256 = "0".repeat(64); writeFileSync(manifestPath, JSON.stringify(manifest));
  const report = await collectRun({runDir: f.runDir, conversation: f.path});
  assert.equal(report.database.unchanged, false); assert.equal(report.integrity, "failed");
}));

test("watch waits for stable terminal chat then collects; timeout does not finalize", async () => fixture(async f => {
  f.save();
  await assert.rejects(watchRun({runDir: f.runDir, conversation: f.path}, {intervalMs: 10, timeoutMs: 30}), /timed out/);
  writeFileSync(f.path, Buffer.from([0xef, 0xbb])); // Native file temporarily contains a partial UTF-8 write.
  const timer = setTimeout(() => { f.steps.push(final("watched response")); f.save(); }, 30);
  try {
    const report = await watchRun({runDir: f.runDir, conversation: f.path}, {intervalMs: 15, timeoutMs: 3000});
    assert.equal(report.status, "completed"); assert.equal(report.response.available, true);
  } finally { clearTimeout(timer); }
}));

test("CLI init and collect operate without LM Studio or model invocation", async () => fixture(async f => {
  const script = resolve("scripts/run_results.mjs");
  const result = JSON.parse(execFileSync(process.execPath, [script, "init", "--run-id", "cli_run", "--db", f.db,
    "--prompt", f.prompt, "--results-root", join(f.root, "results")], {encoding: "utf8"}));
  f.chat.pluginConfigs["local/dfir-sherpa"].config.fields = Object.entries(result.plugin_settings).map(([key, value]) => ({key, value}));
  f.steps.push(final("CLI response")); f.save();
  const collected = JSON.parse(execFileSync(process.execPath, [script, "collect", "--run-dir", result.run_dir,
    "--conversation", f.path], {encoding: "utf8"}));
  assert.equal(collected.status, "completed"); assert.equal(collected.database_unchanged, true);
}));
