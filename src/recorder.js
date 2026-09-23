import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const RECORDING_FILE = "recording.jsonl";

export function createRecorder(dir, header) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, RECORDING_FILE), "a", 0o600);
  const t0 = Date.now();
  let secret = null;
  let closed = false;

  const write = frame => {
    if (!closed) writeSync(fd, JSON.stringify(frame) + "\n");
  };
  const now = () => Date.now() - t0;

  write({ v: 1, k: "header", ...header, started_at: new Date(t0).toISOString() });

  const flushSecret = () => {
    if (!secret || secret.buffer.length === 0) return;
    const data = `\r\n\x1b[32m✔\x1b[39m \x1b[1m${secret.question}\x1b[22m [redacted]\r\n`;
    write({ t: secret.buffer[0].t, k: "out", d: data, redacted: secret.buffer.length });
    secret.buffer = [];
  };

  return {
    out(data) {
      if (secret) secret.buffer.push({ t: now(), d: data });
      else write({ t: now(), k: "out", d: data });
    },
    in(data, by) {
      if (secret && by === "human") {
        secret.typed += data;
        write({ t: now(), k: "in", by, secret: true, n: data.length });
      } else {
        write({ t: now(), k: "in", by, d: data });
      }
    },
    mark(name, data = {}) {
      write({ t: now(), k: "mark", name, ...data });
    },
    secretOpen(question) {
      secret = { question, buffer: [], typed: "" };
    },
    secretClose() {
      flushSecret();
      secret = null;
    },
    close(result) {
      flushSecret();
      secret = null;
      write({ t: now(), k: "mark", name: "run.end", data: result });
      closed = true;
      closeSync(fd);
    },
  };
}

export function readRecording(dir) {
  return readFileSync(join(dir, RECORDING_FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
