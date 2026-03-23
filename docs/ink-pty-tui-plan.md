# HexGrid Ink + PTY TUI Plan

## Summary

HexGrid should evolve from the current screen-owned prototype TUI into a real terminal
workspace controller with these properties:

- repo-first workspace model
- full-screen dashboard for status, navigation, and actions
- managed PTY-backed repo sessions
- attach/detach flow so sessions keep running while the operator returns to the dashboard
- terminal-agnostic core, with optional multiplexer integrations later

The key architectural shift is this:

- Ink is the right choice for the dashboard shell
- PTYs are the right choice for session execution
- a full embedded terminal emulator inside the dashboard is not a V1 requirement

## Decision Summary

Build the next TUI iteration around four explicit layers:

1. workspace state
2. runtime/session core
3. PTY supervisor
4. Ink shell

The current raw-stdin TUI should be treated as a temporary bridge, not the long-term
implementation path.

## Design Principles

- Keep one terminal owner at a time.
- Keep repo registration separate from runtime execution.
- Keep existing CLI commands working as stable automation primitives.
- Prefer attach/detach over fake embedded terminal panes.
- Keep local PTY state in memory and shared workspace metadata on disk.
- Do not introduce a background daemon in V1.

## Current State

Current files:

- [cli/bin/hexgrid.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/bin/hexgrid.mjs)
- [cli/src/workspace.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/src/workspace.mjs)
- [cli/src/tui.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/src/tui.mjs)

What exists now:

- workspace init and current workspace selection
- repo-first `repo add` flow with prompts
- workspace-aware `repo run` and `repo listen`
- a minimal full-screen TUI

Why the current TUI feels wrong:

- the dashboard owns the terminal until a repo is run
- once a runtime starts, the child process takes over the terminal
- the dashboard then has to disappear and reappear
- there is no persistent session supervisor
- there is no focus model between dashboard input and session input

This creates the exact confusion the user described: the terminal is contested by two
UIs instead of being multiplexed by one owner.

## Current Code Map

The current implementation is concentrated in three files:

- [cli/bin/hexgrid.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/bin/hexgrid.mjs)
  - command routing
  - runtime launch and listener logic
  - workspace command handlers
  - active workspace resolution
- [cli/src/workspace.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/src/workspace.mjs)
  - workspace manifest IO
  - local workspace bindings
  - current workspace state
- [cli/src/tui.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/src/tui.mjs)
  - screen rendering
  - key handling
  - temporary run-picker flow

That means the main structural problem is not too many files. The problem is that
runtime execution, workspace orchestration, and TUI ownership still sit too close
together in the entrypoint.

## Product Goal

Desired operator experience:

1. `hexgrid workspace init --name hertility`
2. `cd ~/code/v2-app`
3. `hexgrid repo add v2-app`
4. `hexgrid`
5. See a dashboard with all repos and sessions
6. Launch a repo session
7. Detach back to the dashboard without killing that session
8. Reattach or switch to another repo session later

The mental model should be:

- HexGrid is the operator shell
- repo runtimes are managed sessions within HexGrid
- the terminal never loses a controlling owner

## Non-Goals For V1

- render multiple fully interactive child terminal UIs simultaneously in split panes
- emulate the full behavior of a terminal emulator inside React
- background daemon that survives HexGrid process exit
- tmux/zellij integration as the primary execution path
- cross-machine shared live sessions

## Architectural Decision

## Ink For Shell, PTY For Sessions

Use Ink to build the dashboard and control surfaces.

Use a PTY layer to launch repo runtimes such as:

- `codex`
- `claude`
- future headless listeners or custom repo agents

Do not try to render child TUI output as React widgets in V1.

Instead, support two top-level modes:

- `dashboard mode`: Ink owns the terminal
- `attached mode`: HexGrid passes raw input/output through to the selected PTY, with a
  detach key sequence

This is much more feasible than trying to embed a full terminal emulator in the main Ink
view while still letting the child runtime use cursor movement, alt screen, prompt
rewrites, and raw keyboard input.

## Why Ink Alone Is Not Enough

Ink solves:

- layout
- focus
- keyboard event handling
- state-driven rendering
- maintainable component structure

Ink does not solve:

- pseudo-terminal process lifecycle
- raw pass-through input to child shells
- faithful rendering of interactive child TUIs
- attach/detach semantics

Therefore the stack must be:

- Ink for UI
- PTY management for child sessions
- a session supervisor between them

## Technical Stack

## Runtime / Packaging

Current CLI is plain ESM JS with no build step.

Recommended shift:

- migrate CLI source to TypeScript / TSX
- introduce a build step
- keep published CLI as a Node executable

Add these runtime dependencies:

- `react`
- `ink`
- `node-pty`

Add these build/dev dependencies:

- `typescript`
- `@types/node`
- `tsup` or `tsx`

Build constraints:

- keep published output as plain Node-executable JS
- do not require ts-node in production
- keep [cli/bin/hexgrid.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/bin/hexgrid.mjs)
  as a thin compatibility entrypoint

Recommended package script additions:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts false",
    "dev:tui": "tsx src/app/commands/tui.ts",
    "check": "npm run build && node ./bin/hexgrid.mjs --help"
  }
}
```

Recommended structure:

```text
cli/
  src/
    app/
      ink/
        App.tsx
        Dashboard.tsx
        Sidebar.tsx
        DetailPane.tsx
        StatusBar.tsx
        overlays/
          RuntimePicker.tsx
          ConfirmStop.tsx
          ErrorBanner.tsx
      supervisor/
        SessionSupervisor.ts
        PtySession.ts
        events.ts
        types.ts
      state/
        store.ts
        reducer.ts
        selectors.ts
      commands/
        tui.ts
        repo.ts
        workspace.ts
      core/
        config.ts
        workspace.ts
        api.ts
        repo.ts
        runtime.ts
        listener.ts
      utils/
        terminal.ts
        ids.ts
    index.ts
  bin/
    hexgrid.mjs
```

## PTY Layer

Use `node-pty` as the core backend for managed interactive sessions.

Each live repo runtime becomes:

- one PTY
- one child process
- one session record in HexGrid local state

`PtySession` responsibilities:

- spawn command in repo cwd
- inject HexGrid env vars
- collect output stream
- track lifecycle state
- support input writes
- support resize
- support graceful shutdown

Recommended session state:

```ts
type SessionStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'errored'

interface RepoSession {
  sessionId: string
  repoId: string
  runtime: 'codex' | 'claude'
  status: SessionStatus
  pid: number | null
  attached: boolean
  startedAt: number | null
  exitedAt: number | null
  exitCode: number | null
  lastOutputAt: number | null
  buffer: string[]
  cols: number
  rows: number
  error: string | null
}
```

Buffer policy:

- keep an in-memory ring buffer of recent output lines
- separate raw session logs from workspace metadata
- no full transcript persistence in V1

Recommended buffer sizing:

- `previewBuffer`: last 200 logical lines for dashboard preview
- `attachPassthrough`: no truncation while attached
- `crashTail`: last 100 lines retained for post-exit diagnostics

## Ink Application Model

## Core Modes

### 1. Dashboard Mode

Ink renders:

- left sidebar: repos / sessions / attention badges
- top bar: workspace name, counts, current mode
- main panel: selected repo summary or recent buffered output preview
- footer: keybindings

Keyboard behavior:

- `j` / `k` or arrows: move selection
- `Enter`: open repo detail
- `r`: launch runtime picker
- `a`: attach to selected running session
- `u`: refresh / reconcile
- `/`: command palette
- `q`: quit HexGrid

### 2. Attached Mode

Attached mode is not an Ink-rendered fake terminal pane.

Instead:

- pause or suspend Ink rendering
- give terminal IO pass-through to the selected PTY session
- intercept a single detach prefix, for example `Ctrl+]`
- on detach, restore Ink dashboard mode

This is closer to a lightweight multiplexer than to a dashboard that tries to re-render
another TUI inside itself.

### 3. Modal States

Small overlay/modal states inside dashboard mode:

- runtime picker
- command palette
- confirm stop session
- error banner

## Application State Model

Use one app reducer for all UI state. Do not let components own critical supervisor
state directly.

Suggested shape:

```ts
interface AppState {
  workspace: WorkspaceSnapshot | null
  sessions: Record<string, RepoSession>
  selectedRepoId: string | null
  mode: 'dashboard' | 'run-picker' | 'confirm-stop' | 'attached' | 'quitting'
  attachedRepoId: string | null
  flashMessage: string | null
  lastError: string | null
  lastRefreshAt: number | null
}
```

Rules:

- `selectedRepoId` is a repo concept, not a session concept
- `attachedRepoId` is nullable and must reference a running session
- `mode = attached` means Ink rendering is suspended
- the reducer should remain pure; PTY actions happen in command/controller layers

## State Machines

### App Mode State Machine

```text
dashboard -> run-picker -> dashboard
dashboard -> attached -> dashboard
dashboard -> confirm-stop -> dashboard
dashboard -> quitting
```

Invalid transitions:

- `attached -> run-picker`
- `attached -> attached` for a different repo without detaching first
- `run-picker -> attached` unless a session start succeeded

### Session Lifecycle State Machine

```text
idle -> starting -> running -> stopping -> stopped
idle -> starting -> errored
running -> errored
stopped -> starting
errored -> starting
```

Session invariants:

- only one interactive session per repo in V1
- a repo cannot be both `attached` and `stopped`
- `pid` is non-null only for `starting`, `running`, and `stopping`
- `lastOutputAt` must update on every PTY data event

## Attach / Detach Semantics

Attach flow:

1. user selects repo session
2. HexGrid resizes PTY to terminal size
3. HexGrid enters attached mode
4. all keypresses are forwarded to PTY
5. `Ctrl+]` detaches back to dashboard

Detach flow:

1. HexGrid stops forwarding raw input
2. PTY keeps running
3. Ink dashboard resumes
4. repo remains marked as running

Stop flow:

1. send `SIGINT`
2. wait grace period
3. send `SIGTERM`
4. hard kill if necessary
5. mark session stopped / errored

## Current Workspace Model

Keep and extend the existing current workspace concept in local config.

Required fields:

```ts
interface HexGridConfig {
  current_workspace_root?: string
  workspaces?: Record<string, {
    name: string
    repos: Record<string, {
      path: string
    }>
  }>
  sessions?: Record<string, {
    session_id: string
    repo_root: string
    runtime: string
    name: string
    connected_at: number
  }>
}
```

For the TUI, add ephemeral in-process state rather than persisting PTY process data to
config in V1.

## Session Supervisor

Introduce a `SessionSupervisor` singleton for the lifetime of the HexGrid process.

Responsibilities:

- maintain repo session map
- launch PTYs
- route output events
- route lifecycle events
- reconcile workspace state against running sessions
- handle terminal resize for attached session

Public interface:

```ts
interface SessionSupervisor {
  listSessions(): RepoSession[]
  getSession(repoId: string): RepoSession | null
  startSession(repoId: string, runtime: 'codex' | 'claude'): Promise<void>
  stopSession(repoId: string): Promise<void>
  attach(repoId: string): Promise<void>
  detach(): Promise<void>
  writeInput(data: string): void
  resize(cols: number, rows: number): void
  subscribe(listener: (event: SupervisorEvent) => void): () => void
}
```

Suggested event model:

```ts
type SupervisorEvent =
  | { type: 'session-starting'; repoId: string; runtime: 'codex' | 'claude' }
  | { type: 'session-started'; repoId: string; pid: number }
  | { type: 'session-output'; repoId: string; chunk: string; at: number }
  | { type: 'session-exited'; repoId: string; exitCode: number | null; signal: number | null }
  | { type: 'session-error'; repoId: string; message: string }
  | { type: 'attached'; repoId: string }
  | { type: 'detached'; repoId: string }
```

Implementation notes:

- keep `SessionSupervisor` process-local and singleton per HexGrid process
- do not persist PTY process IDs to config
- retain a repo-to-session map keyed by repo id, not by PTY pid
- expose a no-op `resize()` when there is no attached session

## Runtime Integration Contract

The PTY supervisor should not reimplement runtime setup. It should call extracted core
functions from the current CLI runtime flow.

Recommended extraction targets from [cli/bin/hexgrid.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/bin/hexgrid.mjs):

- config loading/saving
- login/session validation
- runtime setup and env construction
- HexGrid session connect/disconnect
- heartbeat management
- listener startup logic

That gives this boundary:

- `core/runtime.ts`: prepare and connect repo runtime
- `supervisor/PtySession.ts`: spawn and manage terminal process
- `app/commands/tui.ts`: orchestrate UI actions and dispatch reducer events

## CLI Command Model

## Keep Existing Commands

Do not remove:

- `hexgrid repo run`
- `hexgrid repo listen`
- `hexgrid workspace`
- `hexgrid repo list`

These remain useful for scripts and debugging.

## Add / Change Commands

### `hexgrid`

Behavior:

- interactive terminal + active workspace => open Ink TUI
- non-interactive => print JSON workspace summary

### `hexgrid tui`

Behavior:

- explicitly open the Ink TUI

### `hexgrid attach <repo_id>`

Optional but useful for debugging PTY attach without going through the dashboard.

Example:

```bash
hexgrid attach api
```

Behavior:

- verifies the repo has a running managed session in the current HexGrid process
- if not found, exits with a clear error
- if found, enters attached mode immediately

### `hexgrid repo stop <repo_id>`

Optional V1 command for non-TUI session shutdown.

## Recommended V1 Interaction Model

Do not build a sidebar plus fully interactive embedded repo terminals in the same frame
yet. That is a much harder problem because interactive child CLIs may use:

- cursor positioning
- full-screen redraws
- alternate screen
- raw input
- prompt rewriting

V1 should instead be:

- dashboard mode for selection and control
- attached mode for one live interactive session at a time

This still gives the user:

- switching between sessions
- keeping sessions alive
- returning to the dashboard
- terminal-agnostic behavior

## Later V2 Possibility: Embedded Session Pane

If still desired after V1:

- add an ANSI parser and viewport model
- store terminal cell state per PTY
- render a selected session into a pane inside the Ink UI
- keep sidebar visible while session output updates

This is a much larger project and should not block V1.

## Optional Multiplexer Backend

Keep tmux / zellij integration as an optional backend later.

Rationale:

- some users already live in tmux-like tools
- they solve pane splitting and persistence well
- HexGrid can sync session state into them

But this should remain optional because the core product must work in a normal terminal
without tmux assumptions.

## State Synchronization

There are two state planes:

### 1. Local runtime state

- PTY process IDs
- attached repo
- buffered output
- current focus mode

### 2. HexGrid network state

- connected session IDs
- heartbeats
- remote repo messaging
- knowledge notes

The supervisor bridges them.

When starting a repo session:

1. ensure runtime setup exists
2. connect HexGrid network session
3. spawn PTY process
4. start heartbeat loop
5. emit session-started event to Ink app

When the PTY exits:

1. stop heartbeat loop
2. disconnect HexGrid network session
3. mark local session stopped or errored
4. emit session-exited event

## Detailed Execution Flows

### Start Runtime From Dashboard

1. user selects repo
2. user opens runtime picker
3. controller resolves repo binding from active workspace
4. controller validates login and runtime binary
5. controller asks core runtime layer for spawn config and session metadata
6. supervisor starts PTY with that config
7. reducer receives `session-starting`
8. reducer receives `session-started`
9. dashboard reflects running state

### Attach To Running Session

1. user selects a running repo
2. controller calls `supervisor.attach(repoId)`
3. Ink unsubscribes from raw key handling
4. terminal enters PTY pass-through
5. `Ctrl+]` triggers local detach handling
6. Ink resumes and redraws dashboard

### Stop Runtime

1. user selects repo
2. confirm stop overlay opens
3. controller calls `supervisor.stopSession(repoId)`
4. supervisor sends interrupt sequence
5. reducer remains in stopping state until exit event
6. on exit, dashboard returns repo to `idle`, `stopped`, or `errored`

### Refresh / Reconcile

1. reload workspace manifest and local bindings
2. ask supervisor for live session state
3. merge into one `WorkspaceSnapshot`
4. recompute attention flags
5. redraw dashboard

## Error Handling

Required error classes:

- workspace not found
- repo not bound locally
- runtime missing from PATH
- setup missing or stale
- login missing
- PTY spawn failure
- HexGrid connect failure
- heartbeat failure
- session crash

UI behavior:

- banner for transient errors
- detail panel for last error on selected repo
- explicit stopped/errored states in repo list

## Testing Strategy

## Unit Tests

Test:

- workspace resolution
- session reducer / supervisor state transitions
- keybinding mode transitions
- attach/detach state changes
- error banner behavior

## Integration Tests

Use PTY-backed fake commands to test:

- start session
- receive output
- detach
- reattach
- stop session

Recommended fake session fixture:

- Node script that prints boot text
- accepts stdin
- redraws output
- handles `SIGINT`
- exits with configurable code

This avoids using Codex/Claude binaries in automated tests.

## Manual Acceptance Tests

Scenarios:

1. initialize workspace, add repo, launch TUI
2. run Codex from dashboard
3. detach back to dashboard
4. launch Claude in another repo
5. switch selection while both sessions exist
6. reattach to first session
7. stop a session
8. resize terminal during attach and dashboard modes

## Acceptance Criteria

V1 is complete when all of the following hold:

- `hexgrid` opens the dashboard in an interactive terminal when an active workspace is set
- `hexgrid` in non-interactive mode prints machine-readable workspace status
- a user can launch Codex or Claude for a selected repo from the dashboard
- a launched session stays alive after detaching back to the dashboard
- a user can reattach to the same session later in the same HexGrid process
- terminal resize works in both dashboard and attached modes
- session crash and startup failure are visible in the dashboard
- existing scripted commands still work outside the TUI

## Rollout Plan

## Phase 1. Build Infrastructure

- add TypeScript / TSX build pipeline
- add Ink dependency
- add `node-pty`
- split CLI core into reusable modules

Deliverable:

- existing non-TUI commands still work

## Phase 2. Session Supervisor

- implement `PtySession`
- implement `SessionSupervisor`
- introduce event subscription model

Deliverable:

- repo sessions can be started and tracked without UI

## Phase 3. Ink Dashboard

- build static dashboard shell
- show repos, statuses, and selected repo details
- show live supervisor session state

Deliverable:

- no raw passthrough yet, but stable dashboard architecture exists

## Phase 4. Attach / Detach

- implement raw pass-through attached mode
- add detach prefix
- restore dashboard mode cleanly

Deliverable:

- one live interactive repo session can be attached and detached cleanly

## Phase 5. Runtime Actions

- launch runtime from dashboard
- stop runtime from dashboard
- reflect last errors and recent output

Deliverable:

- dashboard becomes the main operator shell

## Phase 6. Attention Model

- unread indicators
- listener status
- stale heartbeat states
- session crash banners

Deliverable:

- dashboard starts feeling like a real control center

## Phase 7. Optional Advanced Features

- command palette
- search
- embedded output preview
- multiplexer adapter
- embedded pane rendering experiments

## Migration Plan

Implement this without a flag day.

### Step 1. Extract core modules

Move workspace/runtime/session helpers out of [cli/bin/hexgrid.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/bin/hexgrid.mjs) into `cli/src/core/*`.

Exit criterion:

- `hexgrid repo run` and `hexgrid repo listen` still behave the same

### Step 2. Add build pipeline

Introduce TypeScript and a build target without changing published command behavior.

Exit criterion:

- `npm --prefix cli run check` still passes

### Step 3. Add supervisor without UI

Create `PtySession` and `SessionSupervisor`, then exercise them through a hidden dev path
or tests before replacing the TUI.

Exit criterion:

- sessions can be started, tracked, and stopped programmatically

### Step 4. Replace raw TUI with Ink shell

Keep the same high-level `hexgrid` behavior while swapping [cli/src/tui.mjs](/Users/jackpickard/Documents/repos/hexgrid/cli/src/tui.mjs) for an Ink app entrypoint.

Exit criterion:

- dashboard navigation matches current V1 behavior

### Step 5. Add attach/detach

Only after the supervisor is stable.

Exit criterion:

- session passthrough and detach are reliable across repeated cycles

## Risks

## Native Dependency Risk

`node-pty` is native code.

Risk:

- install/build friction across platforms

Mitigation:

- test on macOS first
- keep fallback non-TUI commands usable
- consider prebuilt variants only if necessary

## Child CLI Compatibility Risk

Codex/Claude may behave unpredictably inside nested terminal abstractions.

Mitigation:

- use true PTY attach mode
- avoid fake re-rendering of their UIs in V1

## Complexity Risk

Trying to do dashboard panes plus fully interactive embedded sessions immediately will
expand the scope massively.

Mitigation:

- stick to dashboard mode + attached mode first

## Open Questions

These do not block V1, but they should stay visible:

- Should listener supervision live in the same supervisor as interactive sessions, or in a sibling service?
- Do we want dashboard state persistence such as selected repo between launches?
- Should bare `hexgrid` open the dashboard even when no active workspace exists, or should it open a workspace chooser?
- How much recent output should be retained after a crash before memory use becomes a problem?

## Recommended Decision

Proceed with:

- Ink dashboard
- PTY session supervisor
- attach/detach model
- bare `hexgrid` opening the dashboard

Do not proceed yet with:

- embedded multi-pane interactive terminals
- tmux-specific architecture

That gets HexGrid to a serious, usable, terminal-agnostic operator shell without taking
on terminal emulator complexity too early.
