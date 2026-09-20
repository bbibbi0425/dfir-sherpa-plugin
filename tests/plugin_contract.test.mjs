import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchFixture } from "./searchFixture.mjs";

// Build src/index.ts into this bundle before this contract test; no LM Studio writes.
const { main } = createRequire(import.meta.url)("../outputs/plugin-check.cjs");

test("bundled plugin exposes exactly four analysis tools using configured database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sherpa-plugin-contract-"));
  const originalConfig = process.env.SHERPA_CONFIG_PATH;
  process.env.SHERPA_CONFIG_PATH = join(root,"local-config.json");
  try {
    const database = join(root, "fixture.sqlite");
    createSearchFixture(database);
    let provider;
    let schematics;
    await main({
      withConfigSchematics(value) { schematics = value; return this; },
      withToolsProvider(value) { provider = value; return this; },
    });
    assert.ok(schematics);
    let reads = 0;
    let configuredPath = database;
    let loggingEnabled = false;
    const tools = await provider({ getPluginConfig(value) {
      assert.equal(value, schematics);
      reads++;
      return { get(key) {
        if (key === "databasePath") return configuredPath;
        if (key === "SHERPA_RUN_ID") return loggingEnabled ? "contract" : "";
        if (key === "SHERPA_LOG_DIR") return loggingEnabled ? root : "";
        assert.fail(`Unknown config key: ${key}`);
      } };
    } });
    assert.deepEqual(tools.map(tool => tool.name), ["dataset_overview", "search_records", "get_record", "get_context"]);
    assert.equal(reads, 0);
    tools[0].checkParameters({});
    const overview = await tools[0].implementation({});
    assert.equal(overview.ok, true);
    assert.equal(overview.total_records, 40);
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) <= 2048);
    assert.equal(reads, 1);
    const search = tools[1];
    search.checkParameters({ query: "quartz" });
    assert.throws(() => search.checkParameters({ limit: 11 }));
    assert.throws(() => search.checkParameters({ limit: null }));
    const result = await search.implementation({ query: "quartz" });
    assert.equal(result.ok, true);
    assert.equal(result.total_matches, 40);
    assert.equal(result.returned, 8);
    assert.equal(reads, 2);
    const record = tools[2];
    const context = tools[3];
    record.checkParameters({ line_id: "sample-020" });
    assert.throws(() => record.checkParameters({ line_id: "" }));
    assert.equal((await record.implementation({ line_id: "sample-020" })).returned, 1);
    context.checkParameters({ line_id: "sample-020" });
    assert.throws(() => context.checkParameters({ line_id: "sample-020", before: 6 }));
    assert.throws(() => context.checkParameters({ line_id: "sample-020", after: -1 }));
    assert.equal((await context.implementation({ line_id: "sample-020" })).returned, 7);
    // Compare enabled vs disabled retrieval; wall-clock elapsed_ms varies naturally.
    const inputs = [{}, { query: "quartz" }, {line_id:"sample-020"}, {line_id:"sample-020"}];
    const markers = [];
    for (let i=0;i<tools.length;i++) await tools[i].implementation(inputs[i], {status: message=>markers.push(message)});
    assert.equal(markers.length,4);
    assert.equal(new Set(markers).size,1);
    assert.ok(markers[0].startsWith("DFIR_SHERPA_RUN:"));
    assert.equal((await tools[0].implementation({}, {status:()=>{throw Error("status unavailable");}})).ok,true);
    const withoutLogs = [];
    for (let i=0;i<tools.length;i++) withoutLogs.push(await tools[i].implementation(inputs[i]));
    loggingEnabled = true;
    for (let i=0;i<tools.length;i++) {
      const logged = await tools[i].implementation(inputs[i]);
      const {elapsed_ms:a,...before}=withoutLogs[i], {elapsed_ms:b,...after}=logged;
      assert.deepEqual(after,before);
    }
    const lines=readFileSync(join(root,"contract_tools.jsonl"),"utf8").trimEnd().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map(l=>l.tool),tools.map(t=>t.name));
    configuredPath = "";
    assert.equal((await search.implementation({})).error, "DB_PATH_CHANGED");
    assert.equal((await tools[0].implementation({})).error, "DB_PATH_CHANGED");
    writeFileSync(process.env.SHERPA_CONFIG_PATH,JSON.stringify({application:"dfir-sherpa",version:1,
      database_path:database,repository_path:root,app_path:process.execPath,lms_path:process.execPath}));
    loggingEnabled = false;
    const fresh = await provider({getPluginConfig:()=>({get:key=>key==="databasePath"?configuredPath:""})});
    assert.equal((await fresh[0].implementation({})).error,"DB_NOT_CONFIGURED");
    configuredPath=join(root,"missing.sqlite");
    assert.equal((await fresh[0].implementation({})).error,"DB_NOT_FOUND");
    configuredPath=database;
    assert.equal((await fresh[0].implementation({})).ok,true);
    const other=join(root,"other.sqlite");createSearchFixture(other);configuredPath=other;
    for (const [i,t] of fresh.entries()) assert.equal((await t.implementation(inputs[i])).error,"DB_PATH_CHANGED");
    configuredPath=database;
    assert.equal((await fresh[0].implementation({})).error,"DB_PATH_CHANGED");
  } finally {
    if(originalConfig===undefined)delete process.env.SHERPA_CONFIG_PATH;else process.env.SHERPA_CONFIG_PATH=originalConfig;
    rmSync(root, { recursive: true });
  }
});
