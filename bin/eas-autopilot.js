#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFlow } from "../src/check.js";
import { createPtyChild } from "../src/child.js";
import { interpolate, loadFlow } from "../src/flow.js";
import { agentPrompt } from "../src/learn.js";
import { createMemory } from "../src/memory.js";
import { passthroughPresenter, terminalPresenter } from "../src/presenter.js";
import { createRecorder, readRecording } from "../src/recorder.js";
import { run } from "../src/runner.js";
import { summarize } from "../src/summarize.js";
import { checkDeviceInBuild, followBuild } from "../src/verify.js";
import { ensureCleanTree, gitInfo } from "../src/workspace.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const STATE = process.env.EAS_AUTOPILOT_STATE ?? join(homedir(), ".local", "state", "eas-autopilot");
const RUNS = join(STATE, "runs");
const USER_FLOWS = join(STATE, "flows");

const cleanups = [];
const cleanup = () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn();
    } catch {}
  }
  process.stdout.write("\x1b[?25h");
};
for (const signal of ["SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
  });
}

const HELP = `eas-autopilot ${VERSION}

Usage:
  eas-autopilot [run] [--dir <app>] [--flow <id|file>] [--profile <name>] [--udid <UDID>] [--wait] [--yes] [--no-follow]
  eas-autopilot record [--dir <app>] [--flow <id|file>] [--profile <name>] [-- <command…>]
  eas-autopilot learn <run-id|latest> [--flow <id|file>] [--out <file>]
  eas-autopilot check <flow-file|id> [run-id…]
  eas-autopilot history [N]

run      run a command through a Flow: routine prompts answered, real decisions asked
record   run the command untouched (plain EAS screen) and record every byte and key
learn    print an agent prompt that turns a recorded run into a Flow
check    replay recorded runs through a Flow and report divergences
history  list recent runs

Default flow: eas-ios-adhoc. State and recordings: ${STATE}
`;

function parse(argv) {
  const args = { _: [], rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (["wait", "yes", "help", "version", "no-follow"].includes(key)) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function resolveFlowPath(ref = "eas-ios-adhoc") {
  if (existsSync(ref)) return resolve(ref);
  for (const dir of [USER_FLOWS, join(ROOT, "flows")]) {
    const path = join(dir, `${ref}.json`);
    if (existsSync(path)) return path;
  }
  throw new Error(`flow not found: ${ref}`);
}

function runDir(ref) {
  if (ref === "latest" || !ref) {
    const ids = existsSync(RUNS) ? readdirSync(RUNS).sort() : [];
    if (!ids.length) throw new Error("no recorded runs yet");
    return join(RUNS, ids.at(-1));
  }
  return existsSync(ref) ? resolve(ref) : join(RUNS, ref);
}

function easCliVersion(dir, command) {
  if (!command.includes("eas-cli")) return null;
  try {
    return execFileSync("npx", ["eas-cli", "--version"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(" ")[0].replace("eas-cli/", "");
  } catch {
    return null;
  }
}

function finishRun(dir) {
  const meta = summarize(readRecording(dir));
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  appendFileSync(join(STATE, "runs.jsonl"), JSON.stringify(meta) + "\n");
  return meta;
}

function prepare(args, mode) {
  const dir = resolve(args.dir ?? process.cwd());
  const flowPath = args.rest ? null : resolveFlowPath(args.flow);
  const flow = flowPath ? loadFlow(flowPath) : null;
  const git = gitInfo(dir);
  const params = { profile: args.profile, udid: args.udid, yes: args.yes ? "1" : "", git: git ? `${git.branch} @ ${git.sha}` : "" };
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  const vars = { ...Object.fromEntries(Object.entries(flow?.params ?? {}).map(([k, v]) => [k, v.default])), ...params };
  const command = args.rest ?? flow.command.map(part => interpolate(part, vars));
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${process.pid}`;
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const header = { id, mode, flow: flow?.id ?? null, command, cwd: dir, cols, rows, tool: VERSION, eas_cli: easCliVersion(dir, command), git, params };
  return { dir, flow, git, params, command, id, cols, rows, header };
}

function banner(ctx, mode) {
  const title = ctx.flow ? `${ctx.flow.id}` : ctx.command.join(" ");
  process.stdout.write(`\n  \x1b[1m📦 ${title}\x1b[0m \x1b[2m${mode} · eas-autopilot ${VERSION}\x1b[0m\n`);
  if (ctx.git) process.stdout.write(`  \x1b[2m${ctx.git.branch} @ ${ctx.git.sha}${ctx.header.eas_cli ? ` · eas-cli ${ctx.header.eas_cli}` : ""}\x1b[0m\n`);
  process.stdout.write(`  \x1b[2mrecording: ${join(RUNS, ctx.id)}\x1b[0m\n\n`);
}

function cleanTreeOrExit(ctx) {
  if (!ctx.git) return;
  const tree = ensureCleanTree(ctx.git.root);
  for (const file of tree.restored ?? []) process.stdout.write(`  ↺ whitespace-only, restored: ${file}\n`);
  if (!tree.clean) {
    process.stderr.write(`\x1b[31m✗\x1b[0m Working tree has real changes. Commit or discard these first:\n${tree.status}\n`);
    process.exit(1);
  }
}

async function commandRun(args) {
  const ctx = prepare(args, "run");
  banner(ctx, "run");
  cleanTreeOrExit(ctx);
  const dir = join(RUNS, ctx.id);
  const recorder = createRecorder(dir, ctx.header);
  const presenter = terminalPresenter({ hints: ctx.flow.hints ?? [] });
  cleanups.push(() => presenter.close());
  presenter.done("🧹 Working tree clean");
  const child = createPtyChild(ctx.command, { cwd: ctx.dir, cols: ctx.cols, rows: ctx.rows });
  cleanups.push(() => child.kill());
  const outcome = await run({ flow: ctx.flow, params: ctx.params, child, presenter, recorder, memory: createMemory(join(STATE, "memory.json")), mode: "run" });
  const end = { exit: outcome.exit, result: outcome.result, child_code: outcome.childCode, build_url: outcome.vars.build_url ?? null };

  if (outcome.exit === 0 && outcome.vars.build_url && (args.wait || args.udid) && !args["no-follow"]) {
    const buildId = outcome.vars.build_url.split("/").at(-1);
    const labels = { NEW: "🧍 Waiting in the EAS queue", IN_QUEUE: "🧍 Waiting in the EAS queue", IN_PROGRESS: "🔨 Building on EAS" };
    const status = await followBuild(ctx.dir, buildId, (next, previous) => {
      if (previous === "IN_QUEUE" || previous === "NEW") presenter.done("🏁 Left the queue");
      if (labels[next]) presenter.phase(labels[next]);
    });
    end.build_status = status;
    if (status !== "FINISHED") {
      end.exit = 1;
      end.result = `build-${status.toLowerCase()}`;
    } else {
      presenter.done("🎉 Build finished");
      if (args.udid) {
        presenter.phase(`🔎 Looking for ${args.udid} in each provisioning profile`);
        const profiles = checkDeviceInBuild(ctx.dir, buildId, args.udid);
        for (const p of profiles) (p.present ? presenter.done : presenter.warn)(`📱 ${p.name} (${p.devices} devices)${p.present ? "" : " is missing the device"}`);
        end.udid_check = profiles.every(p => p.present) ? "present" : "missing";
        if (end.udid_check === "missing") {
          end.exit = 1;
          end.result = "udid-missing";
        }
      }
    }
  }
  presenter.close();
  recorder.close(end);
  const meta = finishRun(dir);

  if (outcome.message) process.stdout.write(`\n  ${end.exit === 0 ? "\x1b[32m✔" : "\x1b[31m✗"}\x1b[0m ${outcome.message}\n`);
  if (end.udid_check === "present") process.stdout.write(`\n  \x1b[1;32m🥳 ${args.udid} can install this build\x1b[0m\n`);
  if (end.build_url) process.stdout.write(`\n  \x1b[1m🔗 Install page:\x1b[0m ${end.build_url}\n`);
  if (meta.unknown_prompts.length) process.stdout.write(`\n  \x1b[33m⚠\x1b[0m ${meta.unknown_prompts.length} prompt(s) this flow does not know. Teach it: eas-autopilot learn ${ctx.id}\n`);
  process.stdout.write(`  \x1b[2m🗂  ${meta.result} · run ${ctx.id}\x1b[0m\n`);
  process.exit(end.exit);
}

async function commandRecord(args) {
  const ctx = prepare(args, "record");
  banner(ctx, "record");
  const dir = join(RUNS, ctx.id);
  const recorder = createRecorder(dir, ctx.header);
  const presenter = passthroughPresenter();
  cleanups.push(() => presenter.close());
  const child = createPtyChild(ctx.command, { cwd: ctx.dir, cols: ctx.cols, rows: ctx.rows });
  cleanups.push(() => child.kill());
  const outcome = await run({ flow: ctx.flow, params: ctx.params, child, presenter, recorder, memory: null, mode: "learn" });
  presenter.close();
  recorder.close({ exit: outcome.childCode, result: outcome.childCode === 0 ? "recorded" : "recorded-failed", child_code: outcome.childCode, build_url: outcome.vars.build_url ?? null });
  finishRun(dir);
  process.stdout.write(`\n\n  \x1b[32m✔\x1b[0m recorded run ${ctx.id}\n  next: eas-autopilot learn ${ctx.id} > prompt.md, give it to an agent, then eas-autopilot check <flow> ${ctx.id}\n`);
  process.exit(outcome.childCode);
}

function commandLearn(args) {
  const dir = runDir(args._[1]);
  const frames = readRecording(dir);
  const header = frames.find(f => f.k === "header") ?? {};
  const flowRef = args.flow ?? header.flow;
  let flowText = null;
  let flowId = flowRef ?? "new-flow";
  if (flowRef) {
    const path = resolveFlowPath(flowRef);
    flowText = readFileSync(path, "utf8");
    flowId = JSON.parse(flowText).id;
  }
  const out = args.out ?? join(USER_FLOWS, `${flowId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(agentPrompt({ frames, runId: header.id ?? dir, flowText, outputPath: out }));
}

async function commandCheck(args) {
  const flowPath = resolveFlowPath(args._[1]);
  const flow = JSON.parse(readFileSync(flowPath, "utf8"));
  let dirs = args._.slice(2).map(runDir);
  if (!dirs.length && existsSync(RUNS)) {
    dirs = readdirSync(RUNS)
      .map(id => join(RUNS, id))
      .filter(dir => {
        try {
          return readRecording(dir).find(f => f.k === "header")?.flow === flow.id;
        } catch {
          return false;
        }
      });
  }
  const report = await checkFlow(flow, dirs);
  for (const problem of report.problems) process.stdout.write(`  ✘ ${problem}\n`);
  for (const r of report.runs) {
    const id = r.dir.split("/").at(-1);
    if (r.divergence) process.stdout.write(`  ✘ ${id}: ${r.divergence}\n`);
    else if (r.unknown.length) process.stdout.write(`  ✘ ${id}: prompts with no rule: ${r.unknown.join(" | ")}\n`);
    else process.stdout.write(`  ✔ ${id}${r.asked.length ? ` (asks the human: ${r.asked.join(" | ")})` : ""}\n`);
  }
  if (!report.runs.length && !report.problems.length) process.stdout.write("  (no recorded runs for this flow)\n");
  process.stdout.write(report.green && !report.problems.length ? "green\n" : "red\n");
  process.exit(report.green && !report.problems.length ? 0 : 1);
}

function commandHistory(args) {
  const file = join(STATE, "runs.jsonl");
  if (!existsSync(file)) return process.stdout.write("No runs yet.\n");
  const rows = readFileSync(file, "utf8").trim().split("\n").slice(-(Number(args._[1]) || 10));
  for (const row of rows) {
    const m = JSON.parse(row);
    process.stdout.write(`${m.started_at}  ${m.tool_version}  ${m.mode ?? "run"}  ${m.result}  ${m.duration_s}s  ${m.git?.sha ?? "-"}  ${m.build?.url ?? "-"}  ${m.run_id}\n`);
  }
}

const args = parse(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
mkdirSync(RUNS, { recursive: true, mode: 0o700 });
const commands = { run: commandRun, record: commandRecord, learn: commandLearn, check: commandCheck, history: commandHistory };
const name = commands[args._[0]] ? args._[0] : "run";
Promise.resolve(commands[name](args)).catch(error => {
  cleanup();
  process.stderr.write(`\x1b[31m✗\x1b[0m ${error.message}\n`);
  process.exit(1);
});
