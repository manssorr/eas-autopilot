import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_HEADER, strip, visibleKeys } from "./ansi.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "flow-format.md");

export function transcript(frames) {
  const lines = [];
  let raw = "";
  let current = null;
  const notable = /(✔ .+|Failed to provision.+|Compressing project files|Uploading to EAS Build|https:\/\/expo\.dev\/\S+\/builds\/\S+|Setting up credentials for target \S+|Error: .+)/;
  let plainCursor = 0;
  const flushNotable = () => {
    const plain = strip(raw);
    const boundary = Math.max(plain.lastIndexOf("\n"), plain.lastIndexOf("\r"));
    if (boundary <= plainCursor) return;
    for (const line of plain.slice(plainCursor, boundary).split(/[\r\n]+/)) {
      const match = line.trim().match(notable);
      if (match && !/[›…]/.test(match[1])) lines.push(`  · ${match[1]}`);
    }
    plainCursor = boundary;
  };
  for (const frame of frames) {
    if (frame.k === "out") {
      raw += frame.d;
      flushNotable();
    }
    if (frame.k === "mark" && frame.name === "prompt.seen") {
      PROMPT_HEADER.lastIndex = 0;
      let header = null;
      let match;
      while ((match = PROMPT_HEADER.exec(raw))) if (match[1].trim() === frame.q) header = match;
      current = { q: frame.q, rest: header ? strip(header[2]).trim() : "", start: header?.index ?? raw.length, keys: [], t: frame.t };
    }
    if (frame.k === "in" && current) {
      current.keys.push(frame.secret ? `[secret, ${frame.n} chars]` : `${frame.by}:${visibleKeys(frame.d)}`);
    }
    if (frame.k === "mark" && frame.name === "prompt.done" && current) {
      const all = strip(raw.slice(current.start)).split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      const end = all.findIndex(l => /^(✔|✖)/.test(l) && l.includes(current.q));
      const screen = end >= 0 ? all.slice(0, end + 1) : all;
      const done = end >= 0 ? all[end] : null;
      lines.push(`PROMPT t=${(current.t / 1000).toFixed(1)}s  "${current.q}"`);
      if (current.rest) lines.push(`  shown:   ${current.rest}`);
      const items = screen.filter(l => /^[◉◯]/.test(l)).slice(-12);
      if (items.length) lines.push(`  choices: ${items.length} visible, e.g. ${items.slice(0, 3).join(" | ")}`);
      lines.push(`  keys:    ${current.keys.join("  ") || "(none)"}`);
      if (done) lines.push(`  result:  ${done}`);
      current = null;
    }
    if (frame.k === "mark" && frame.name === "run.end") lines.push(`END  result=${frame.data?.result} exit=${frame.data?.exit}`);
  }
  return lines.join("\n").replace(/[\w.+%-]+@[\w-]+(\.[\w-]+)+/g, "<email>");
}

export function agentPrompt({ frames, runId, flowText, outputPath }) {
  const header = frames.find(f => f.k === "header") ?? {};
  const schema = readFileSync(DOCS, "utf8");
  return `# Task: write an eas-autopilot Flow from a recorded run

You turn one recorded terminal session into a Flow: a JSON file that answers the same prompts the
same way next time, and hands every real decision back to the human.

## Steps
1. Read the transcript. Each PROMPT block is one question the command asked, the keys that answered
   it, and the result line.
2. For each PROMPT, write one rule. A key the human pressed becomes \`answer\` or \`select-all\`; a
   choice that needs human judgement becomes \`choose\`; a secret becomes \`ask\`.
3. Keep the existing flow's rules that still apply, and add rules only for prompts it lacks.
4. Write the Flow to \`${outputPath}\`.
5. Validate: run \`eas-autopilot check ${outputPath} ${runId}\` and fix the Flow until it reports
   \`green\`.

Done when \`check\` is green for this run and for every run it already passed.

## Rules for the Flow
- Output one JSON document that follows the format below.
- A \`[secret]\` answer is always \`ask\`, never \`answer\`.
- The upload gate stays a \`choose\` with \`"pause": true\`, triggered by \`output\`.
- When unsure what a key meant, use \`ask\`: the human answers and the run keeps going.

## Recorded command
${JSON.stringify(header.command ?? [])}  (flow: ${header.flow ?? "none"}, mode: ${header.mode ?? "?"})

## Transcript (run ${runId})
\`\`\`
${transcript(frames)}
\`\`\`

## Existing flow
\`\`\`json
${flowText ?? "(none)"}
\`\`\`

## Flow format
${schema}
`;
}
