import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSearchFixture } from "./searchFixture.mjs";

// Test current source, not an old ignored bundle. Node's TypeScript support strips
// types; these hooks resolve the plugin's extensionless imports and dependencies.
const installedRequire = createRequire(join(homedir(), ".lmstudio", "extensions", "plugins", "local", "dfir-sherpa", "package.json"));
const sourceRoot = new URL("../src/", import.meta.url).href;

test("plugin exposes exactly four analysis tools using configured database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sherpa-plugin-contract-"));
  const environmentKeys = ["SHERPA_CONFIG_PATH", "USERPROFILE", "HOME", "SHERPA_RUN_ID", "SHERPA_LOG_DIR"];
  const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  process.env.SHERPA_CONFIG_PATH = join(root,"local-config.json");
  // A running user Collector must never redirect fixture logs or affect this test.
  process.env.USERPROFILE = root;
  process.env.HOME = root;
  delete process.env.SHERPA_RUN_ID;
  delete process.env.SHERPA_LOG_DIR;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(sourceRoot)) return nextResolve(specifier, context);
    if (specifier === "./config" || specifier === "./toolsProvider") return nextResolve(`${specifier}.ts`, context);
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !["@lmstudio/sdk", "zod"].includes(specifier)) throw error;
      return nextResolve(pathToFileURL(installedRequire.resolve(specifier)).href, context);
    }
  } });
  try {
    assert.equal(homedir(), root);
    const { main } = await import("../src/index.ts");
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
    hooks.deregister();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true });
  }
});
