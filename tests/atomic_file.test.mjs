import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,renameSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {replaceFile} from "../scripts/atomic_file.mjs";

test("transient Windows sharing violation retains valid old state until replacement succeeds",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sherpa-atomic-")),old=join(dir,"state.json"),next=join(dir,"next.json");
  try {
    writeFileSync(old,'{"ready":false}');writeFileSync(next,'{"ready":true}');let calls=0;
    replaceFile(next,old,{rename:(a,b)=>{
      if(calls++<2){assert.deepEqual(JSON.parse(readFileSync(old)),{ready:false});throw Object.assign(Error("busy"),{code:"EPERM"});}
      renameSync(a,b);
    }});
    assert.deepEqual(JSON.parse(readFileSync(old)),{ready:true});assert.equal(calls,3);
  } finally {rmSync(dir,{recursive:true});}
});

test("permanent replacement failure preserves both the original and recovery temp file",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sherpa-atomic-")),old=join(dir,"state.json"),next=join(dir,"next.json");
  try {
    writeFileSync(old,'{"ready":false}');writeFileSync(next,'{"ready":true}');
    assert.throws(()=>replaceFile(next,old,{attempts:2,rename:()=>{throw Object.assign(Error("busy"),{code:"EPERM"});}}),/busy/);
    assert.deepEqual(JSON.parse(readFileSync(old)),{ready:false});assert.deepEqual(JSON.parse(readFileSync(next)),{ready:true});
  } finally {rmSync(dir,{recursive:true});}
});
