import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function createMemory(path) {
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      data = {};
    }
  }
  const save = () => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  return {
    trustedUntil(key) {
      const until = data[key]?.until ?? 0;
      return until > Date.now() ? until : 0;
    },
    approvals(key) {
      return data[key]?.approvals ?? 0;
    },
    approve(key, days = 0) {
      const entry = data[key] ?? { approvals: 0, until: 0 };
      entry.approvals += 1;
      if (days > 0) entry.until = Date.now() + days * 86400000;
      data[key] = entry;
      save();
      return entry;
    },
  };
}
