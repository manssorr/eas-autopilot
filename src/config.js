import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "eas-autopilot", "config.json");
}

// A broken config never stops a run: warn once and use no rules, so the human is asked as usual.
export function loadConfig(env = process.env, warn = message => process.stderr.write(`warning: ${message}\n`)) {
  const path = configPath(env);
  if (!existsSync(path)) return { path, autoAccept: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("the file must hold a JSON object");
    const autoAccept = data.autoAccept ?? [];
    if (!Array.isArray(autoAccept)) throw new Error('"autoAccept" must be a list');
    autoAccept.forEach((rule, i) => {
      const where = `autoAccept[${i}]`;
      if (typeof rule?.when?.dir !== "string" || !rule.when.dir.startsWith("/")) throw new Error(`${where}: when.dir must be an absolute path`);
      if (typeof rule.appleId !== "string" || !rule.appleId) throw new Error(`${where}: appleId is required`);
    });
    return { path, autoAccept };
  } catch (error) {
    warn(`ignoring ${path}: ${error.message}. Asking instead of auto-accepting.`);
    return { path, autoAccept: [] };
  }
}

// First rule wins. Both paths are resolved with realpath (symlinks, ..) before the boundary check;
// a path that cannot be resolved never matches. `expoAccount` is ignored when the account is unknown.
export function matchRule(rules, { dir, account }) {
  const real = path => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const runDir = real(dir);
  if (!runDir) return null;
  return (
    rules.find(rule => {
      const prefix = real(rule.when.dir)?.replace(/\/+$/, "");
      if (prefix === undefined || prefix === null) return false;
      if (runDir !== prefix && !runDir.startsWith(prefix + "/")) return false;
      return !rule.when.expoAccount || !account || rule.when.expoAccount === account;
    }) ?? null
  );
}
