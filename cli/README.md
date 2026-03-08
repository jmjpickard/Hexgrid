# @jackpickard/hexgrid-cli

HexGrid command line client for device login and repo session lifecycle.

## Install

```bash
npm install -g @jackpickard/hexgrid-cli
```

## Commands

```bash
hexgrid login
hexgrid setup
hexgrid doctor --fix
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

1. `hexgrid login` once per machine.
2. In each repo, run `hexgrid run codex` or `hexgrid run claude`.
3. CLI auto-configures MCP, connects session, keeps heartbeat alive, and disconnects on exit.

## Update CLI

```bash
hexgrid update
```
