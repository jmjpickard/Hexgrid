# HexGrid Workspace Control Center Plan

## Summary

HexGrid should move from a repo-local helper CLI to a workspace-level control plane for
multiple repositories. The operator experience should become:

1. Register repos once into a named workspace.
2. Open `hexgrid` with no args to enter a full-screen control center.
3. See which repos are idle, live, stale, blocked, or need attention.
4. Start Claude or Codex in a specific repo on demand.
5. Let HexGrid supervise optional fallback listeners for repos that should remain
   reachable when no interactive agent is open.

The current CLI commands remain the execution layer. The new workspace/TUI layer should
compose them rather than replace them.

## Product Position

The product is not "one agent that can jump between repos." The product is a workspace
containing multiple repo-bound hexes that can:

- run independently
- message each other
- share knowledge
- expose attention state to a human operator

This keeps repo context narrow and makes cross-repo collaboration explicit.

## Goals

- Add a first-class workspace model above individual repos.
- Make repo registration persistent and ergonomic.
- Replace `switch`-heavy UX with a full-screen TUI.
- Preserve scriptable CLI primitives under the hood.
- Support explicit human launch of `claude` or `codex` per repo.
- Support optional auto-managed listeners per repo.
- Surface attention: unread inbox, stale heartbeat, setup drift, missing path, failed
  listener, blocked dependency.

## Non-Goals For V1

- Automatically launch interactive Claude/Codex sessions for every repo.
- Automatically run the whole local platform (`npm run dev` across all services).
- Replace the web dashboard as part of this first phase.
- Introduce roaming multi-repo sessions for a single agent.
- Build a generic process manager before workspace/session management is stable.

## Key Product Decisions

### 1. `repo add` is declarative, not operational

`hexgrid repo add` should register a repo in the workspace and validate metadata. It
should not automatically start a runtime or listener.

What `repo add` does:

- create or update a stable repo id within the workspace
- store shareable repo metadata
- store machine-local path binding
- detect repo root and remote where possible
- optionally run onboarding if requested

What `repo add` does not do:

- launch `claude`
- launch `codex`
- launch a listener
- claim that the repo is "live"

### 2. `workspace` supervises listeners, not all runtimes

The control center should supervise background listeners only for repos explicitly
configured with `listen = auto`.

Interactive runtimes should remain explicit human actions:

- `Run Claude`
- `Run Codex`
- `Reconnect`
- `Stop`

This avoids unexpectedly spawning heavyweight sessions across the workspace.

### 3. Interactive session beats fallback listener

The current `run` flow already connects a repo-bound session with `repo:<name>` in its
capabilities. That means a live interactive runtime can answer repo-routed questions
without a separate listener process.

Workspace rule:

- if an interactive repo session is running, it is the primary live endpoint
- if no interactive session is running and `listen = auto`, HexGrid keeps a fallback
  listener alive
- if `listen = manual`, the human can start/stop the listener explicitly
- if `listen = off`, the repo is reachable only via knowledge or a live runtime

### 4. One live interactive session per repo

V1 should assume at most one primary interactive runtime per repo. This keeps status,
routing, and operator reasoning simple.

Allowed examples:

- `api` has one live Codex session
- `web` has one live Claude session
- `worker` has only a fallback listener

Not a V1 target:

- two competing primary sessions in the same repo with unclear authority

## UX Model

## Default Entry

`hexgrid` with no args opens the workspace TUI.

The current command set remains available for scripting:

- `hexgrid workspace init`
- `hexgrid repo add`
- `hexgrid repo list`
- `hexgrid repo run`
- `hexgrid repo listen`
- `hexgrid ask`
- `hexgrid inbox`

## Primary Views

### Overview

The default screen should be attention-first, not map-first.

Shows:

- repo list
- status per repo
- runtime per repo
- unread counts
- stale/failing items
- quick actions

### Repo Detail

Shows:

- repo metadata
- current session or listener state
- recent logs/events
- setup health
- inbox related to that repo
- quick actions

### Inbox

Shows:

- repo-to-repo requests
- pending questions
- answered items
- failures/timeouts

### Command Palette

Used for:

- fuzzy repo switching
- running Claude/Codex
- starting/stopping listeners
- opening logs
- asking another repo

### Map

Keep the hex map as a secondary orientation view, not the primary operator surface.

## Suggested Hotkeys

- `j` / `k`: move selection
- `Enter`: open selected repo
- `a`: ask another repo
- `r`: run runtime picker
- `l`: toggle listener
- `i`: inbox
- `s`: search
- `m`: map
- `/`: command palette
- `q`: quit

## Data Model

## Shared Workspace Manifest

Store shareable workspace metadata in the repo root:

`hexgrid.workspace.json`

Example:

```json
{
  "name": "platform",
  "version": 1,
  "repos": {
    "api": {
      "remote": "github.com/acme/api-service",
      "description": "Core API and auth",
      "defaultRuntime": "codex",
      "listen": "auto",
      "dependsOn": ["worker"],
      "startup": {
        "command": "pnpm dev",
        "health": "http://localhost:4000/health"
      }
    },
    "web": {
      "remote": "github.com/acme/web-app",
      "description": "Customer-facing frontend",
      "defaultRuntime": "claude",
      "listen": "manual",
      "dependsOn": ["api"]
    }
  }
}
```

## Local Machine Bindings

Store machine-specific path bindings in user config, not the shared manifest.

Suggested shape inside CLI config:

```json
{
  "workspaces": {
    "platform": {
      "repos": {
        "api": {
          "path": "/Users/jackpickard/src/api-service"
        },
        "web": {
          "path": "/Users/jackpickard/src/web-app"
        }
      }
    }
  }
}
```

Reason:

- absolute paths are not shareable across teammates or machines
- shared metadata and local bindings have different lifecycles

## Repo Status Model

Each repo in the TUI should resolve into one of these status buckets:

- `idle`: registered, path valid, nothing running
- `listener`: fallback listener active
- `active`: interactive Claude/Codex session active
- `stale`: session or listener heartbeat missing
- `blocked`: missing path, setup drift, runtime binary missing, or launch failure
- `unknown`: repo exists in manifest but cannot yet be reconciled locally

Status should also carry attention flags:

- unread inbox
- setup required
- listener crashed
- runtime crashed
- dependency blocked

## CLI Surface

## New Commands

### `hexgrid workspace init`

Creates `hexgrid.workspace.json` in the current directory.

Initial behavior:

- detect current repo and offer it as the first registered repo
- create workspace metadata structure
- do not start anything

### `hexgrid repo add`

Proposed usage:

```bash
hexgrid repo add api \
  --path ~/src/api-service \
  --remote github.com/acme/api-service \
  --description "Core API and auth" \
  --runtime codex \
  --listen auto
```

Behavior:

- validates the repo path
- discovers repo root
- infers remote if omitted
- writes shareable metadata to `hexgrid.workspace.json`
- writes local path binding to CLI config
- optionally supports `--onboard`

### `hexgrid repo list`

Lists workspace repos with:

- id
- path
- runtime default
- listener mode
- current live status

### `hexgrid repo run <repo>`

Launches an interactive runtime in the registered repo path.

Examples:

```bash
hexgrid repo run api --runtime codex
hexgrid repo run web --runtime claude
```

Behavior:

- resolves repo path from workspace bindings
- runs the same logic as current `hexgrid run`
- becomes available to other repos via `repo:<id>`

### `hexgrid repo listen <repo>`

Starts a fallback listener in the registered repo path.

Examples:

```bash
hexgrid repo listen api
hexgrid repo listen api --runtime claude
```

V1 note:

- current implementation is Claude-specific
- Codex listener support can be added later or treated as unsupported for V1

### `hexgrid workspace doctor`

Checks:

- workspace manifest validity
- local path bindings
- repo existence
- runtime binaries
- MCP/runtime setup drift
- live session/listener state

## TUI Behavior

The TUI should be a thin orchestration shell over the CLI core. It should not have its
own separate business logic for sessions, listeners, or repo detection.

Recommended architecture:

- extract current CLI logic into reusable core modules
- add a TUI entrypoint that calls those modules
- keep command handlers as wrappers over the same core

This avoids two divergent implementations.

## Supervisor Rules

The workspace TUI may run a lightweight local supervisor loop.

Responsibilities:

- reconcile workspace manifest with local bindings
- observe live sessions from the API
- track child processes started by the TUI
- restart auto listeners if they die
- never auto-start interactive runtimes without explicit human intent

Reconciliation order per repo:

1. check path binding
2. check runtime/setup health
3. check whether an interactive session already exists
4. if no interactive session and `listen = auto`, ensure listener is alive
5. surface any mismatch in the attention list

## Runtime Lifecycle

## Interactive Runtime

Human-initiated action from TUI or CLI.

Flow:

1. Resolve repo from workspace.
2. Validate runtime binary and setup.
3. Apply runtime setup if needed.
4. Connect HexGrid session.
5. Launch `claude` or `codex` in repo cwd.
6. Maintain heartbeat.
7. Disconnect cleanly on exit.

## Fallback Listener

Workspace-supervised if configured as `auto`.

Flow:

1. Resolve repo from workspace.
2. Verify no interactive session is already serving that repo.
3. Register listener session.
4. Poll inbox for `repo:<id>` capability work.
5. Answer headlessly.
6. Maintain heartbeat.
7. Restart on crash if policy is `auto`.

## Cross-Repo Messaging Model

Preferred routing order:

1. Knowledge hit
2. Live interactive session for target repo
3. Fallback listener for target repo
4. Human-visible timeout/attention state

This keeps knowledge cheap, interactive sessions authoritative when present, and
listeners as coverage rather than the main path.

## Implementation Plan

## Phase 1. CLI Core Extraction

- split `cli/bin/hexgrid.mjs` into reusable modules
- isolate config loading/saving
- isolate repo detection and runtime setup
- isolate session connect/disconnect/heartbeat
- isolate listener logic

Deliverable:

- existing commands still work
- new modules can be called from a TUI

## Phase 2. Workspace Registry

- add manifest read/write helpers
- add local path binding storage
- implement `workspace init`
- implement `repo add`
- implement `repo list`
- implement `workspace doctor`

Deliverable:

- multiple repos can be registered and resolved by stable ids

## Phase 3. TUI Skeleton

- add full-screen entrypoint for `hexgrid`
- build overview pane
- build repo detail pane
- add command palette
- wire hotkeys

Deliverable:

- human can navigate repos and inspect state without subcommand churn

## Phase 4. Runtime Actions

- add `Run Claude` / `Run Codex` actions from the TUI
- add stop/reconnect flows
- show logs and session metadata

Deliverable:

- TUI becomes the main operational surface

## Phase 5. Listener Supervision

- add `listen = auto|manual|off`
- add child-process supervision for auto listeners
- surface listener crash/restart state in attention UI

Deliverable:

- repos can remain reachable without manually opening every agent

## Phase 6. Advanced Operator UX

- global inbox view
- search across repos and notes
- map view integration
- dependency/blocker indicators
- optional startup recipes for future `system up`

Deliverable:

- polished control center with strong operator ergonomics

## Technical Notes

## TUI Library

Recommendation: use Ink for V1.

Reason:

- team already works comfortably with React-style components
- easier to reason about panes, focus, and state transitions
- command palette and list/detail views fit the model well

This does require moving the CLI away from a single-file script, which is already needed.

## Compatibility With Existing CLI

Current behavior to preserve:

- `run` connects a repo-bound interactive session and heartbeats it
- `listen` is a separate poller mode
- current sessions already advertise `repo:<repoName>`

The workspace layer should treat these as the source of truth instead of introducing a
different session model.

## Open Questions

- Should repo ids be human-chosen only, or auto-suggested from the remote/path?
- Should `repo add` default `listen` to `manual` or `auto`?
- Do we want a single workspace manifest per platform repo, or a separate top-level
  "workspace home" outside any one repo?
- Should listener runtime be configurable independently from default interactive runtime?
- When a repo has both a live session and auto listener policy, should the listener be
  suspended or simply not started?
- Do we want V1 TUI to show raw terminal logs inline, or just summarized lifecycle events?

## Recommended Default Decisions

To keep V1 moving, default to:

- repo ids are explicit but auto-suggested
- `listen = manual` by default
- one workspace manifest in the operator's chosen root directory
- interactive runtime default is per repo
- listener runtime defaults to Claude for V1
- auto listener is not started when an interactive session is already active
