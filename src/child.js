import pty from "node-pty";

export function createPtyChild(command, { cwd, cols = 120, rows = 40, env = process.env } = {}) {
  const proc = pty.spawn(command[0], command.slice(1), { name: "xterm-256color", cols, rows, cwd, env });
  const listeners = [];
  const exitWaiters = [];
  let lastData = Date.now();
  let lastWrite = 0;
  let exitInfo = null;

  proc.onData(data => {
    lastData = Date.now();
    for (const listener of listeners) listener(data);
  });
  proc.onExit(({ exitCode, signal }) => {
    exitInfo = { code: exitCode, signal };
    for (const resolve of exitWaiters.splice(0)) resolve(exitInfo);
  });

  const signalGroup = signal => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        process.kill(proc.pid, signal);
      } catch {}
    }
  };

  return {
    write: data => {
      lastWrite = Date.now();
      proc.write(data);
    },
    onData: listener => listeners.push(listener),
    settled: (quietMs = 300, replyMs = 2000) =>
      new Promise(resolve => {
        const tick = () => {
          const now = Date.now();
          const replied = lastData > lastWrite || now - lastWrite >= replyMs;
          if (exitInfo || (replied && now - lastData >= quietMs)) resolve();
          else setTimeout(tick, 50);
        };
        tick();
      }),
    pause: () => signalGroup("SIGSTOP"),
    resume: () => signalGroup("SIGCONT"),
    interrupt: () => {
      signalGroup("SIGCONT");
      signalGroup("SIGINT");
    },
    kill: () => signalGroup("SIGKILL"),
    wait: () => (exitInfo ? Promise.resolve(exitInfo) : new Promise(resolve => exitWaiters.push(resolve))),
  };
}

export class ReplayDivergence extends Error {
  constructor({ t, expected, got }) {
    super(`replay diverged at t=${t}ms: expected ${JSON.stringify(expected)}, flow sent ${JSON.stringify(got)}`);
    this.t = t;
    this.expected = expected;
    this.got = got;
  }
}

export function createReplayChild(frames) {
  const steps = [];
  let insidePrompt = false;
  for (const frame of frames) {
    if (frame.k === "mark" && frame.name === "prompt.seen") insidePrompt = true;
    if (frame.k === "mark" && frame.name === "prompt.done") insidePrompt = false;
    if (frame.k === "out") steps.push(frame);
    if (frame.k === "in" && insidePrompt) steps.push(frame);
  }
  const end = frames.find(frame => frame.k === "mark" && frame.name === "run.end");
  const listeners = [];
  const exitWaiters = [];
  const settleWaiters = [];
  let index = 0;
  let offset = 0;
  let idle = false;
  let exitInfo = null;
  let divergence = null;

  const finish = code => {
    if (exitInfo) return;
    exitInfo = { code };
    idle = true;
    for (const resolve of settleWaiters.splice(0)) resolve();
    for (const resolve of exitWaiters.splice(0)) resolve(exitInfo);
  };

  const pump = () => {
    idle = false;
    setImmediate(() => {
      while (index < steps.length && steps[index].k === "out") {
        const data = steps[index++].d;
        for (const listener of listeners) listener(data);
      }
      if (index >= steps.length) return finish(end?.data?.child_code ?? 0);
      idle = true;
      for (const resolve of settleWaiters.splice(0)) resolve();
    });
  };

  const normalize = text => text.replace(/\n/g, "\r");

  const expectedRun = () => {
    let text = "";
    for (let i = index; i < steps.length && steps[i].k === "in"; i++) {
      if (steps[i].secret) break;
      text += normalize(steps[i].d);
    }
    return text.slice(offset);
  };

  const consume = data => {
    let remaining = normalize(data);
    while (remaining.length > 0 && index < steps.length && steps[index].k === "in") {
      const step = steps[index];
      if (step.secret) {
        const enter = remaining.indexOf("\r");
        remaining = enter >= 0 ? remaining.slice(enter + 1) : "";
        index++;
        offset = 0;
        continue;
      }
      const want = normalize(step.d).slice(offset);
      const take = remaining.slice(0, want.length);
      if (!want.startsWith(take)) {
        divergence = new ReplayDivergence({ t: step.t, expected: want, got: remaining });
        return finish(99);
      }
      remaining = remaining.slice(take.length);
      offset += take.length;
      if (offset >= normalize(step.d).length) {
        index++;
        offset = 0;
      }
    }
    if (remaining.length > 0 && !exitInfo) {
      divergence = new ReplayDivergence({ t: steps[index]?.t ?? -1, expected: "", got: remaining });
      return finish(99);
    }
    if (index < steps.length && steps[index].k === "out") pump();
    else if (index >= steps.length) finish(end?.data?.child_code ?? 0);
  };

  pump();
  return {
    write: data => {
      if (!exitInfo) consume(data);
    },
    onData: listener => listeners.push(listener),
    settled: () => (idle ? Promise.resolve() : new Promise(resolve => settleWaiters.push(resolve))),
    pause: () => {},
    resume: () => {},
    interrupt: () => finish(130),
    kill: () => finish(137),
    wait: () => (exitInfo ? Promise.resolve(exitInfo) : new Promise(resolve => exitWaiters.push(resolve))),
    peekExpected: () => (index < steps.length && steps[index].k === "in" ? (steps[index].secret ? null : expectedRun()) : ""),
    divergence: () => divergence,
  };
}
