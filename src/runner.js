import { PROMPT_HEADER, escapeRegExp, questionOf, strip } from "./ansi.js";
import { capture, interpolate, renderLines, test } from "./flow.js";

const DEFAULT_SECRETS = ["password|passcode|passphrase|two-factor|2FA|\\bcode\\b|token"];
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(.+)$/;
const PROGRESS_BAR = /\|[■ ]+\|\s+(.+\.\.\.)$/;
const DONE_LINE = /^✔\s+(.+)$/;
const ANSWER_TIMEOUT_MS = 120000;

export async function run({ flow, params = {}, child, presenter, recorder, memory, mode = "run", auto = null }) {
  const vars = { ...defaults(flow), ...params };
  const rules = flow?.rules ?? [];
  const secrets = [...DEFAULT_SECRETS, ...(flow?.secrets ?? [])].map(source => new RegExp(source, "i"));
  const outputCursor = new Map();
  const fired = new Set();
  const runChoices = new Map();
  const menuUses = new Map();

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

  // The exact plain-text offset of a raw index. Headers are scanned in order and each starts on an
  // escape sequence, so strip() of the slice since the last lookup adds up to the plain offset.
  let mark = { raw: 0, plain: 0 };
  const plainAt = rawIndex => {
    if (rawIndex < mark.raw) mark = { raw: 0, plain: 0 };
    mark = { raw: rawIndex, plain: mark.plain + strip(raw.slice(mark.raw, rawIndex)).length };
    return mark.plain;
  };

  const answered = prompt => {
    const pattern = new RegExp(`(✔|✖)[^\\r\\n]*${escapeRegExp(prompt.q)}`);
    return pattern.test(plain.slice(prompt.plainStart));
  };

  // Is the prompt's own completion line printed before this point? Then a header with the same
  // question is a new prompt, not a redraw of the active one.
  const answeredBefore = (prompt, plainEnd) =>
    new RegExp(`(✔|✖)[^\\r\\n]*${escapeRegExp(prompt.q)}`).test(plain.slice(prompt.plainStart, plainEnd));

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
      const prompt = { q: questionOf(match[1]), rest: strip(match[2]), rawStart: match.index, plainStart: plainAt(match.index) };
      if (active && active.q === prompt.q && !answeredBefore(active, prompt.plainStart)) continue;
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

  // Arrow-key list: move the cursor to the item that matches the next regex of the path, press Enter.
  // The rule's path advances each time the rule fires, so one rule can walk a nested menu.
  const menu = async (spec, rule, prompt) => {
    const path = Array.isArray(spec) ? spec : [spec];
    const used = menuUses.get(rule) ?? 0;
    menuUses.set(rule, used + 1);
    const pick = interpolate(path[Math.min(used, path.length - 1)], vars, escapeRegExp);
    await child.settled(300);
    const from = plain.lastIndexOf(prompt.q);
    const lines = plain.slice(Math.max(from, prompt.plainStart)).split(/[\r\n]+/).slice(1);
    const items = [];
    for (const line of lines) {
      if (!/^(❯|\s{2,})\s*\S/.test(line)) break;
      items.push({ text: line.replace(/^(❯|\s)\s*/, "").trim(), cursor: line.startsWith("❯") });
    }
    const target = items.findIndex(item => new RegExp(pick).test(item.text));
    const cursor = items.findIndex(item => item.cursor);
    if (target < 0 || cursor < 0) {
      return ask(prompt, `no menu item matches /${pick}/: choose it yourself`);
    }
    const key = target > cursor ? "\x1b[B" : "\x1b[A";
    for (let i = 0; i < Math.abs(target - cursor); i++) {
      send(key);
      await child.settled(300);
    }
    send("\r");
  };

  const choose = async (spec, rule, prompt) => {
    const title = interpolate(spec.title, vars);
    const remember = spec.remember;
    const memoryKey = remember ? interpolate(remember.key, vars) : null;
    // A local rule may answer only a prompt-triggered Apple ID choice that opts in via "auto": never a secret, never the build confirmation.
    const autoAllowed = spec.auto?.field === "appleId" && prompt && rule?.on?.prompt && !spec.pause && !prompt.secret && !secrets.some(regex => regex.test(title));
    const autoKey = autoAllowed && auto?.[spec.auto.field]?.toLowerCase() === interpolate(spec.auto.value, vars).toLowerCase() ? (auto.trust === false ? spec.auto.plain : spec.auto.trust) : null;
    if (autoKey) {
      const option = spec.options.find(o => o.key === autoKey);
      recorder.mark("decision", { text: `${title}: ${option.label} (auto-accepted by rule)` });
      if (memoryKey) memory?.approve(memoryKey, option.remember ? remember.days ?? 0 : 0);
      await perform(option.then ?? "continue", rule, prompt);
      step(interpolate(spec.auto.show, vars));
      return;
    }
    // The build confirmation is auto-started only by a local rule with startBuild true AND a flow step marked "start_build"; show the full summary first.
    // Only the pausing "Ready to build" step, only with no prompt active or waiting, and only when the Apple ID EAS used this run is the rule's.
    const sameAppleId = typeof vars.email === "string" && typeof auto?.appleId === "string" && vars.email.toLowerCase() === auto.appleId.toLowerCase();
    const startKey = auto?.startBuild === true && spec.start_build && spec.pause && title === "Ready to build" && prompt === undefined && !active && !pending && sameAppleId && !secrets.some(regex => regex.test(title)) ? spec.start_build : null;
    const startOption = startKey && spec.options.find(o => o.key === startKey);
    if (startOption) {
      presenter.show({ tone: spec.tone ?? "info", icon: spec.icon ?? "", title, body: renderLines(spec.body, vars) });
      recorder.mark("decision", { text: `${title}: ${startOption.label} (started by rule)` });
      if (spec.pause && !startOption.then?.exit) child.resume();
      await perform(startOption.then ?? "continue", rule, prompt);
      step(`🧾 Build started by rule (profile ${vars.profile}, ${vars.git || "source unknown"})`);
      return;
    }
    if (memoryKey && memory?.trustedUntil(memoryKey)) {
      const hours = Math.round((memory.trustedUntil(memoryKey) - Date.now()) / 3600000);
      const option = spec.options.find(o => o.key === remember.then);
      recorder.mark("decision", { text: `${title}: remembered (${memoryKey}, ${hours}h left)` });
      if (remember.show) vars.trusted_hours = hours;
      await perform(option.then ?? "continue", rule, prompt);
      if (remember.show) step(interpolate(remember.show, vars));
      return;
    }
    if (spec.per_run && runChoices.has(title)) {
      const option = spec.options.find(o => o.key === runChoices.get(title));
      recorder.mark("decision", { text: `${title}: ${option.label} (same as earlier in this run)` });
      await perform(option.then ?? "continue", rule, prompt);
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
    if (spec.per_run) runChoices.set(title, key);
    if (memoryKey) memory?.approve(memoryKey, option.remember ? remember.days ?? 0 : 0);
    if (spec.pause && !option.then?.exit) child.resume();
    await perform(option.then ?? "continue", rule, prompt);
    if (option.show && !finished) step(interpolate(option.show, vars));
  };

  const perform = async (action, rule, prompt) => {
    if (finished || !action || action === "continue") return;
    if (action.answer !== undefined) return send(interpolate(action.answer, vars) + "\r");
    if (action.ask !== undefined) return ask(prompt ?? { q: "", rawStart: raw.length, plainStart: plain.length }, interpolate(action.ask, vars));
    if (action.menu !== undefined) return menu(action.menu, rule, prompt);
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
