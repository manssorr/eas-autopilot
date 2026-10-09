# Agentic model (target design)

Status: proposed. Not built yet.

## Goal

eas-autopilot is an agentic, human-in-the-loop tool. An agent drives it, not a human at a keyboard. The human steps in only for secrets and real decisions. It is offered as an MCP server that owns a terminal, and as a CLI with the same contract.

## Who drives

- An agent starts and drives every run: a cheap model is enough (for example Claude Haiku or Codex `gpt-5.6-luna`).
- The tool runs the command in a terminal (pty) that the human can see.
- The agent reads the tool's events, not the raw screen.

## How a prompt is handled

| Prompt kind | Who answers | How |
| --- | --- | --- |
| Routine (known to the Flow) | the Flow | answers by itself |
| Choice, yes/no, plain value | the human, through the agent | the agent asks with the harness's own question tool and passes the answer back |
| Secret (password, 2FA code) | the human only | see below; the agent never sees or types a secret |

Secret options, the human picks one:

1. Type it in the visible terminal when the tool pauses.
2. Write it in a one-time secret file that the tool opens for the human; the tool reads it, passes it to the child, then deletes the file. The value never goes to the agent or to a recording.
3. Rerun that step in an external terminal, then let the agent continue.

## Learning from runs

- Every run is recorded (secrets excluded) and kept in local history.
- A prompt no Flow rule matches is a new scenario. The tool hands it to the human, records the answer, and proposes a Flow rule for it (`learn`), checked by replaying the recording (`check`).
- After each run the tool gives feedback: how this run compared with the Flow and past runs (new prompts, changed wording, slower steps, answers that differ from the usual).

## Sharing a new scenario

When a run hits a scenario the shipped Flows do not support, the tool offers to share it upstream as an issue or a pull request to the tool's repository.

- The shared version is anonymized: no project name, bundle ids, team ids, emails, device names or UDIDs, account names, tokens or paths. Values are replaced with placeholders.
- It contains the steps, the prompt texts, the proposed Flow rule, and the eas-cli version.
- The human reviews the exact text before anything is sent.

## Interfaces

- **MCP:** tools such as `start(flow, params)`, `status()`, `answer(promptId, value)`, `secret(promptId, via)`, `stop()`, `history()`, `learn(runId)`, `share(runId)`.
- **CLI:** the current commands (`run`, `record`, `learn`, `check`, `history`), plus a machine-readable event stream for agents.

## Open questions

- MCP first, or a CLI event stream first?
- Where the one-time secret file lives and how it is opened on each OS.
- How the harness question tool is reached from an MCP (elicitation or the agent relaying).
