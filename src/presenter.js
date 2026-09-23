const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TONES = { info: 36, warn: 33, bad: 31 };
const JOKES = ["☕ good time for a coffee", "🐢 Xcode is thinking very hard", "🧙 signing things with magic", "🎧 put on a song"];

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function keyName(data) {
  if (data === "\x1b[A" || data === "\x1bOA" || data === "k") return "up";
  if (data === "\x1b[B" || data === "\x1bOB" || data === "j") return "down";
  if (data === "\r" || data === "\n" || data === " ") return "enter";
  if (data === "\x03") return "interrupt";
  return data;
}

function inputRouter(stdin) {
  let handler = null;
  let sink = null;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  const onData = data => {
    if (handler) return handler(data);
    if (data === "\x03") sink?.interrupt();
  };
  stdin.on("data", onData);
  return {
    setSink: next => (sink = next),
    sink: () => sink,
    capture: next => (handler = next),
    release: () => (handler = null),
    close: () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    },
  };
}

export function terminalPresenter({ stdout = process.stdout, stdin = process.stdin, hints = [] } = {}) {
  const input = inputRouter(stdin);
  const write = text => stdout.write(text);
  const cols = () => stdout.columns || 100;
  let phase = "🚀 Waking up EAS";
  let sub = "";
  let stepStart = Date.now();
  let mark = Date.now();
  let frame = 0;
  let paused = false;
  let rawMode = false;

  write("\x1b[?25l");
  const hintFor = label => {
    const hint = hints.find(h => label.includes(h.match));
    return hint?.text ?? "";
  };
  const draw = () => {
    if (paused) return;
    const elapsed = Date.now() - stepStart;
    const label = sub ? `${phase} · ${sub}` : phase;
    let tail = elapsed >= 10000 ? hintFor(label) : "";
    if (/Building|queue/.test(phase) && elapsed > 30000 && Math.floor(Date.now() / 15000) % 2 === 0) {
      tail = JOKES[Math.floor(Date.now() / 30000) % JOKES.length];
    }
    let head = `${label} ${formatDuration(elapsed)}`;
    const max = cols() - 8;
    if (head.length > max) head = head.slice(0, max);
    if (tail && head.length + tail.length + 3 > max) tail = max - head.length > 8 ? tail.slice(0, max - head.length - 4) + "…" : "";
    write(`\r\x1b[K  \x1b[36m${FRAMES[frame++ % FRAMES.length]}\x1b[0m ${head}${tail ? `\x1b[2m — ${tail}\x1b[0m` : ""}`);
  };
  const timer = setInterval(draw, 100);

  const line = text => write(`\r\x1b[K${text}\n`);

  const card = ({ tone = "info", icon = "", title, body = [], footer = "" }) => {
    const color = TONES[tone] ?? 36;
    const bar = `\x1b[${color}m│\x1b[0m`;
    const rows = [`  \x1b[${color}m╭─\x1b[0m ${icon} \x1b[1m${title}\x1b[0m`];
    for (const text of body) rows.push(`  ${bar}  ${text}`);
    rows.push(`  ${bar}`);
    rows.push(`  \x1b[${color}m╰─\x1b[0m ${footer}`);
    write(`\r\x1b[K\n${rows.join("\n")}\n`);
    return rows.length + 1;
  };
  const clear = lines => write(`\x1b[${lines}A\r\x1b[J`);

  const pause = () => {
    paused = true;
    write("\r\x1b[K");
  };
  const resume = () => {
    paused = false;
    mark = Date.now();
    write("\x1b[?25l");
  };

  return {
    attach: sink => input.setSink(sink),
    showsRaw: () => rawMode,
    raw: data => write(data),
    phase: text => {
      if (text !== phase) {
        phase = text;
        sub = "";
        stepStart = Date.now();
      }
    },
    sub: text => {
      sub = text;
      stepStart = Date.now();
    },
    done: text => {
      const now = Date.now();
      line(`  \x1b[32m✔\x1b[0m ${text} \x1b[2m${formatDuration(now - mark)}\x1b[0m`);
      mark = now;
    },
    warn: text => {
      line(`  \x1b[33m⚠\x1b[0m ${text}`);
      mark = Date.now();
    },
    choose: ({ tone, icon, title, body, options, approvals }) =>
      new Promise(resolve => {
        pause();
        let selected = 0;
        let drawn = 0;
        const extra = approvals ? [`\x1b[2mapproved ${approvals} time(s) before\x1b[0m`] : [];
        const render = () => {
          if (drawn) clear(drawn);
          const rows = options.map((option, i) =>
            i === selected
              ? `\x1b[1;${TONES[tone] ?? 36}m❯ ${option.label}\x1b[0m  \x1b[2m${option.key}\x1b[0m`
              : `\x1b[2m  ${option.label}  ${option.key}\x1b[0m`,
          );
          drawn = card({ tone, icon, title, body: [...body, ...extra, "", ...rows], footer: "\x1b[2m↑↓ move · Enter select · or press the key\x1b[0m" });
        };
        render();
        const onKey = data => {
          const key = keyName(data);
          let pick = null;
          if (key === "up") selected = (selected - 1 + options.length) % options.length;
          else if (key === "down") selected = (selected + 1) % options.length;
          else if (key === "enter") pick = options[selected].key;
          else if (key === "interrupt") pick = "";
          else pick = options.find(o => o.key.toLowerCase() === String(key).toLowerCase())?.key ?? null;
          if (pick === null) {
            render();
            return false;
          }
          input.release();
          clear(drawn);
          resume();
          resolve(pick);
          return true;
        };
        input.capture(data => {
          for (const key of data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/g) ?? []) {
            if (onKey(key) === true) return;
          }
        });
      }),
    ask: async ({ why, question, screen, secret }, answered) => {
      pause();
      card({
        tone: "warn",
        icon: "🙋",
        title: "Decision needed",
        body: [why, `\x1b[2mEAS asks:\x1b[0m ${question}`],
        footer: `\x1b[2manswer below in EAS's own prompt${secret ? ", input is not recorded" : ""}\x1b[0m`,
      });
      write("\x1b[?25h");
      rawMode = true;
      write(screen);
      input.capture(data => input.sink()?.input(data));
      await answered();
      input.release();
      rawMode = false;
      write("\n");
      line(`  \x1b[32m✔\x1b[0m 🙌 Answered: ${question}`);
      resume();
    },
    close: once(() => {
      clearInterval(timer);
      write("\r\x1b[K\x1b[?25h");
      input.close();
    }),
    print: text => line(text),
  };
}

function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export function passthroughPresenter({ stdout = process.stdout, stdin = process.stdin } = {}) {
  const input = inputRouter(stdin);
  input.capture(data => input.sink()?.input(data));
  return {
    attach: sink => input.setSink(sink),
    showsRaw: () => true,
    raw: data => stdout.write(data),
    phase: () => {},
    sub: () => {},
    done: () => {},
    warn: () => {},
    choose: async () => "",
    ask: async (_, answered) => answered(),
    close: once(() => input.close()),
    print: text => stdout.write(`${text}\n`),
  };
}

export function headlessPresenter({ choose = () => "", ask = () => null } = {}) {
  const log = [];
  let sink = null;
  return {
    log,
    attach: next => (sink = next),
    showsRaw: () => false,
    raw: () => {},
    phase: text => log.push({ phase: text }),
    sub: () => {},
    done: text => log.push({ done: text }),
    warn: text => log.push({ warn: text }),
    choose: async card => {
      log.push({ choose: card.title });
      return choose(card);
    },
    ask: async (info, answered) => {
      log.push({ ask: info.question, why: info.why, screen: info.screen });
      const typed = await ask(info);
      if (typed !== null && typed !== undefined) sink?.input(typed);
      await answered();
    },
    close: () => {},
    print: text => log.push({ print: text }),
  };
}
