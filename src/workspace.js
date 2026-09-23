import { execFileSync } from "node:child_process";

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

export function gitInfo(dir) {
  try {
    return { branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), sha: git(dir, ["rev-parse", "--short", "HEAD"]), root: git(dir, ["rev-parse", "--show-toplevel"]) };
  } catch {
    return null;
  }
}

export function ensureCleanTree(root) {
  if (!git(root, ["status", "--porcelain"])) return { clean: true, restored: [] };
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const real = git(root, ["diff", "-w", "--ignore-blank-lines", "--ignore-space-at-eol"]);
  if (untracked || real) return { clean: false, status: git(root, ["status", "--short"]) };
  const restored = git(root, ["diff", "--name-only"]).split("\n").filter(Boolean);
  git(root, ["restore", "."]);
  return { clean: true, restored };
}
