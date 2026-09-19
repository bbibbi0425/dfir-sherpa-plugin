import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field("databasePath", "string", {
    displayName: "Canonical timeline DB",
    subtitle: "Absolute path to the canonical SQLite DB with a timeline table. Opened read-only.",
  }, "")
  .build();
