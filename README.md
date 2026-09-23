# eas-autopilot

Run an interactive `eas build` for iOS without babysitting it. `eas-autopilot` answers the
routine credential prompts, shows live progress, and stops only when a decision is really yours.

It was built for the everyday case of adding a tester's iPhone to an internal (ad hoc) build:
register the device, rebuild, and make sure the new provisioning profile actually contains it.

```
  📦 EAS iOS preview build eas-autopilot v0.8.0

  ✔ 🧹 Working tree clean 0s
  ✔ 🌱 Loaded preview environment 2s
  ✔ 🍏 Apple ID you@example.com (trusted, 71h left) 0s
  ✔ Fetched Apple provisioning profiles 4s
  ✔ 📱 Selected all 55 registered devices 2s
  ✔ Updated existing profile: *[expo] com.example.app AdHoc 18s
  ⠹ 🎯 Credentials for Widget · Fetching Apple devices... 14s — Apple's developer API lists every registered device, it is often slow
```

## Install

Needs macOS with `expect`, `jq`, `python3`, `git` and Node (for `npx eas-cli`). All ship with macOS
or Homebrew.

```bash
git clone https://github.com/manssorr/eas-autopilot.git
ln -s "$PWD/eas-autopilot/bin/eas-autopilot" ~/.local/bin/eas-autopilot
```

## Use

```bash
eas-autopilot --dir path/to/expo-app --udid <new device UDID>
```

| Flag | Meaning |
| --- | --- |
| `--dir` | Expo app directory (default: current directory) |
| `--profile` | `eas.json` build profile (default: `preview`) |
| `--udid` | After the build finishes, download the IPA and confirm this device is in every provisioning profile. Implies `--wait`. |
| `--wait` | Follow the build until EAS finishes it |
| `--yes` | Start the build without the final confirmation |
| `--history [N]` | Print the last N runs |

## What it answers for you

| EAS asks | Answer |
| --- | --- |
| Log in to your Apple account? | yes |
| Choose the devices to provision again? | yes |
| Select devices for the ad hoc build | selects **every** registered device, and submits only after it has checked the list shows all of them selected |
| Reuse the profile? | yes |
| Continue without devices Apple refused? | yes, **unless** the refused list contains your `--udid` |

## Nothing is built until you confirm

EAS asks no question between setting up credentials and uploading the source, and a build exists
only once the upload finishes. When EAS starts compressing the project, `eas-autopilot` pauses the
EAS process group (`SIGSTOP`) and shows a summary:

```
  ╭─ 🧾 Ready to build
  │  EAS is paused. Nothing is uploaded and no build exists yet.
  │
  │  profile   preview
  │  source    main @ 1a2b3c4
  │  devices   App: 55
  │            Widget: 55
  │  ✔ 00008000-0000000000000000 is in this build
  │  💳 42% of included build credits used this period
  │
  │  ❯ Start the build  y
  │    Cancel, nothing is built  n
  │
  ╰─ ↑↓ move · Enter select · or press the key
```

Start resumes EAS. Cancel interrupts it, and no build is created. Pass `--yes` to skip this step.

## When it stops for you

- **Apple ID.** It shows the saved address: use it, use it and trust it for 3 days (no question on
  the next runs), or type another.

Every question is a small menu: ↑/↓ (or `j`/`k`) to move, Enter to select, or press the shortcut key
shown next to the option. The card disappears after you answer and leaves one ✔ line in the log.
`EAS_AUTOPILOT_UI=gum` switches the menus to [gum](https://github.com/charmbracelet/gum) (experimental).
- **Apple refused your device.** A newly registered device can stay in *Processing* at Apple for up
  to 72 hours. Building now would leave it out and still use a build credit, so Enter stops the run
  before anything is uploaded.
- **Password, 2FA code, certificates, revoking, or any prompt it does not recognise.** You answer in
  place, and automation resumes after Enter.

Keys you press while it is working are discarded, so a stray Enter cannot answer a prompt.

It also refuses to start on a dirty working tree. Changes that are whitespace-only (for example
`Expo.plist` re-indented by a previous prebuild) are restored automatically.

## Run history

Every run is recorded for tracing and later improvement:

- `~/.local/state/eas-autopilot/runs.jsonl`: one JSON object per run with `tool_version`,
  `eas_cli_version`, git branch and SHA, build URL and status, the result, decisions taken,
  warnings, and every step with its duration in seconds.
- `~/.local/state/eas-autopilot/runs/<id>/`: `eas.log` (raw EAS output), `events`, `meta.json`.
- `~/.local/state/eas-autopilot/trust.tsv`: trusted Apple IDs and their expiry.

## Non-interactive alternative

eas-cli 24.7+ has `eas build --non-interactive --refresh-ad-hoc-provisioning-profile`. It
provisions every registered device with no prompts, but needs an App Store Connect API key for
**every** target, extensions included. Use it when you have that; use `eas-autopilot` when you rely
on an Apple ID session.

## Tests

```bash
./tests/run.sh
```

The tests drive the real tool against a mock built from eas-cli's own prompt code (`prompts`,
the device picker and `ora` spinners), so no Apple account, EAS account or build credit is used.

## Notes

- macOS ships Tcl 8.5, which cannot represent emoji. The expect part runs in byte mode so UTF-8
  passes through unchanged.
- It matches eas-cli's prompt text. A new eas-cli release can reword a prompt; an unknown prompt is
  handed to you rather than guessed.

## License

MIT
