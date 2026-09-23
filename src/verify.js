import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const eas = (dir, args) => JSON.parse(execFileSync("npx", ["eas-cli", ...args, "--json", "--non-interactive"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

export async function followBuild(dir, buildId, onStatus) {
  let last = "";
  let failures = 0;
  for (;;) {
    let status = "UNKNOWN";
    try {
      status = eas(dir, ["build:view", buildId]).status;
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= 3) return "UNKNOWN";
    }
    if (status !== last) onStatus(status, last);
    last = status;
    if (["FINISHED", "ERRORED", "CANCELED"].includes(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

export function checkDeviceInBuild(dir, buildId, udid) {
  const url = eas(dir, ["build:view", buildId]).artifacts.buildUrl;
  const work = mkdtempSync(join(tmpdir(), "eas-autopilot-ipa-"));
  try {
    execFileSync("curl", ["-sL", "-o", join(work, "app.ipa"), url]);
    execFileSync("unzip", ["-oq", "app.ipa", "Payload/*.app/embedded.mobileprovision", "Payload/*.app/PlugIns/*/embedded.mobileprovision"], { cwd: work });
    const profiles = [];
    const walk = path => {
      for (const name of readdirSync(path)) {
        const full = join(path, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === "embedded.mobileprovision") profiles.push(full);
      }
    };
    walk(join(work, "Payload"));
    return profiles.map(profile => {
      const plist = execFileSync("security", ["cms", "-D", "-i", profile], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const name = plist.match(/<key>Name<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? profile;
      const devices = plist.match(/<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1].match(/<string>/g)?.length ?? 0;
      return { name, devices, present: plist.includes(udid) };
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
