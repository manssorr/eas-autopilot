import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const DEPS = join(HERE, ".deps", "node_modules");
export const NEW_DEVICE = "00000000-000A00000B00000C";

export function ensureMockDeps() {
  if (existsSync(join(DEPS, "eas-cli"))) return;
  execFileSync("npm", ["install", "--prefix", join(HERE, ".deps"), "--no-audit", "--no-fund", "--silent", "eas-cli@24.7.0", "ora@5"], { stdio: "ignore" });
}

export function mockEnv(extra = {}) {
  const work = mkdtempSync(join(tmpdir(), "eas-autopilot-test-"));
  const result = join(work, "result");
  writeFileSync(result, "");
  return {
    work,
    result,
    read: () => readFileSync(result, "utf8"),
    env: {
      ...process.env,
      EAS_MOCK_NODE_MODULES: DEPS,
      EAS_MOCK_RESULT: result,
      EAS_MOCK_NEW_DEVICE: NEW_DEVICE,
      EAS_MOCK_FAIL: "0",
      EAS_MOCK_PASSWORD: "0",
      EAS_MOCK_CODE: "0",
      ...extra,
    },
  };
}

export const MOCK_COMMAND = ["node", join(HERE, "mock-eas.cjs")];
