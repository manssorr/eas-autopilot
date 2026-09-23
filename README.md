# eas-autopilot

Run interactive `eas build` commands without babysitting them. `eas-autopilot` answers the
routine prompts, shows live progress, and stops only when a decision is really yours. Every run is
recorded, and a recorded run can be turned into a new automation by an agent, then checked by
replaying it.

```
  📦 eas-ios-adhoc run · eas-autopilot 1.0.0
  main @ 1a2b3c4 · eas-cli 24.7.0

  ✔ 🧹 Working tree clean 0s
  ✔ 🌱 Loaded preview environment 2s
  ✔ 🍏 Apple ID you@example.com (trusted, 71h left) 0s
  ✔ 📱 Selected all 55 registered devices 2s
  ✔ Updated existing profile: *[expo] com.example.app AdHoc 18s
  ⠹ 🎯 Credentials for Widget · Fetching Apple devices... 14s — Apple's developer API lists every registered device, it is often slow
```

## Install

Needs macOS or Linux, Node 20+, and git.

```bash
git clone https://github.com/manssorr/eas-autopilot.git
cd eas-autopilot && npm install
ln -s "$PWD/bin/eas-autopilot.js" ~/.local/bin/eas-autopilot
```

## Commands

| Command | What it does |
| --- | --- |
| `eas-autopilot run` | Runs the Flow's command and answers its prompts. Default Flow: `eas-ios-adhoc`. |
| `eas-autopilot record` | Runs the command untouched: you see the plain EAS screen, and every byte and key is recorded. |
| `eas-autopilot learn <run>` | Prints a prompt that tells an agent how to turn that recording into a Flow. |
| `eas-autopilot check <flow> [run…]` | Replays recorded runs through a Flow and reports every divergence. |
| `eas-autopilot history [N]` | Lists recent runs. |

`run` options: `--dir <app>`, `--flow <id|file>`, `--profile <name>` (default `preview`),
`--udid <UDID>` (confirm the device is in the build, then wait for the build and check the IPA),
`--wait`, `--yes` (skip the final confirmation), `--no-follow`.

## The eas-ios-adhoc Flow

It is built for adding a tester's iPhone to an internal build.

| EAS asks | Answer |
| --- | --- |
| Log in to your Apple account? | yes |
| Apple ID | you choose: use it, trust it for 3 days, or type another |
| Choose the devices to provision again? | yes |
| Select devices for the ad hoc build | selects every device, and submits only after checking that every visible item is selected |
| Continue without devices Apple refused? | yes, unless the list contains your `--udid`; then it offers to stop before anything is built |
| Reuse the profile? | yes |
| Password or 2FA code | handed to you in EAS's own prompt, and never recorded |

**Nothing is built until you confirm.** When EAS starts compressing the project, the Flow pauses
the EAS process group and shows a summary:

```
  ╭─ 🧾 Ready to build
  │  EAS is paused. Nothing is uploaded and no build exists yet.
  │
  │  profile   preview
  │  source    main @ 1a2b3c4
  │  devices   App: 55, Widget: 55
  │  ✔ 00008000-0000000000000000 is in this build
  │  💳 42% of included build credits used
  │
  │  ❯ Start the build  y
  │    Cancel, nothing is built  n
  │
  ╰─ ↑↓ move · Enter select · or press the key
```

Every question is a menu like this one. Keys pressed while the tool works are discarded, so a
stray Enter cannot answer a prompt. A prompt the Flow does not know is handed to you in place, and
the run tells you to teach it with `learn`.

## Teaching it a new flow

```bash
eas-autopilot record --dir app -- npx eas-cli submit --platform ios   # answer it yourself, once
eas-autopilot learn latest > prompt.md                                 # give prompt.md to an agent
eas-autopilot check ~/.local/state/eas-autopilot/flows/new-flow.json latest
eas-autopilot run --flow new-flow --dir app
```

The agent gets a readable transcript (each question, what was shown, the keys that answered it,
the result line), the Flow format, and the existing Flow. It writes a Flow and runs `check` until it
reports `green`: the Flow must send the same keys the human sent at every prompt, and must hand
secret prompts back to the human. The Flow format is in [docs/flow-format.md](docs/flow-format.md).

## Recordings and history

Everything lives in `~/.local/state/eas-autopilot/` (override with `EAS_AUTOPILOT_STATE`):

- `runs/<id>/recording.jsonl`: a header, then timed frames: `out` (bytes from the command), `in`
  (keys sent, tagged `human` or `flow`), and `mark` (prompts seen and done, rules fired, decisions,
  steps). Secret prompts keep only the length of what was typed, and their echo is redacted. Files
  are `0600`.
- `runs/<id>/meta.json` and `runs.jsonl`: a summary derived from the recording: tool and eas-cli
  versions, git SHA, result, build URL, decisions, and every step with its duration.
- `memory.json`: remembered choices, such as a trusted Apple ID and when the trust expires.
- `flows/`: Flows written by `learn`.

## Non-interactive alternative

eas-cli 24.7+ has `eas build --non-interactive --refresh-ad-hoc-provisioning-profile`, which
provisions every registered device without prompts. It needs an App Store Connect API key for
**every** target, extensions included.

## Tests

```bash
npm test
```

The tests drive the real runner and the real CLI in a pseudo-terminal against a mock built from
eas-cli's own prompt code (`prompts`, the device picker, and `ora` spinners), so no Apple account,
EAS account, or build credit is used. They cover the Flow, the pause before upload, secret
redaction, and the record → learn → check loop.

## License

MIT
