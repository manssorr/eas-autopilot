import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { createPtyChild, createReplayChild } from "../src/child.js";
import { loadFlow } from "../src/flow.js";
import { createMemory } from "../src/memory.js";
import { headlessPresenter } from "../src/presenter.js";
import { createRecorder, readRecording, RECORDING_FILE } from "../src/recorder.js";
import { run } from "../src/runner.js";
import { MOCK_COMMAND, NEW_DEVICE, ROOT, ensureMockDeps, mockEnv } from "./helpers.js";

const flow = loadFlow(join(ROOT, "flows", "eas-ios-adhoc.json"));

before(() => ensureMockDeps());

async function runMock({ mockVars = {}, choose, ask, params = {}, mode = "run", memoryPath, presenter: given } = {}) {
  const mock = mockEnv(mockVars);
  const dir = join(mock.work, "run");
  const recorder = createRecorder(dir, { id: "test", mode, flow: flow.id, command: MOCK_COMMAND });
  const presenter = given ?? headlessPresenter({ choose, ask });
  const memory = createMemory(memoryPath ?? join(mock.work, "memory.json"));
  const child = createPtyChild(MOCK_COMMAND, { cwd: mock.work, env: mock.env });
  const outcome = await run({ flow, params: { udid: NEW_DEVICE, git: "main @ test", ...params }, child, presenter, recorder, memory, mode });
  recorder.close({ exit: outcome.exit, result: outcome.result, child_code: outcome.childCode });
  return { outcome, mock, dir, presenter, frames: readRecording(dir) };
}

const pick = map => card => map[card.title] ?? "";

test("first run: trust the Apple ID, select every device on every target, confirm", async () => {
  const { outcome, mock, presenter } = await runMock({ choose: pick({ "Use this Apple ID?": "t", "Ready to build": "y" }) });
  assert.equal(outcome.exit, 0);
  assert.equal(outcome.result, "queued");
  assert.equal(mock.read().match(/selected \S+ 20\/20/g).length, 3);
  assert.match(mock.read(), /^uploaded$/m);
  assert.deepEqual(presenter.log.filter(e => e.choose).map(e => e.choose), ["Use this Apple ID?", "Ready to build"]);
});

test("trusted Apple ID is not asked again", async () => {
  const memoryPath = join(mockEnv().work, "memory.json");
  await runMock({ memoryPath, choose: pick({ "Use this Apple ID?": "t", "Ready to build": "y" }) });
  const { presenter, outcome } = await runMock({ memoryPath, choose: pick({ "Ready to build": "y" }) });
  assert.equal(outcome.exit, 0);
  assert.deepEqual(presenter.log.filter(e => e.choose).map(e => e.choose), ["Ready to build"]);
  assert.ok(presenter.log.some(e => /trusted, \d+h left/.test(e.done ?? "")));
});

test("Apple refuses the target device: stop before anything is uploaded", async () => {
  const { outcome, mock } = await runMock({
    mockVars: { EAS_MOCK_FAIL: "1" },
    choose: pick({ "Use this Apple ID?": "y", "Your device is not in this build": "n" }),
  });
  assert.equal(outcome.exit, 3);
  assert.equal(outcome.result, "device-not-provisioned-at-apple");
  assert.doesNotMatch(mock.read(), /^uploaded$/m);
});

test("cancel at the confirmation: nothing is uploaded", async () => {
  const { outcome, mock } = await runMock({ choose: pick({ "Use this Apple ID?": "y", "Ready to build": "n" }) });
  assert.equal(outcome.exit, 4);
  assert.equal(outcome.result, "cancelled");
  assert.doesNotMatch(mock.read(), /^uploaded$/m);
});

test("a typed password never reaches the recording", async () => {
  const { outcome, mock, dir } = await runMock({
    mockVars: { EAS_MOCK_PASSWORD: "1" },
    choose: pick({ "Use this Apple ID?": "y", "Ready to build": "y" }),
    ask: info => (/Password/.test(info.question) ? "hunter2\r" : null),
  });
  assert.equal(outcome.exit, 0);
  assert.match(mock.read(), /password hunter2/);
  const recording = readFileSync(join(dir, RECORDING_FILE), "utf8");
  assert.equal(recording.includes("hunter2"), false);
  assert.match(recording, /"secret":true/);
});

test("learn mode records a human run that replays through the flow", async () => {
  const human = scriptedHuman({
    "Do you want to log in to your Apple account?": ["y\r"],
    "Apple ID:": ["\r"],
    "Would you like to choose the devices to provision again?": ["y\r"],
    "Select devices for the ad hoc build:": ["a", "\r"],
  });
  const { frames, outcome: recorded } = await runMock({ mode: "learn", presenter: human });
  assert.equal(recorded.exit, 0);
  assert.ok(frames.some(f => f.k === "in" && f.by === "human"));

  const replay = createReplayChild(frames);
  const presenter = headlessPresenter({ choose: pick({ "Use this Apple ID?": "y", "Ready to build": "y" }) });
  const recorder = createRecorder(join(mockEnv().work, "replay"), { id: "replay" });
  const outcome = await run({ flow, params: { udid: NEW_DEVICE }, child: replay, presenter, recorder, memory: createMemory(join(mockEnv().work, "m.json")) });
  recorder.close({});
  assert.equal(outcome.divergence, null, outcome.divergence?.message);
  assert.equal(outcome.exit, 0);
});

test("a flow that answers differently from the human diverges on replay", async () => {
  const human = scriptedHuman({
    "Do you want to log in to your Apple account?": ["n\r"],
  });
  const { frames } = await runMock({ mode: "learn", presenter: human, stopAfter: "Do you want to log in" });
  const replay = createReplayChild(frames);
  const recorder = createRecorder(join(mockEnv().work, "replay"), { id: "replay" });
  const outcome = await run({ flow, child: replay, presenter: headlessPresenter(), recorder, memory: createMemory(join(mockEnv().work, "m.json")) });
  recorder.close({});
  assert.ok(outcome.divergence, "expected a divergence");
  assert.equal(outcome.divergence.got, "y\r");
});

function scriptedHuman(script) {
  let sink = null;
  let buffer = "";
  let cursor = 0;
  let last = null;
  return {
    attach: next => (sink = next),
    showsRaw: () => true,
    raw: data => {
      buffer += data;
      const header = /\x1b\[36m\?\x1b\[39m \x1b\[1m([^\x1b]+)\x1b\[22m/g;
      header.lastIndex = cursor;
      let match;
      while ((match = header.exec(buffer))) {
        cursor = header.lastIndex;
        const question = match[1].trim();
        if (question === last) continue;
        last = question;
        const keys = script[question];
        if (!keys) {
          sink.interrupt();
          continue;
        }
        keys.forEach((key, i) => setTimeout(() => sink.input(key), 400 * (i + 1)));
      }
      if (/✔/.test(data)) last = null;
    },
    phase() {}, sub() {}, done() {}, warn() {},
    choose: async () => "",
    ask: async (_, answered) => answered(),
    close() {},
  };
}
