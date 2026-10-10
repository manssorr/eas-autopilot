import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, matchRule } from "../src/config.js";

const rules = [
  { when: { dir: "/work/a", expoAccount: "acme" }, appleId: "a@example.com", trust: true },
  { when: { dir: "/work" }, appleId: "b@example.com", trust: false },
];

test("configPath respects XDG_CONFIG_HOME", () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/eas-autopilot/config.json");
  assert.match(configPath({}), /\.config\/eas-autopilot\/config\.json$/);
});

test("loadConfig: missing file is empty, bad rules are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "eas-autopilot-cfg-"));
  const env = { XDG_CONFIG_HOME: dir };
  assert.deepEqual(loadConfig(env).autoAccept, []);
  mkdirSync(join(dir, "eas-autopilot"));
  writeFileSync(join(dir, "eas-autopilot", "config.json"), JSON.stringify({ autoAccept: [{ when: {}, appleId: "x@example.com" }] }));
  assert.throws(() => loadConfig(env), /when\.dir/);
});

test("matchRule: dir prefix on a path boundary, first match wins, account optional", () => {
  assert.equal(matchRule(rules, { dir: "/work/a/app", account: "acme" }), rules[0]);
  assert.equal(matchRule(rules, { dir: "/work/a/app", account: "other" }), rules[1]);
  assert.equal(matchRule(rules, { dir: "/work/a/app", account: null }), rules[0]);
  assert.equal(matchRule(rules, { dir: "/workshop", account: null }), null);
  assert.equal(matchRule(rules, { dir: "/work", account: null }), rules[1]);
});
