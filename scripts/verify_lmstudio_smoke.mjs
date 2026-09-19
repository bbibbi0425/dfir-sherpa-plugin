// Verify native LM Studio chat Tool events, not assistant claims or local mocks.
// Record bodies stay in the user's existing LM Studio conversation; reports omit them.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const { values } = parseArgs({ options: {
  db: { type: "string" }, conversation: { type: "string" }, baseline: { type: "string" },
  report: { type: "string" }, snapshot: { type: "boolean", default: false },
  jsonl: { type: "string" }, "run-id": { type: "string" },
  "compare-conversation": { type: "string" },
} });
if (!values.db || !values.report) throw Error("Required: --db PATH --report NEW_JSON_PATH [--snapshot | --conversation PATH --baseline PATH]");
const dbPath = resolve(values.db), reportPath = resolve(values.report);
assert.ok(!existsSync(reportPath), "Refusing to overwrite any existing file");
const hash = async path => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};
const snapshot = async () => ({ sha256: await hash(dbPath), bytes: statSync(dbPath).size,
  mtime_ms: statSync(dbPath).mtimeMs,
  sidecars: Object.fromEntries(await Promise.all(["-journal", "-wal", "-shm"].map(async suffix => {
    const path = dbPath + suffix;
    return [suffix, existsSync(path) ? { sha256: await hash(path), bytes: statSync(path).size } : null];
  }))) });
if (values.snapshot) {
  writeFileSync(reportPath, JSON.stringify({ database: dbPath, before: await snapshot(), created_at_utc: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
} else {
  if (!values.conversation || !values.baseline) throw Error("Required: --conversation, --baseline");
  const read = path => JSON.parse(readFileSync(resolve(path), "utf8"));
  const baseline = read(values.baseline), chat = read(values.conversation);
  const steps = chat.messages.flatMap(m => m.versions[m.currentlySelected]?.steps ?? []);
  const schemaSnapshots = steps.flatMap(s => s.genInfo?.predictionConfig?.fields ?? [])
    .filter(f => f.key === "llm.prediction.tools").map(f => f.value.tools);
  assert.ok(schemaSnapshots.length, "Missing schemas in actual model prediction configuration");
  const schemas = schemaSnapshots[0];
  for (const snapshot of schemaSnapshots) assert.deepEqual(snapshot, schemas);
  assert.equal(resolve(baseline.database), dbPath);
  const expected = ["dataset_overview", "search_records", "get_record", "get_context"];
  assert.deepEqual(schemas.map(t => t.function.name), expected);
  for (const schema of schemas) {
    assert.equal(schema.function.parameters.type, "object");
    assert.equal(schema.function.parameters.additionalProperties, false);
  }
  assert.deepEqual(schemas[0].function.parameters.properties, {});
  assert.equal(schemas[1].function.parameters.properties.limit.maximum, 10);
  for (const index of [2, 3]) assert.deepEqual(schemas[index].function.parameters.required, ["line_id"]);
  for (const key of ["before", "after"]) {
    const bound = schemas[3].function.parameters.properties[key];
    assert.equal(bound.type, "integer"); assert.equal(bound.minimum, 0); assert.equal(bound.maximum, 5);
  }
  assert.deepEqual(chat.plugins, ["local/dfir-sherpa"]);
  assert.deepEqual(chat.disabledPluginTools, []);
  const config = chat.pluginConfigs["local/dfir-sherpa"].config.fields;
  assert.equal(resolve(config.find(f => f.key === "databasePath").value), dbPath);
  const content = steps.flatMap(s => s.content ?? []);
  const requests = content.filter(c => c.type === "toolCallRequest");
  const results = content.filter(c => c.type === "toolCallResult");
  assert.deepEqual(requests.map(r => r.name), expected);
  assert.deepEqual(results.map(r => r.name), expected);
  const parsed = results.map(r => JSON.parse(r.content));
  const calls = results.map((event, i) => {
    const request = requests[i], result = parsed[i];
    assert.equal(request.pluginIdentifier, "local/dfir-sherpa");
    assert.equal(event.callId, request.callId);
    assert.equal(result.ok, true);
    assert.ok(Number.isFinite(result.elapsed_ms));
    const status = steps.find(s => s.type === "toolStatus" && s.callId === event.callId)?.statusState.status;
    assert.equal(status?.type, "toolCallSucceeded");
    const outputBytes = Buffer.byteLength(event.content, "utf8");
    assert.ok(outputBytes <= (event.name === "dataset_overview" ? 2048 : 24576));
    return { tool: event.name, ok: true, elapsed_ms: result.elapsed_ms, lmstudio_tool_time_ms: status.timeMs,
      output_bytes: outputBytes, returned: result.returned ?? 0 };
  });
  assert.deepEqual(requests[0].parameters, {});
  assert.deepEqual(requests[1].parameters, { query: "file" });
  const id = requests[2].parameters.line_id;
  assert.deepEqual(requests[2].parameters, { line_id: id });
  assert.equal(requests[3].parameters.line_id, id);
  assert.ok(Object.keys(requests[3].parameters).every(key => ["line_id", "before", "after"].includes(key)));
  assert.equal(requests[3].parameters.before ?? 3, 3);
  assert.equal(requests[3].parameters.after ?? 3, 3);
  assert.ok(parsed[1].records.some(r => r.line_id === id && !r.truncated_fields?.includes("line_id")));
  assert.equal(parsed[2].record.line_id, id);
  assert.equal(parsed[3].records[parsed[3].target_index].line_id, id);
  assert.ok(parsed[3].returned <= 7);
  assert.equal(parsed[3].before_requested, 3);
  assert.equal(parsed[3].after_requested, 3);
  const after = await snapshot();
  assert.deepEqual(after, baseline.before);
  let comparison;
  if (values["compare-conversation"]) {
    const prior = read(values["compare-conversation"]);
    const priorContent = prior.messages.flatMap(m => m.versions[m.currentlySelected]?.steps ?? [])
      .flatMap(s => s.content ?? []);
    const priorResults = priorContent.filter(c => c.type === "toolCallResult");
    assert.deepEqual(priorResults.map(r => r.name), expected);
    for (let i=0;i<parsed.length;i++) {
      const {elapsed_ms: previousTime,...previousResult}=JSON.parse(priorResults[i].content);
      const {elapsed_ms: currentTime,...currentResult}=parsed[i];
      assert.deepEqual(currentResult,previousResult,"Retrieval output changed beyond elapsed_ms");
    }
    comparison={conversation:resolve(values["compare-conversation"]),retrieval_outputs_unchanged_except_elapsed_ms:true};
  }
  let instrumentation;
  if (values.jsonl || values["run-id"]) {
    assert.ok(values.jsonl && values["run-id"], "Use --jsonl and --run-id together");
    const raw = readFileSync(resolve(values.jsonl), "utf8");
    assert.ok(raw.endsWith("\n"));
    const logs = raw.slice(0, -1).split("\n").map(line => JSON.parse(line));
    assert.equal(logs.length, calls.length);
    const common = ["run_id", "timestamp", "tool", "elapsed_ms", "returned", "output_bytes", "success"];
    const extras = {
      dataset_overview: ["total_records"], search_records: ["query", "total_matches", "truncated", "max_results", "returned_line_ids", "filters"],
      get_record: ["requested_line_id", "found", "truncated"], get_context: ["requested_line_id", "before", "after", "returned_line_ids"],
    };
    for (let i=0;i<logs.length;i++) {
      const line=logs[i], call=calls[i], result=parsed[i], args=requests[i].parameters;
      assert.equal(line.run_id,values["run-id"]); assert.equal(line.tool,call.tool);
      assert.ok(Number.isFinite(Date.parse(line.timestamp)));
      for (const key of ["elapsed_ms","returned","output_bytes"]) assert.equal(line[key],call[key]);
      assert.equal(line.success,true);
      assert.deepEqual(Object.keys(line).sort(), [...common,...extras[call.tool]].sort());
      if (call.tool==="dataset_overview") assert.equal(line.total_records,result.total_records);
      if (call.tool==="search_records") {
        assert.equal(line.query,args.query); assert.equal(line.total_matches,result.total_matches);
        assert.equal(line.truncated,result.truncated); assert.equal(line.max_results,result.limit);
        assert.deepEqual(line.returned_line_ids,result.records.map(r=>r.line_id)); assert.deepEqual(line.filters,{});
      }
      if (call.tool==="get_record") {
        assert.equal(line.requested_line_id,args.line_id); assert.equal(line.found,result.found); assert.equal(line.truncated,result.truncated);
      }
      if (call.tool==="get_context") {
        assert.equal(line.requested_line_id,args.line_id); assert.equal(line.before,result.before_requested); assert.equal(line.after,result.after_requested);
        assert.deepEqual(line.returned_line_ids,result.records.map(r=>r.line_id));
      }
    }
    assert.equal(config.find(f=>f.key==="SHERPA_RUN_ID").value,values["run-id"]);
    instrumentation={status:"passed",path:resolve(values.jsonl),run_id:values["run-id"],lines:logs.length,
      output_bytes_match:true,metadata_matches:true,only_allowed_fields:true};
  }
  const report = { status: "passed", transport: "LM Studio native chat actual Tool events",
    conversation: resolve(values.conversation), model: chat.lastUsedModel.identifier, database: dbPath,
    before: baseline.before, after, database_unchanged: true, schemas, calls, overview: parsed[0],
    ...(instrumentation ? { instrumentation } : {}), ...(comparison ? { comparison } : {}), created_at_utc: new Date().toISOString() };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, calls, overview: report.overview, database_unchanged: true }));
}
