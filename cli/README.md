# @jackpickard/hexgrid-cli

HexGrid command line client for device login and repo session lifecycle.

## Install

```bash
npm install -g @jackpickard/hexgrid-cli
```

## Commands

```bash
hexgrid login
hexgrid connect --runtime claude
hexgrid heartbeat
hexgrid disconnect
hexgrid me
hexgrid logout
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
