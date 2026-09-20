import {parseArgs} from "node:util";
import {startExperiment,stopExperiment} from "./experiment_core.mjs";
const {values,positionals}=parseArgs({allowPositionals:true,options:{
  "run-id":{type:"string"},"results-root":{type:"string"},"conversation-dir":{type:"string"},
  "control-dir":{type:"string"},db:{type:"string"},lms:{type:"string"},help:{type:"boolean"},
}});
if(values.help)console.log("experiment start|stop --run-id ID [--results-root DIR] [--conversation-dir DIR] [--db SQLITE] [--lms EXE]\nUse a fresh LM Studio conversation. One active experiment per user. No login startup registration.");
else {
  const options={runId:values["run-id"],resultsRoot:values["results-root"],conversationDir:values["conversation-dir"],
    controlDir:values["control-dir"],db:values.db,loggerCommand:values.lms?[values.lms]:undefined};
  const action=positionals.length===1 && ({start:startExperiment,stop:stopExperiment})[positionals[0]];
  if(!action){console.error("Use start or stop --run-id ID");process.exitCode=1;}
  else action(options).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
