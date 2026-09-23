A Flow is one JSON file. Rules are tried in order; the first rule whose `on` matches and whose
`when` holds is the one that acts.

```json
{
  "flow": 1,
  "id": "eas-ios-adhoc",
  "command": ["npx", "eas-cli", "build", "--platform", "ios", "--profile", "{profile}", "--no-wait"],
  "params": { "profile": { "default": "preview" }, "udid": { "optional": true } },
  "secrets": ["[Pp]assword"],
  "hints": [{ "match": "Fetching Apple devices", "text": "Apple's API is slow here" }],
  "rules": [
    { "id": "apple-login", "on": { "prompt": "^Do you want to log in to your Apple account\\?" }, "do": { "answer": "y" }, "show": "🍏 Apple login: yes" }
  ]
}
```

## Triggers (`on`)

- `{"prompt": "<regex>"}` matches the question text of an interactive prompt (the text after `?`,
  ANSI removed). The rule acts once per appearance, and the runner waits for the prompt's `✔`/`✖`
  completion line before it looks for the next prompt.
- `{"output": "<regex>"}` matches any printed output, ANSI removed. Use it to capture values or to
  gate a step that has no prompt. `"once": true` makes it fire only the first time.

## Actions (`do`)

| Action | Effect |
| --- | --- |
| `{"answer": "y"}` | types the text, then Enter. `{"answer": ""}` is a bare Enter (accept the default). |
| `{"select-all": {"toggle": "a", "checked": "◉", "unchecked": "◯", "after": "Space to select", "tries": 4}}` | multiselect: presses `toggle` until no visible item shows `unchecked`, then Enter. Falls back to `ask`. |
| `{"ask": "why"}` | hands the prompt to the human, who answers in the command's own screen. |
| `{"choose": {…}}` | shows a menu to the human and runs the chosen option's `then`. |
| `{"exit": {"code": 3, "result": "name", "message": "…"}}` | interrupts the command and ends the run. |
| `"continue"` | does nothing (only valid as an option's `then`). |

`choose`:

```json
{
  "tone": "info | warn | bad", "icon": "🧾", "title": "Ready to build",
  "body": ["line", "{var}", { "text": "only if set", "when": { "var": "credits" } }],
  "pause": true,
  "remember": { "key": "apple-id:{email}", "days": 3, "then": "y", "show": "trusted line" },
  "options": [
    { "key": "y", "label": "Start the build", "then": "continue", "show": "🧾 Build confirmed" },
    { "key": "n", "label": "Cancel", "then": { "exit": { "code": 4, "result": "cancelled" } } }
  ]
}
```

- `pause` stops the command's process group while the menu is open, and resumes it unless the
  option exits. At most one rule may pause, and it must be an `output` rule.
- `remember`: an option with `"remember": true` stores the choice for `days`; while stored, the
  runner takes option `then` without asking.

## Values

- `capture: {"name": "<regex>"}` stores group 1 (or the whole match). For a prompt rule it reads the
  prompt line; for an output rule it reads the match. `{"each": "<regex>"}` stores every multiline
  match as a list.
- `capture_after` is the same, read from everything printed while the prompt was open (for example
  `"(\\d+) devices? selected"`).
- `collect: {"list": "{target}: {selected}"}` appends a rendered line to a list.
- `{name}` in any text inserts a value; a list renders as `a, b`, and `{list.length}` is its size. A
  body line that is exactly `{list}` expands to one line per item. Params (`--profile`, `--udid`,
  `git`) are values too.
- `when` / `skip_if`: `{"var": "x"}` (set), `{"var": "x", "contains": "{udid}"}`,
  `{"var": "x", "lacks": "{udid}"}`, `{"param": "yes"}`, `{"all": [...]}`, `{"any": [...]}`.

## Display

- `show`: a ✔ line printed after the rule completes.
- `phase`: sets the live spinner label.
- `hints`: explanation shown when a spinner label containing `match` runs longer than 10 s.

## Secrets

A prompt whose question matches a `secrets` regex (or the built-in list: password, passcode,
two-factor, 2FA, code, token) is recorded with its answer and echo redacted. Answer secret prompts
with `ask`.
