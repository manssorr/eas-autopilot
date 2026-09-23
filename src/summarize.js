export function summarize(frames) {
  const header = frames.find(frame => frame.k === "header") ?? {};
  const end = frames.find(frame => frame.k === "mark" && frame.name === "run.end")?.data ?? {};
  const steps = [];
  const decisions = [];
  const unknownPrompts = [];
  let previous = 0;
  for (const frame of frames) {
    if (frame.k !== "mark") continue;
    if (frame.name === "step") {
      steps.push({ step: frame.text, seconds: Math.round((frame.t - previous) / 1000) });
      previous = frame.t;
    }
    if (frame.name === "decision") decisions.push(frame.text);
    if (frame.name === "resume") previous = frame.t;
    if (frame.name === "unknown-prompt") unknownPrompts.push(frame.q);
  }
  const last = frames.at(-1);
  return {
    run_id: header.id,
    tool: "eas-autopilot",
    tool_version: header.tool,
    eas_cli_version: header.eas_cli ?? null,
    mode: header.mode,
    flow: header.flow ?? null,
    command: header.command,
    started_at: header.started_at,
    duration_s: Math.round((last?.t ?? 0) / 1000),
    exit_code: end.exit ?? null,
    result: end.result ?? "aborted",
    git: header.git ?? null,
    build: { url: end.build_url ?? null, status: end.build_status ?? null },
    udid: header.params?.udid || null,
    udid_check: end.udid_check ?? null,
    decisions,
    unknown_prompts: unknownPrompts,
    steps,
  };
}
