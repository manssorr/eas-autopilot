import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, matchRule } from "../src/config.js";

const tree = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eas-autopilot-cfg-")));
  for (const sub of ["work/a/app", "workshop"]) mkdirSync(join(root, sub), { recursive: true });
  return root;
};
const configIn = (dir, text) => {
  mkdirSync(join(dir, "eas-autopilot"), { recursive: true });
  writeFileSync(join(dir, "eas-autopilot", "config.json"), text);
  return { XDG_CONFIG_HOME: dir };
};

test("configPath respects XDG_CONFIG_HOME", () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/eas-autopilot/config.json");
  assert.match(configPath({}), /\.config\/eas-autopilot\/config\.json$/);
});

test("loadConfig: a missing file is empty; bad JSON, null and bad rules warn once and give no rules", () => {
  const dir = tree();
  assert.deepEqual(loadConfig({ XDG_CONFIG_HOME: dir }, () => assert.fail("no warning")).autoAccept, []);
  for (const text of ["{nope", "null", JSON.stringify({ autoAccept: [{ when: {}, appleId: "x@example.com" }] }), JSON.stringify({ autoAccept: "x" }), JSON.stringify({ autoAccept: [{ when: { dir: "/x" }, appleId: "x@example.com", startBuild: "yes" }] })]) {
    const warnings = [];
    assert.deepEqual(loadConfig(configIn(dir, text), m => warnings.push(m)).autoAccept, []);
    assert.equal(warnings.length, 1, text);
  }
});

test("matchRule: dir prefix on a path boundary, first match wins, account optional", () => {
  const root = tree();
  const rules = [
    { when: { dir: join(root, "work/a"), expoAccount: "acme" }, appleId: "a@example.com" },
    { when: { dir: join(root, "work") }, appleId: "b@example.com", trust: false },
  ];
  const app = join(root, "work/a/app");
  assert.equal(matchRule(rules, { dir: app, account: "acme" }), rules[0]);
  assert.equal(matchRule(rules, { dir: app, account: "other" }), rules[1]);
  assert.equal(matchRule(rules, { dir: app, account: null }), rules[0]);
  assert.equal(matchRule(rules, { dir: join(root, "workshop"), account: null }), null);
  assert.equal(matchRule(rules, { dir: join(root, "work"), account: null }), rules[1]);
});

test("matchRule: symlinks are resolved on both sides; unresolvable paths never match", () => {
  const root = tree();
  const link = join(root, "link");
  symlinkSync(join(root, "work"), link);
  const rules = [{ when: { dir: link }, appleId: "a@example.com" }];
  assert.equal(matchRule(rules, { dir: join(root, "work/a/app"), account: null }), rules[0]);
  assert.equal(matchRule([{ when: { dir: join(root, "work") }, appleId: "a@example.com" }], { dir: join(link, "a/app"), account: null })?.appleId, "a@example.com");
  assert.equal(matchRule([{ when: { dir: join(root, "nope") }, appleId: "a@example.com" }], { dir: join(root, "nope/app"), account: null }), null);
  assert.equal(matchRule(rules, { dir: join(root, "missing"), account: null }), null);
});
