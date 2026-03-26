# @jackpickard/hexgrid-cli

HexGrid command line client for device login and repo session lifecycle.

## Install

```bash
npm install -g @jackpickard/hexgrid-cli
```

## Commands

```bash
hexgrid workspace init --name platform
cd ~/src/api-service
hexgrid repo add api

# you can still be explicit when scripting
hexgrid repo add api --path ~/src/api-service --runtime codex --listen manual
hexgrid repo list
hexgrid
hexgrid ui
hexgrid repo run api --runtime codex
hexgrid repo listen api

# repo-local flows still work
hexgrid login
hexgrid setup
hexgrid doctor --fix
hexgrid onboard
hexgrid run codex
# or
hexgrid run claude

# optional low-level/session controls
hexgrid connect --runtime codex
hexgrid sessions
hexgrid ask --to "<session_id|name|hex_id>" --question "Can you review PR #42?"
hexgrid inbox
hexgrid reply --message "<message_id>" --answer "LGTM, merge after CI."
hexgrid response "<message_id>"
hexgrid heartbeat
hexgrid disconnect
hexgrid me
hexgrid logout
hexgrid update
```

`hexgrid workspace init` marks that workspace as the current workspace in local config.
After that, you can run `hexgrid repo add <repo_id>` from inside a cloned repo and the
CLI will prompt for the remaining fields, with the current repo path detected by default.

`hexgrid` with no arguments now opens the active workspace TUI in an interactive terminal.
If stdout is not a TTY, it falls back to the JSON workspace summary.

`hexgrid ui` starts a localhost browser UI for the current workspace. The browser surface is
local-only: HexGrid still uses the remote API for auth, heartbeat, inbox, and knowledge, but
interactive Claude/Codex terminals stay on your machine and stream over a localhost connection.

## TUI controls

- `j` / `k`: move between repos
- `r`: open runtime picker for the selected repo
- `c`: run selected repo with Codex after pressing `r`
- `l`: run selected repo with Claude after pressing `r`
- `u`: refresh workspace state
- `q`: quit

## Login flow

`hexgrid login` uses a browser-based device flow:

1. CLI prints an approval URL and code
2. User approves in browser (`/device`)
3. CLI stores token in `~/.config/hexgrid/config.json`

## Runtime flags

- `--api-url <url>` override API base URL
- `--runtime <name>` set session runtime tag (`claude`, `codex`, etc.)
- `--name <name>` override generated session name
- `--description <text>` override generated session description
- `--heartbeat-seconds <n>` heartbeat cadence for `run` (default `300`)

## CLI wrappers vs MCP

- CLI wrappers (`sessions`, `ask`, `inbox`, `reply`, `response`) are convenience commands for human operators.
- MCP remains the extensible mode for agent-native orchestration and custom workflows.

## Recommended UX

1. `hexgrid workspace init` once at your chosen workspace root.
2. `cd` into each cloned repo and register it with `hexgrid repo add <repo_id>`.
3. `hexgrid login` once per machine.
4. In each repo, run `hexgrid onboard` once to publish a first-pass repo dossier.
5. Use `hexgrid` to inspect the current workspace from anywhere.
6. Use `hexgrid ui` if you want the workspace in a browser-backed localhost control plane.
7. Start a live session with `hexgrid repo run <repo>` or from inside a repo with `hexgrid run codex|claude`.
8. CLI auto-configures MCP, connects session, keeps heartbeat alive, and disconnects on exit.

## Update CLI

```bash
hexgrid update
```
