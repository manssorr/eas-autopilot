import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { createPtyChild } from "../src/child.js";
import { strip } from "../src/ansi.js";
import { MOCK_COMMAND, NEW_DEVICE, ROOT, ensureMockDeps, mockEnv } from "./helpers.js";

const CLI = join(ROOT, "bin", "eas-autopilot.js");

before(() => ensureMockDeps());

function setup() {
  const mock = mockEnv();
  const app = join(mock.work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "app.json"), '{"expo":{"name":"example"}}\n');
  const git = args => execFileSync("git", ["-C", app, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  const flow = JSON.parse(readFileSync(join(ROOT, "flows", "eas-ios-adhoc.json"), "utf8"));
  flow.command = MOCK_COMMAND;
  const flowPath = join(mock.work, "flow.json");
  writeFileSync(flowPath, JSON.stringify(flow, null, 2));
  const state = join(mock.work, "state");
  return { mock, app, flowPath, state, env: { ...mock.env, EAS_AUTOPILOT_STATE: state } };
}

function drive(args, env, reactions) {
  return new Promise(resolve => {
    const child = createPtyChild(["node", CLI, ...args], { env, cols: 110, rows: 40 });
    let screen = "";
    const fired = reactions.map(() => 0);
    child.onData(data => {
      screen += data;
      const plain = strip(screen);
      reactions.forEach(([pattern, keys, kind = "prompt"], i) => {
        let due;
        if (kind === "card") {
          due = plain.split(pattern).length - 1 > fired[i];
        } else {
          const closes = (plain.match(new RegExp(`[✔✖] ${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g")) ?? []).length;
          due = fired[i] === closes && plain.lastIndexOf(`? ${pattern}`) > Math.max(plain.lastIndexOf(`✔ ${pattern}`), plain.lastIndexOf(`✖ ${pattern}`));
        }
        if (!due) return;
        fired[i] += 1;
        [].concat(keys).forEach((k, j) => setTimeout(() => child.write(k), 500 * (j + 1)));
      });
    });
    child.wait().then(({ code }) => resolve({ code, screen: strip(screen) }));
  });
}

test("run: terminal UI asks twice, answers the rest, prints the install link", async () => {
  const s = setup();
  const { code, screen } = await drive(["run", "--dir", s.app, "--flow", s.flowPath, "--udid", NEW_DEVICE, "--no-follow"], s.env, [
    ["Use this Apple ID?", "\x1b[B\r", "card"],
    ["Ready to build", "\r", "card"],
  ]);
  assert.equal(code, 0, screen.slice(-800));
  assert.match(screen, /Apple ID tester@example\.com \(trusted for 3 days\)/);
  assert.match(screen, /Selected all 20 registered devices/);
  assert.match(screen, /is in this build/);
  assert.match(screen, /Install page: https:\/\/expo\.dev\//);
  assert.equal(s.mock.read().match(/selected \S+ 20\/20/g).length, 3);
});

test("record, learn, check: a human run becomes a checked flow", async () => {
  const s = setup();
  const rec = await drive(["record", "--dir", s.app, "--flow", s.flowPath], s.env, [
    ["Do you want to log in to your Apple account?", "y\r"],
    ["Apple ID:", "\r"],
    ["Would you like to choose the devices to provision again?", "y\r"],
    ["Select devices for the ad hoc build", ["a", "\r"]],
  ]);
  assert.equal(rec.code, 0, rec.screen.slice(-800));
  assert.match(rec.screen, /Select devices for the ad hoc build/);
  const [runId] = readdirSync(join(s.state, "runs"));

  const prompt = execFileSync("node", [CLI, "learn", runId, "--flow", s.flowPath, "--out", join(s.mock.work, "new.json")], { env: s.env, encoding: "utf8" });
  assert.match(prompt, /PROMPT t=[\d.]+s {2}"Select devices for the ad hoc build:"/);
  assert.match(prompt, /keys: {4}human:a {2}human:⏎/);
  assert.match(prompt, /eas-autopilot check .*new\.json/);

  const green = execFileSync("node", [CLI, "check", s.flowPath, runId], { env: s.env, encoding: "utf8" });
  assert.match(green, /green/);

  const wrong = JSON.parse(readFileSync(s.flowPath, "utf8"));
  wrong.rules.find(r => r.id === "apple-login").do = { answer: "n" };
  writeFileSync(join(s.mock.work, "wrong.json"), JSON.stringify(wrong));
  let red = "";
  try {
    execFileSync("node", [CLI, "check", join(s.mock.work, "wrong.json"), runId], { env: s.env, encoding: "utf8" });
  } catch (error) {
    red = error.stdout;
  }
  assert.match(red, /diverged/);
  assert.match(red, /red/);
});
