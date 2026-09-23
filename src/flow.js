import { readFileSync } from "node:fs";

export const ACTIONS = ["answer", "ask", "select-all", "choose", "exit"];

export function loadFlow(path) {
  const flow = JSON.parse(readFileSync(path, "utf8"));
  const problems = validateFlow(flow);
  if (problems.length > 0) throw new Error(`invalid flow ${path}:\n  - ${problems.join("\n  - ")}`);
  return flow;
}

export function validateFlow(flow) {
  const problems = [];
  if (flow.flow !== 1) problems.push('"flow" must be 1');
  if (!flow.id) problems.push('"id" is required');
  if (!Array.isArray(flow.command) || flow.command.length === 0) problems.push('"command" must be a non-empty array');
  if (!Array.isArray(flow.rules)) problems.push('"rules" must be an array');
  const compile = (source, where) => {
    try {
      new RegExp(source);
    } catch (error) {
      problems.push(`${where}: bad regex ${JSON.stringify(source)} (${error.message})`);
    }
  };
  for (const source of flow.secrets ?? []) compile(source, "secrets");
  let pauses = 0;
  (flow.rules ?? []).forEach((rule, i) => {
    const where = `rules[${i}]${rule.id ? ` (${rule.id})` : ""}`;
    const on = rule.on ?? {};
    if (!on.prompt === !on.output) problems.push(`${where}: "on" needs exactly one of "prompt" or "output"`);
    if (on.prompt) compile(on.prompt, `${where}.on.prompt`);
    if (on.output) compile(on.output, `${where}.on.output`);
    for (const [name, spec] of Object.entries(rule.capture ?? {})) {
      compile(typeof spec === "string" ? spec : spec.each, `${where}.capture.${name}`);
    }
    for (const [name, spec] of Object.entries(rule.capture_after ?? {})) {
      compile(typeof spec === "string" ? spec : spec.each, `${where}.capture_after.${name}`);
    }
    if (rule.do) validateAction(rule.do, where, problems);
    if (on.prompt && !rule.do) problems.push(`${where}: a prompt rule needs "do"`);
    if (rule.do?.choose?.pause) {
      pauses += 1;
      if (!on.output) problems.push(`${where}: a pausing choose must be triggered by "output"`);
    }
  });
  if (pauses > 1) problems.push("at most one rule may pause the build");
  return problems;
}

function validateAction(action, where, problems) {
  if (action === "continue") return;
  const keys = Object.keys(action);
  if (keys.length !== 1 || !ACTIONS.includes(keys[0])) {
    problems.push(`${where}: action must be one of ${ACTIONS.join(", ")} or "continue", got ${JSON.stringify(action)}`);
    return;
  }
  if (action.exit !== undefined && typeof action.exit !== "object") problems.push(`${where}: exit needs {"code", "result"}`);
  if (action.choose) {
    const options = action.choose.options ?? [];
    if (options.length < 2) problems.push(`${where}: choose needs at least two options`);
    options.forEach((option, i) => {
      if (!option.key || !option.label) problems.push(`${where}.options[${i}]: needs "key" and "label"`);
      if (option.then) validateAction(option.then, `${where}.options[${i}].then`, problems);
    });
  }
}

export function interpolate(template, vars) {
  return String(template).replace(/\{([\w.]+)\}/g, (_, name) => {
    const [base, prop] = name.split(".");
    const value = vars[base];
    if (prop === "length") return Array.isArray(value) ? String(value.length) : value ? "1" : "0";
    if (Array.isArray(value)) return value.join(", ");
    return value === undefined || value === null ? "" : String(value);
  });
}

export function test(condition, vars) {
  if (!condition) return true;
  if (condition.all) return condition.all.every(inner => test(inner, vars));
  if (condition.any) return condition.any.some(inner => test(inner, vars));
  const name = condition.var ?? condition.param;
  const value = vars[name];
  const present = Array.isArray(value) ? value.length > 0 : Boolean(value);
  if (condition.contains !== undefined) {
    const needle = interpolate(condition.contains, vars);
    if (!needle || !present) return false;
    return Array.isArray(value) ? value.some(item => String(item).includes(needle)) : String(value).includes(needle);
  }
  if (condition.lacks !== undefined) {
    const needle = interpolate(condition.lacks, vars);
    if (!needle) return false;
    if (!present) return true;
    return Array.isArray(value) ? !value.some(item => String(item).includes(needle)) : !String(value).includes(needle);
  }
  return condition.not ? !present : present;
}

export function renderLines(items, vars) {
  const lines = [];
  for (const item of items ?? []) {
    const spec = typeof item === "string" ? { text: item } : item;
    if (!test(spec.when, vars)) continue;
    const whole = spec.text.match(/^\{(\w+)\}$/);
    if (whole && Array.isArray(vars[whole[1]])) lines.push(...vars[whole[1]].map(String));
    else lines.push(interpolate(spec.text, vars));
  }
  return lines;
}

export function capture(specs, text, vars) {
  for (const [name, spec] of Object.entries(specs ?? {})) {
    if (typeof spec === "string") {
      const match = text.match(new RegExp(spec));
      if (match) vars[name] = match[1] ?? match[0];
    } else if (spec.each) {
      const found = [...text.matchAll(new RegExp(spec.each, "gm"))].map(match => (match[1] ?? match[0]).trim());
      if (found.length > 0) vars[name] = [...new Set([...(Array.isArray(vars[name]) ? vars[name] : []), ...found])];
    }
  }
}
