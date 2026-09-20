import {renameSync} from "node:fs";
const pause=new Int32Array(new SharedArrayBuffer(4));

// Windows readers/antivirus can briefly prevent replacing an existing file.
// Never unlink the destination: a failed replacement must retain the previous state.
export function replaceFile(source,destination,{rename=renameSync,attempts=16}={}) {
  for(let attempt=0;;attempt++) {
    try {rename(source,destination);return;}
    catch(error) {
      if(!["EPERM","EACCES","EBUSY"].includes(error.code)||attempt+1>=attempts)throw error;
      Atomics.wait(pause,0,0,Math.min(20*(attempt+1),100));
    }
  }
}
