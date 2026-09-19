import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchFixture } from "./searchFixture.mjs";

// Build src/index.ts into this bundle before this contract test; no LM Studio writes.
const { main } = createRequire(import.meta.url)("../outputs/plugin-check.cjs");

test("bundled plugin exposes exactly four analysis tools using configured database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sherpa-plugin-contract-"));
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
    const tools = await provider({ getPluginConfig(value) {
      assert.equal(value, schematics);
      reads++;
      return { get(key) { assert.equal(key, "databasePath"); return configuredPath; } };
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
    configuredPath = "";
    assert.equal((await search.implementation({})).error, "DB_NOT_CONFIGURED");
    assert.equal((await tools[0].implementation({})).error, "DB_NOT_CONFIGURED");
  } finally { rmSync(root, { recursive: true }); }
});
