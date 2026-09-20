import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createSearchFixture} from "./searchFixture.mjs";
import {install, reset, removeInstalledPlugin} from "../scripts/setup.mjs";
import {readLocalConfig} from "../src/localConfig.mjs";
import {Collector} from "../scripts/collector_core.mjs";

const hash=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
async function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),"sherpa-setup-"));
  try {
    const databasePath=join(dir,"한글 timeline.sqlite"),configPath=join(dir,"profile","local-config.json");
    createSearchFixture(databasePath);const before=hash(databasePath),calls=[];
    const options={databasePath,configPath,repository:dir,appPath:process.execPath,lmsPath:process.execPath,
      run:(exe,args,opts)=>{calls.push({exe,args,opts});return "--install --yes";},link:()=>{},stop:async()=>{}};
    await fn({dir,options,calls});assert.equal(hash(databasePath),before);
  } finally {rmSync(dir,{recursive:true});}
}
test("setup installs plugin and shortcut without requiring or saving any database",()=>fixture(async({dir,options,calls})=>{
  delete options.databasePath;
  const links=[];options.link=(...args)=>links.push(args);
  const result=await install(options),config=readLocalConfig(options.configPath);
  assert.equal(result.status,"installed");assert.equal(result.results_root,join(dir,"outputs","results"));
  assert.equal(Object.hasOwn(config,"database_path"),false);
  assert.equal(readFileSync(options.configPath,"utf8").includes("database_path"),false);
  assert.deepEqual(calls.map(c=>c.args),[["dev","--help"],["dev","--install","--yes"]]);
  assert.equal(calls[1].opts.cwd,dir);assert.deepEqual(links.map(c=>c[0]),["check","create"]);
}));
test("missing CLI does not invoke installation or write config",()=>fixture(async({dir,options,calls})=>{
  await assert.rejects(install({...options,lmsPath:join(dir,"absent.exe")}));
  assert.equal(calls.length,0);assert.equal(existsSync(options.configPath),false);
}));
test("CLI failure and shortcut failure cannot report success or replace prior config",()=>fixture(async({options})=>{
  await install(options);const before=readFileSync(options.configPath);
  await assert.rejects(install({...options,run:()=>{throw Error("install failed");}}),/install failed/);
  assert.deepEqual(readFileSync(options.configPath),before);
  await assert.rejects(install({...options,link:action=>{if(action==="create")throw Error("denied");}}),/shortcut creation failed/);
  assert.deepEqual(readFileSync(options.configPath),before);
}));
test("reset/uninstall preserve evidence and results; reset retains plugin, uninstall requests removal",()=>fixture(async({dir,options})=>{
  await install(options);const results=join(dir,"outputs","results");mkdirSync(results,{recursive:true});
  const artifact=join(results,"kept.json");writeFileSync(artifact,"{}");let removed=0;const links=[];
  const opts={configPath:options.configPath,stop:async()=>{},link:action=>links.push(action),removePlugin:()=>removed++};
  assert.equal((await reset(opts)).status,"reset");assert.equal(removed,0);assert.ok(existsSync(artifact));
  assert.equal(readLocalConfig(options.configPath),null);await install(options);
  assert.equal((await reset({...opts,uninstall:true})).status,"uninstalled");
  assert.equal(removed,1);assert.ok(links.includes("remove"));assert.ok(existsSync(artifact));
}));
test("uninstall refuses another plugin and removes only a verified local Sherpa installation",()=>fixture(async({dir})=>{
  const plugin=join(dir,"plugin");mkdirSync(plugin);
  const manifest=join(plugin,"manifest.json");writeFileSync(manifest,JSON.stringify({owner:"other",name:"dfir-sherpa",type:"plugin"}));
  assert.throws(()=>removeInstalledPlugin(plugin),/identity mismatch/);assert.ok(existsSync(plugin));
  writeFileSync(manifest,JSON.stringify({owner:"local",name:"dfir-sherpa",type:"plugin"}));
  removeInstalledPlugin(plugin);assert.equal(existsSync(plugin),false);
}));
test("legacy DB setting is discarded and reinstallation removes it from disk",()=>fixture(async({options})=>{
  assert.equal(readLocalConfig(options.configPath),null);await install(options);
  const config=JSON.parse(readFileSync(options.configPath,"utf8"));
  writeFileSync(options.configPath,JSON.stringify({...config,database_path:options.databasePath}));
  assert.equal(Object.hasOwn(readLocalConfig(options.configPath),"database_path"),false);
  await install(options);assert.equal(readFileSync(options.configPath,"utf8").includes("database_path"),false);
  writeFileSync(options.configPath,'{"application":"other"}');
  assert.throws(()=>readLocalConfig(options.configPath),/Unsupported/);
}));

test("collector never falls back to local config when the conversation has no database",()=>fixture(async({dir,options})=>{
  await install(options);const previous=process.env.SHERPA_CONFIG_PATH;process.env.SHERPA_CONFIG_PATH=options.configPath;
  try {
    const conversationDir=join(dir,"conversations"),resultsRoot=join(dir,"results");mkdirSync(conversationDir);
    const chat={plugins:["local/dfir-sherpa"],messages:[{currentlySelected:0,versions:[{role:"assistant",steps:[
      {type:"contentBlock",content:[{type:"toolCallRequest",callId:"fixture-call",name:"dataset_overview",parameters:{},pluginIdentifier:"local/dfir-sherpa"}]}]}]}]};
    writeFileSync(join(conversationDir,"fixture.conversation.json"),JSON.stringify(chat));
    const collector=new Collector({conversationDir,resultsRoot,desktop:true,settleMs:0});await collector.poll();
    const [record]=collector.records.values();assert.equal(record.database.path,null);
    assert.equal(record.database.before,null);assert.equal(record.database.binding_error,"DB_METADATA_UNAVAILABLE");
  } finally {if(previous===undefined)delete process.env.SHERPA_CONFIG_PATH;else process.env.SHERPA_CONFIG_PATH=previous;}
}));
