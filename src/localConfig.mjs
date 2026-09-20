import {existsSync, lstatSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join, isAbsolute} from "node:path";

export const localConfigPath = () => process.env.SHERPA_CONFIG_PATH || join(homedir(), ".lmstudio", "dfir-sherpa", "local-config.json");
export function readLocalConfig(path = localConfigPath()) {
  if (!isAbsolute(path)) throw Error("SHERPA_CONFIG_PATH must be absolute.");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw Error("Unsafe local configuration file.");
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.application !== "dfir-sherpa" || config.version !== 1) throw Error("Unsupported DFIR Sherpa local configuration.");
  for (const field of ["repository_path", "app_path", "lms_path"]) {
    if (typeof config[field] !== "string" || !isAbsolute(config[field]) || /[\x00\r\n]/.test(config[field])) throw Error(`Invalid local configuration: ${field}`);
  }
  // Legacy database_path is deliberately discarded, never used as a fallback.
  const {database_path: _legacyDatabase, ...launcherConfig} = config;
  return launcherConfig;
}
