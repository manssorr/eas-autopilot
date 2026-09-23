import { PROMPT_HEADER, escapeRegExp, strip } from "./ansi.js";
import { capture, interpolate, renderLines, test } from "./flow.js";

const DEFAULT_SECRETS = ["password|passcode|passphrase|two-factor|2FA|\\bcode\\b|token"];
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(.+)$/;
const PROGRESS_BAR = /\|[■ ]+\|\s+(.+\.\.\.)$/;
const DONE_LINE = /^✔\s+(.+)$/;
const ANSWER_TIMEOUT_MS = 120000;

export async function run({ flow, params = {}, child, presenter, recorder, memory, mode = "run" }) {
  const vars = { ...defaults(flow), ...params };
  const rules = flow?.rules ?? [];
  const secrets = [...DEFAULT_SECRETS, ...(flow?.secrets ?? [])].map(source => new RegExp(source, "i"));
  const outputCursor = new Map();
  const fired = new Set();

  let raw = "";
  let plain = "";
  let headerCursor = 0;
  let lineCursor = 0;
  let active = null;
  let pending = null;
  let finished = null;
  let lastSub = "";
  let queue = Promise.resolve();
  let rescan = null;
  let carry = "";
  let lastDoneRaw = 0;
  let lastHumanAnswer = 0;
  let childExited = false;
  child.wait().then(() => (childExited = true));

  const enqueue = task => {
    queue = queue.then(task).catch(error => {
      if (!finished) finished = { exit: 1, result: "runner-error", message: error.message };
      child.interrupt();
    });
  };

  const send = (data, by = "flow") => {
    recorder.in(data, by);
    child.write(data);
  };

  presenter.attach?.({
    input: data => send(data, "human"),
    interrupt: () => {
      if (!finished) finished = { exit: 130, result: "interrupted" };
      recorder.mark("decision", { text: "interrupted by the human" });
      child.interrupt();
    },
  });

  const step = text => {
    presenter.done(text);
    recorder.mark("step", { text });
  };

  const scanProgress = () => {
    const boundary = Math.max(plain.lastIndexOf("\n"), plain.lastIndexOf("\r"));
    if (boundary < lineCursor) return;
    const lines = plain.slice(lineCursor, boundary).split(/[\r\n]+/);
    lineCursor = boundary + 1;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const done = line.match(DONE_LINE);
      if (done && !/[›…]/.test(done[1])) step(done[1]);
      const sub = line.match(SPINNER) ?? line.match(PROGRESS_BAR);
      if (sub && sub[1] !== lastSub) {
        lastSub = sub[1];
        presenter.sub(sub[1]);
      }
    }
  };

  const scanOutputRules = () => {
    rules.forEach((rule, i) => {
      if (!rule.on?.output || finished) return;
      if (rule.once && fired.has(i)) return;
      const regex = new RegExp(rule.on.output, "g");
      regex.lastIndex = outputCursor.get(i) ?? 0;
      const match = regex.exec(plain);
      if (!match) return;
      outputCursor.set(i, regex.lastIndex);
      if (test(rule.skip_if, vars) && rule.skip_if) return;
      if (!test(rule.when, vars)) return;
      fired.add(i);
      if (mode === "run" && rule.do?.choose?.pause) child.pause();
      capture(rule.capture, match[0], vars);
      recorder.mark("rule", { rule: rule.id ?? i, on: "output" });
      if (rule.phase) presenter.phase(interpolate(rule.phase, vars));
      if (rule.do && mode === "run") enqueue(() => perform(rule.do, rule));
      else if (rule.show) step(interpolate(rule.show, vars));
      if (rule.do && mode === "run" && rule.show) enqueue(() => step(interpolate(rule.show, vars)));
    });
  };

  const offsets = [[0, 0]];
  const plainAt = rawIndex => {
    let best = 0;
    for (const [rawEnd, plainStart] of offsets) if (rawEnd <= rawIndex) best = plainStart;
    return best;
  };

  const answered = prompt => {
    const pattern = new RegExp(`(✔|✖)[^\\r\\n]*${escapeRegExp(prompt.q)}`);
    return pattern.test(plain.slice(prompt.plainStart));
  };

  const waitAnswered = (prompt, timeoutMs = ANSWER_TIMEOUT_MS) =>
    new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        if (finished || childExited || answered(prompt)) return resolve(true);
        if (timeoutMs && Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 40);
      };
      tick();
    });

  const scanPrompts = force => {
    PROMPT_HEADER.lastIndex = headerCursor;
    let match;
    while ((match = PROMPT_HEADER.exec(raw))) {
      if (match.index + match[0].length >= raw.length && !force) {
        clearTimeout(rescan);
        rescan = setTimeout(() => scan(true), 200);
        return;
      }
      headerCursor = PROMPT_HEADER.lastIndex;
      const prompt = { q: match[1].trim(), rest: strip(match[2]), rawStart: match.index, plainStart: plainAt(match.index) };
      if (active && active.q === prompt.q) continue;
      if (active) {
        pending = prompt;
        continue;
      }
      startPrompt(prompt);
    }
  };

  const scan = force => {
    scanProgress();
    scanOutputRules();
    scanPrompts(force);
  };

  const startPrompt = prompt => {
    if (finished) return;
    active = prompt;
    recorder.mark("prompt.seen", { q: prompt.q });
    prompt.secret = secrets.some(regex => regex.test(prompt.q));
    if (prompt.secret) recorder.secretOpen(prompt.q);
    const rule = mode === "run" ? rules.find(r => r.on?.prompt && new RegExp(r.on.prompt).test(prompt.q) && test(r.when, vars)) : null;
    enqueue(async () => {
      if (mode !== "run") {
        await waitAnswered(prompt, 0);
      } else if (!rule) {
        recorder.mark("unknown-prompt", { q: prompt.q });
        await ask(prompt, "EAS asked something this flow does not know");
      } else {
        recorder.mark("rule", { rule: rule.id ?? rules.indexOf(rule), q: prompt.q });
        capture(rule.capture, prompt.rest, vars);
        await perform(rule.do, rule, prompt);
        if (!finished) {
          const ok = await waitAnswered(prompt);
          if (!ok) await ask(prompt, "EAS did not accept the answer");
        }
      }
      capture(rule?.capture_after, plain.slice(prompt.plainStart), vars);
      for (const [name, template] of Object.entries(rule?.collect ?? {})) {
        vars[name] = [...(Array.isArray(vars[name]) ? vars[name] : []), interpolate(template, vars)];
      }
      if (rule?.show && !finished) step(interpolate(rule.show, vars));
      recorder.mark("prompt.done", { q: prompt.q });
      lastDoneRaw = raw.length;
      if (prompt.secret) recorder.secretClose();
      active = null;
      const next = pending;
      pending = null;
      if (next && !finished) startPrompt(next);
      scan(true);
    });
  };

  const ask = async (prompt, why) => {
    recorder.mark("pause");
    const from = Math.max(Math.min(lastDoneRaw, prompt.rawStart), prompt.rawStart - 20000);
    await presenter.ask({ why, question: prompt.q, screen: raw.slice(from), secret: prompt.secret }, () => waitAnswered(prompt, 0));
    lastHumanAnswer = Date.now();
    recorder.mark("decision", { text: `${why}: answered by the human (${prompt.q})` });
    recorder.mark("resume");
  };

  const selectAll = async (spec, prompt) => {
    const toggle = spec.toggle ?? "a";
    const checked = spec.checked ?? "◉";
    const unchecked = spec.unchecked ?? "◯";
    const marker = spec.after ?? "";
    for (let attempt = 0; attempt <= (spec.tries ?? 4); attempt++) {
      await child.settled(300);
      const from = marker ? plain.lastIndexOf(marker) : prompt.plainStart;
      const screen = plain.slice(Math.max(from, prompt.plainStart));
      const off = screen.split(unchecked).length - 1;
      const on = screen.split(checked).length - 1;
      if (off === 0 && on > 0) {
        send("\r");
        return;
      }
      if (attempt < (spec.tries ?? 4)) send(toggle);
    }
    await ask(prompt, `could not confirm every item is selected: press ${toggle} until all show ${checked}, then Enter`);
  };

  const choose = async (spec, rule, prompt) => {
    const title = interpolate(spec.title, vars);
    const remember = spec.remember;
    const memoryKey = remember ? interpolate(remember.key, vars) : null;
    if (memoryKey && memory?.trustedUntil(memoryKey)) {
      const hours = Math.round((memory.trustedUntil(memoryKey) - Date.now()) / 3600000);
      const option = spec.options.find(o => o.key === remember.then);
      recorder.mark("decision", { text: `${title}: remembered (${memoryKey}, ${hours}h left)` });
      if (remember.show) vars.trusted_hours = hours;
      await perform(option.then ?? "continue", rule, prompt);
      if (remember.show) step(interpolate(remember.show, vars));
      return;
    }
    if (spec.pause) child.pause();
    recorder.mark("pause");
    const key = await presenter.choose({
      tone: spec.tone ?? "info",
      icon: spec.icon ?? "",
      title,
      body: renderLines(spec.body, vars),
      options: spec.options.map(o => ({ key: o.key, label: interpolate(o.label, vars) })),
      approvals: memoryKey ? memory?.approvals(memoryKey) : 0,
    });
    recorder.mark("resume");
    const option = spec.options.find(o => o.key === key);
    if (!option) {
      if (spec.pause) child.resume();
      finished = { exit: 130, result: "interrupted" };
      child.interrupt();
      return;
    }
    recorder.mark("decision", { text: `${title}: ${option.label}` });
    if (memoryKey) memory?.approve(memoryKey, option.remember ? remember.days ?? 0 : 0);
    if (spec.pause && !option.then?.exit) child.resume();
    await perform(option.then ?? "continue", rule, prompt);
    if (option.show && !finished) step(interpolate(option.show, vars));
  };

  const perform = async (action, rule, prompt) => {
    if (finished || !action || action === "continue") return;
    if (action.answer !== undefined) return send(interpolate(action.answer, vars) + "\r");
    if (action.ask !== undefined) return ask(prompt ?? { q: "", rawStart: raw.length, plainStart: plain.length }, interpolate(action.ask, vars));
    if (action["select-all"]) return selectAll(action["select-all"], prompt);
    if (action.choose) return choose(action.choose, rule, prompt);
    if (action.exit) {
      finished = {
        exit: action.exit.code ?? 1,
        result: action.exit.result ?? "stopped",
        message: action.exit.message ? interpolate(action.exit.message, vars) : undefined,
      };
      recorder.mark("decision", { text: `stopped: ${finished.result}` });
      child.interrupt();
    }
  };

  child.onData(data => {
    recorder.out(data);
    if (presenter.showsRaw?.()) presenter.raw(data);
    raw += data;
    const text = carry + data;
    const partial = text.match(/\x1b(\[[0-9;?<>=]*[ -/]*|\][^\x07]*|)$/);
    carry = partial ? partial[0] : "";
    offsets.push([raw.length - carry.length, plain.length]);
    plain += strip(partial ? text.slice(0, partial.index) : text);
    scan(false);
  });

  const exitInfo = await child.wait();
  clearTimeout(rescan);
  scan(true);
  await queue;
  const childCode = exitInfo.code ?? 1;
  const outcome = finished ?? {
    exit: childCode === 0 ? 0 : 1,
    result: childCode === 0 ? (vars.build_url ? "queued" : "completed") : lastHumanAnswer && Date.now() - lastHumanAnswer < 5000 ? "aborted-at-prompt" : "eas-failed",
  };
  return { ...outcome, childCode, vars, divergence: child.divergence?.() ?? null };
}

function defaults(flow) {
  const values = {};
  for (const [name, spec] of Object.entries(flow?.params ?? {})) {
    if (spec.default !== undefined) values[name] = spec.default;
  }
  return values;
}
