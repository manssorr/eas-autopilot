import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayChild } from "./child.js";
import { validateFlow } from "./flow.js";
import { createMemory } from "./memory.js";
import { headlessPresenter } from "./presenter.js";
import { createRecorder, readRecording } from "./recorder.js";
import { run } from "./runner.js";

function answerBytes(then) {
  if (!then || then === "continue") return "";
  if (then.answer !== undefined) return then.answer + "\r";
  return null;
}

export async function checkFlow(flow, runDirs) {
  const problems = validateFlow(flow);
  if (problems.length) return { green: false, problems, runs: [] };
  const scratch = mkdtempSync(join(tmpdir(), "eas-autopilot-check-"));
  const runs = [];
  for (const dir of runDirs) {
    const frames = readRecording(dir);
    const header = frames.find(f => f.k === "header") ?? {};
    const child = createReplayChild(frames);
    const presenter = headlessPresenter({
      choose: card => {
        const expected = child.peekExpected();
        const options = flow.rules.flatMap(r => r.do?.choose?.options ?? []).filter(o => card.options.some(c => c.key === o.key));
        if (expected) {
          const match = options.find(o => answerBytes(o.then) !== null && answerBytes(o.then) !== "" && expected.startsWith(answerBytes(o.then)));
          if (match) return match.key;
          const typed = options.find(o => o.then?.ask !== undefined);
          if (typed) return typed.key;
        }
        return options.find(o => o.then === "continue")?.key ?? options.find(o => answerBytes(o.then) === "\r")?.key ?? card.options[0].key;
      },
      ask: () => child.peekExpected() ?? "[secret]\r",
    });
    const recorder = createRecorder(join(scratch, String(runs.length)), { id: "check" });
    const outcome = await run({ flow, params: header.params ?? {}, child, presenter, recorder, memory: createMemory(join(scratch, "memory.json")) });
    recorder.close({});
    const unknown = readRecording(join(scratch, String(runs.length))).filter(f => f.name === "unknown-prompt").map(f => f.q);
    runs.push({ dir, divergence: outcome.divergence?.message ?? null, unknown, asked: presenter.log.filter(e => e.ask).map(e => e.ask) });
  }
  const green = runs.every(r => !r.divergence && r.unknown.length === 0);
  return { green, problems, runs };
}
