import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field("databasePath", "string", {
    displayName: "Canonical timeline DB",
    subtitle: "Required: absolute path to the SQLite timeline for this chat. Opened read-only. Use a new chat to change databases.",
  }, "")
  .field("SHERPA_RUN_ID", "string", {
    displayName: "SHERPA_RUN_ID",
    subtitle: "Experiment run ID. Letters, digits, underscore or hyphen; 1..80 characters. Blank uses the environment variable.",
  }, "")
  .field("SHERPA_LOG_DIR", "string", {
    displayName: "SHERPA_LOG_DIR",
    subtitle: "Absolute directory for append-only Tool JSONL logs. Blank uses the environment variable. Both unset disables logging.",
  }, "")
  .build();
