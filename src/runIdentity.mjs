import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

export const RUN_STATUS_PREFIX = "DFIR_SHERPA_RUN:";
export const validRunId = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) &&
  !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(id);

export function makeRunId(databasePath, now = new Date(), suffix = randomUUID().slice(0, 8)) {
  const name = typeof databasePath === "string" ? basename(databasePath, extname(databasePath)) : "";
  const prefix = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name) ? name : "run";
  const pad = value => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${stamp}${suffix ? "_" + suffix : ""}`;
}
