import {runWorker} from "./experiment_core.mjs";
runWorker(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
