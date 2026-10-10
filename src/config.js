import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "eas-autopilot", "config.json");
}

export function loadConfig(env = process.env) {
  const path = configPath(env);
  if (!existsSync(path)) return { path, autoAccept: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`bad config ${path}: ${error.message}`);
  }
  const autoAccept = data.autoAccept ?? [];
  if (!Array.isArray(autoAccept)) throw new Error(`bad config ${path}: "autoAccept" must be a list`);
  autoAccept.forEach((rule, i) => {
    const where = `bad config ${path}: autoAccept[${i}]`;
    if (typeof rule.when?.dir !== "string" || !rule.when.dir.startsWith("/")) throw new Error(`${where}: when.dir must be an absolute path`);
    if (typeof rule.appleId !== "string" || !rule.appleId) throw new Error(`${where}: appleId is required`);
  });
  return { path, autoAccept };
}

// First rule wins. `dir` matches on a path boundary; `expoAccount` is ignored when the account is unknown.
export function matchRule(rules, { dir, account }) {
  return (
    rules.find(rule => {
      const prefix = rule.when.dir.replace(/\/+$/, "");
      if (dir !== prefix && !dir.startsWith(prefix + "/")) return false;
      return !rule.when.expoAccount || !account || rule.when.expoAccount === account;
    }) ?? null
  );
}
