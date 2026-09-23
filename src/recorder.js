import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { escapeRegExp } from "./ansi.js";

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
    let data = secret.buffer.map(frame => frame.d).join("");
    const typed = secret.typed.replace(/[\r\n]/g, "");
    if (typed.length >= 2) data = data.split(typed).join("[redacted]");
    data = data.replace(new RegExp(escapeRegExp(secret.question) + "[^\\r\\n]*", "g"), `${secret.question} [redacted]`);
    write({ t: secret.buffer[0].t, k: "out", d: data });
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
