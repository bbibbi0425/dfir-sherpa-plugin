import {isAbsolute, resolve} from "node:path";
import {realpathSync, statSync} from "node:fs";

export const DB_STATUS_PREFIX = "DFIR_SHERPA_DATABASE:";
export function normalizedDbPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return null;
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

// One provider execution can only use its first valid DB. No database is opened here.
export function createDatabaseBinding() {
  let bound = null;
  let changed = false;
  return path => {
    const requested = normalizedDbPath(path);
    let error = null, message = null, canonical = null;
    if (!requested) {error="DB_NOT_CONFIGURED";message="Set an absolute SQLite path in Canonical timeline DB in LM Studio.";}
    else {
      try {
        canonical = realpathSync(path);
        if (!statSync(canonical).isFile()) throw Error("Not a file");
      } catch {error="DB_NOT_FOUND";message="Canonical timeline DB does not exist or is not an accessible file. Check the LM Studio setting.";}
    }
    changed ||= Boolean(bound && (!requested || normalizedDbPath(bound) !== normalizedDbPath(canonical || path)));
    if (changed) {
      error="DB_PATH_CHANGED";message="The database changed during this Run. Start a NEW LM Studio chat for a different database.";
    }
    if (!error) bound ??= canonical;
    return {path:bound,requested_path:requested ? resolve(path) : null,error,message};
  };
}
