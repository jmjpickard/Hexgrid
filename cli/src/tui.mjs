import process from 'node:process'
import { emitKeypressEvents } from 'node:readline'

const REFRESH_INTERVAL_MS = 10_000
const MIN_WIDTH = 96
const MIN_HEIGHT = 22
const VIEW_ORDER = ['overview', 'sessions', 'inbox', 'knowledge']

function pad(input, width) {
  const text = String(input ?? '')
  if (text.length >= width) return text
  return `${text}${' '.repeat(width - text.length)}`
}

function truncate(input, width) {
  const text = String(input ?? '')
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width <= 3) return text.slice(0, width)
  return `${text.slice(0, width - 3)}...`
}

function line(width, char = '-') {
  return char.repeat(Math.max(0, width))
}

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function formatAge(timestampSeconds) {
  if (!timestampSeconds) return 'n/a'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestampSeconds))
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

function formatTimestamp(timestampSeconds) {
  if (!timestampSeconds) return 'n/a'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(Number(timestampSeconds) * 1000))
}

function statusGlyph(status) {
  if (status === 'active') return '*'
  if (status === 'blocked') return '!'
  if (status === 'idle') return '.'
  return '?'
}

function wrapText(input, width, maxLines = Infinity) {
  if (width <= 0) return ['']

  const output = []
  const rawLines = String(input ?? '').split('\n')

  for (const rawLine of rawLines) {
    const cleanLine = rawLine.replace(/\s+/g, ' ').trim()
    if (!cleanLine) {
      output.push('')
      if (output.length >= maxLines) break
      continue
    }

    const words = cleanLine.split(' ')
    let current = ''

    for (const word of words) {
      if (!current) {
        current = word
        continue
      }

      if (current.length + 1 + word.length <= width) {
        current += ` ${word}`
        continue
      }

      output.push(truncate(current, width))
      if (output.length >= maxLines) break
      current = word
    }

    if (output.length >= maxLines) break
    if (current) output.push(truncate(current, width))
    if (output.length >= maxLines) break
  }

  if (output.length === 0) return ['']
  if (output.length <= maxLines) return output
  return output.slice(0, maxLines)
}

function appendSection(rows, title, lines, width, { maxLines = Infinity } = {}) {
  rows.push(title)

  let usedLines = 0
  for (const lineText of lines) {
    if (usedLines >= maxLines) break
    const wrapped = wrapText(lineText, width, maxLines - usedLines)
    rows.push(...wrapped)
    usedLines += wrapped.length
  }

  rows.push('')
}

function clampIndex(index, items) {
  if (!Array.isArray(items) || items.length === 0) return 0
  return Math.max(0, Math.min(index, items.length - 1))
}

function windowRows(rows, height, selectedLineIndex, pinnedTop = 2) {
  if (rows.length <= height) return rows

  const staticRows = rows.slice(0, pinnedTop)
  const dynamicRows = rows.slice(pinnedTop)
  const dynamicHeight = Math.max(0, height - staticRows.length)

  if (dynamicHeight <= 0) return rows.slice(0, height)
  if (dynamicRows.length <= dynamicHeight) return [...staticRows, ...dynamicRows]

  const dynamicSelected = Math.max(0, selectedLineIndex - pinnedTop)
  const centeredStart = dynamicSelected - Math.floor(dynamicHeight / 2)
  const start = Math.max(0, Math.min(centeredStart, dynamicRows.length - dynamicHeight))

  return [...staticRows, ...dynamicRows.slice(start, start + dynamicHeight)]
}

function renderTabs(activeView, width) {
  const labels = [
    ['overview', '[o] Overview'],
    ['sessions', '[s] Sessions'],
    ['inbox', '[i] Inbox'],
    ['knowledge', '[n] Knowledge'],
  ].map(([view, label]) => (
    view === activeView ? `> ${label} <` : `  ${label}  `
  ))

  return truncate(labels.join(' | '), width)
}

function renderRepoRow(repo, width, selected) {
  const activity = repo.counts?.sessions ?? 0
  const pending = repo.counts?.pending_messages ?? 0
  const candidate = repo.counts?.candidate_notes ?? 0
  const signal = pending > 0 ? '!' : candidate > 0 ? '+' : ' '
  const metrics = `${activity}s ${pending}m ${candidate}c`
  const prefix = `${selected ? '>' : ' '} ${statusGlyph(repo.status)}${signal} ${repo.repo_id}`
  const available = Math.max(0, width - metrics.length - 1)
  return `${pad(truncate(prefix, available), available)} ${metrics}`
}

function renderSessionRow(session, width, selected, pendingCount) {
  const mode = session.attached ? '@' : session.mode === 'listener' ? 'L' : session.managed_status ? 'M' : 'A'
  const runtime = truncate(session.runtime ?? 'unknown', 8)
  const repo = truncate(session.repo_id ?? 'unmapped', 14)
  const age = formatAge(session.last_heartbeat)
  const metrics = `${pendingCount}m ${truncate(age, 7)}`
  const prefix = `${selected ? '>' : ' '} ${mode} ${runtime} ${repo}`
  const available = Math.max(0, width - metrics.length - 1)
  return `${pad(truncate(prefix, available), available)} ${metrics}`
}

function renderInboxRow(message, width, selected) {
  const prefix = `${selected ? '>' : ' '} ${message.repo_id ?? 'repo?'} ${formatAge(message.created_at)}`
  const question = truncate(message.question, Math.max(0, width - prefix.length - 1))
  return truncate(`${prefix} ${question}`.trim(), width)
}

function knowledgeGlyph(note) {
  if (note.status === 'candidate') return 'C'
  if (note.kind === 'qa') return 'Q'
  return 'K'
}

function renderKnowledgeRow(note, width, selected) {
  const prefix = `${selected ? '>' : ' '} ${note.repo_id ?? 'repo?'} ${knowledgeGlyph(note)}`
  const topic = truncate(note.topic, Math.max(0, width - prefix.length - 1))
  return truncate(`${prefix} ${topic}`.trim(), width)
}

function getSelectedRepo(snapshot, state) {
  return snapshot.repos?.[clampIndex(state.selectedRepoIndex, snapshot.repos)] ?? null
}

function getSelectedSession(snapshot, state) {
  return snapshot.sessions?.[clampIndex(state.selectedSessionIndex, snapshot.sessions)] ?? null
}

function getSelectedInboxMessage(snapshot, state) {
  return snapshot.inbox?.[clampIndex(state.selectedInboxIndex, snapshot.inbox)] ?? null
}

function getSelectedKnowledgeNote(snapshot, state) {
  return snapshot.knowledge?.[clampIndex(state.selectedKnowledgeIndex, snapshot.knowledge)] ?? null
}

function focusRepo(state, snapshot, repoId) {
  const repoIndex = snapshot.repos.findIndex(repo => repo.repo_id === repoId)
  if (repoIndex === -1) return false
  state.selectedRepoIndex = repoIndex
  state.view = 'overview'
  return true
}

function buildOverviewColumns(snapshot, state, leftWidth, rightWidth) {
  const repos = Array.isArray(snapshot.repos) ? snapshot.repos : []
  const selectedRepo = getSelectedRepo(snapshot, state)

  const leftRows = [`Repos (${repos.length})`, '']
  if (repos.length === 0) {
    leftRows.push('No repos registered yet.')
    leftRows.push('Run `hexgrid repo add <repo_id>` from a checkout.')
  } else {
    for (let index = 0; index < repos.length; index += 1) {
      leftRows.push(renderRepoRow(repos[index], leftWidth, index === state.selectedRepoIndex))
    }
  }

  const rightRows = []
  if (!selectedRepo) {
    appendSection(rightRows, 'Workspace', [
      'No repo selected.',
      'Add repos to the workspace to start using the control center.',
    ], rightWidth)
    return { leftRows, rightRows }
  }

  appendSection(rightRows, `Repo ${selectedRepo.repo_id}`, [
    `State: ${selectedRepo.status} | default runtime: ${selectedRepo.default_runtime ?? 'n/a'} | listen: ${selectedRepo.listen ?? 'manual'}`,
    `Sessions: ${selectedRepo.counts?.sessions ?? 0} | inbox: ${selectedRepo.counts?.pending_messages ?? 0} | candidate notes: ${selectedRepo.counts?.candidate_notes ?? 0}`,
    selectedRepo.description ? `Description: ${selectedRepo.description}` : 'Description: n/a',
  ], rightWidth)

  appendSection(rightRows, 'Bindings', [
    `Path: ${selectedRepo.path ?? 'not bound on this machine'}`,
    `Remote: ${selectedRepo.remote ?? 'n/a'}`,
  ], rightWidth)

  appendSection(
    rightRows,
    'Attention',
    selectedRepo.attention?.length > 0
      ? selectedRepo.attention
      : ['No immediate issues for this repo.'],
    rightWidth,
    { maxLines: 6 },
  )

  if (selectedRepo.managed_session) {
    appendSection(rightRows, 'Managed Session', [
      `Runtime: ${selectedRepo.managed_session.runtime} | status: ${selectedRepo.managed_session.status} | attached: ${selectedRepo.managed_session.attached ? 'yes' : 'no'}`,
      selectedRepo.managed_session.error ? `Error: ${selectedRepo.managed_session.error}` : 'Error: none',
    ], rightWidth)
  }

  appendSection(
    rightRows,
    'Live Agents',
    selectedRepo.active_sessions?.length > 0
      ? selectedRepo.active_sessions.slice(0, 4).map(session => (
        `${session.name} | ${session.runtime} | ${session.mode} | heartbeat ${formatAge(session.last_heartbeat)}`
      ))
      : ['No active sessions for this repo.'],
    rightWidth,
    { maxLines: 8 },
  )

  appendSection(
    rightRows,
    'Pending Inbox',
    selectedRepo.pending_messages?.length > 0
      ? selectedRepo.pending_messages.slice(0, 3).map(message => (
        `${message.from_session_name} -> ${message.to_session_name}: ${message.question}`
      ))
      : ['No pending agent requests.'],
    rightWidth,
    { maxLines: 9 },
  )

  appendSection(
    rightRows,
    'Shared Knowledge',
    selectedRepo.knowledge_notes?.length > 0
      ? selectedRepo.knowledge_notes.slice(0, 4).map(note => (
        `${note.status}/${note.kind}: ${note.topic}`
      ))
      : ['No recent workspace knowledge for this repo.'],
    rightWidth,
    { maxLines: 8 },
  )

  return { leftRows, rightRows }
}

function buildSessionsColumns(snapshot, state, leftWidth, rightWidth) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const inbox = Array.isArray(snapshot.inbox) ? snapshot.inbox : []
  const selectedSession = getSelectedSession(snapshot, state)

  const leftRows = [`Sessions (${sessions.length})`, '']
  if (sessions.length === 0) {
    leftRows.push('No active sessions in this workspace.')
    leftRows.push('Run a repo from the dashboard to start one.')
  } else {
    for (let index = 0; index < sessions.length; index += 1) {
      const pendingCount = inbox.filter(message => message.to_session_id === sessions[index].session_id).length
      leftRows.push(renderSessionRow(sessions[index], leftWidth, index === state.selectedSessionIndex, pendingCount))
    }
  }

  const rightRows = []
  if (!selectedSession) {
    appendSection(rightRows, 'Session', [
      'No session selected.',
    ], rightWidth)
    return { leftRows, rightRows }
  }

  const sessionInbox = inbox.filter(message => message.to_session_id === selectedSession.session_id)
  appendSection(rightRows, selectedSession.name, [
    `Repo: ${selectedSession.repo_id ?? 'unmapped'} | runtime: ${selectedSession.runtime} | mode: ${selectedSession.mode}`,
    `Hex: ${selectedSession.hex_id} | connected ${formatAge(selectedSession.connected_at)} | heartbeat ${formatAge(selectedSession.last_heartbeat)}`,
    selectedSession.managed_status ? `Managed: ${selectedSession.managed_status}${selectedSession.attached ? ' (attached)' : ''}` : 'Managed: remote only',
    selectedSession.local_error ? `Local error: ${selectedSession.local_error}` : 'Local error: none',
    selectedSession.description ? `Description: ${selectedSession.description}` : 'Description: n/a',
  ], rightWidth)

  appendSection(
    rightRows,
    'Capabilities',
    selectedSession.capabilities?.length > 0
      ? [selectedSession.capabilities.join(', ')]
      : ['No capabilities advertised.'],
    rightWidth,
    { maxLines: 6 },
  )

  appendSection(
    rightRows,
    'Inbox For This Agent',
    sessionInbox.length > 0
      ? sessionInbox.slice(0, 5).map(message => `${message.from_session_name}: ${message.question}`)
      : ['No pending requests for this session.'],
    rightWidth,
    { maxLines: 10 },
  )

  appendSection(rightRows, 'Actions', [
    'Press [Enter] to jump to the repo.',
    'Press [r] to launch another runtime for the same repo.',
  ], rightWidth)

  return { leftRows, rightRows }
}

function buildInboxColumns(snapshot, state, leftWidth, rightWidth) {
  const inbox = Array.isArray(snapshot.inbox) ? snapshot.inbox : []
  const selectedMessage = getSelectedInboxMessage(snapshot, state)

  const leftRows = [`Inbox (${inbox.length})`, '']
  if (inbox.length === 0) {
    leftRows.push('No pending inter-agent messages.')
    leftRows.push('Active questions will appear here.')
  } else {
    for (let index = 0; index < inbox.length; index += 1) {
      leftRows.push(renderInboxRow(inbox[index], leftWidth, index === state.selectedInboxIndex))
    }
  }

  const rightRows = []
  if (!selectedMessage) {
    appendSection(rightRows, 'Message', [
      'No pending message selected.',
    ], rightWidth)
    return { leftRows, rightRows }
  }

  appendSection(rightRows, `Message ${selectedMessage.message_id}`, [
    `Repo: ${selectedMessage.repo_id ?? 'unmapped'} | created: ${formatTimestamp(selectedMessage.created_at)} (${formatAge(selectedMessage.created_at)})`,
    `From: ${selectedMessage.from_session_name} (${selectedMessage.from_session_id})`,
    `To: ${selectedMessage.to_session_name} (${selectedMessage.to_session_id})`,
  ], rightWidth)

  appendSection(rightRows, 'Question', [
    selectedMessage.question,
  ], rightWidth, { maxLines: 12 })

  appendSection(rightRows, 'Actions', [
    'Answer from the target agent session.',
    'Press [Enter] to jump back to the owning repo.',
  ], rightWidth)

  return { leftRows, rightRows }
}

function buildKnowledgeColumns(snapshot, state, leftWidth, rightWidth) {
  const notes = Array.isArray(snapshot.knowledge) ? snapshot.knowledge : []
  const selectedNote = getSelectedKnowledgeNote(snapshot, state)

  const leftRows = [`Knowledge (${notes.length})`, '']
  if (notes.length === 0) {
    leftRows.push('No candidate or QA notes found.')
    leftRows.push('New shared learnings will show up here.')
  } else {
    for (let index = 0; index < notes.length; index += 1) {
      leftRows.push(renderKnowledgeRow(notes[index], leftWidth, index === state.selectedKnowledgeIndex))
    }
  }

  const rightRows = []
  if (!selectedNote) {
    appendSection(rightRows, 'Knowledge', [
      'No note selected.',
    ], rightWidth)
    return { leftRows, rightRows }
  }

  appendSection(rightRows, selectedNote.topic, [
    `Repo: ${selectedNote.repo_id ?? 'unmapped'} | status: ${selectedNote.status} | kind: ${selectedNote.kind}`,
    `Author: ${selectedNote.session_name ?? 'unknown'} | updated: ${formatTimestamp(selectedNote.updated_at ?? selectedNote.created_at)}`,
    `Confidence: ${selectedNote.confidence ?? 'n/a'} | freshness: ${selectedNote.freshness ?? 'n/a'} | capability: ${selectedNote.capability ?? 'n/a'}`,
  ], rightWidth)

  appendSection(rightRows, 'Content', [
    selectedNote.content,
  ], rightWidth, { maxLines: 14 })

  appendSection(
    rightRows,
    'Tags',
    selectedNote.tags?.length > 0 ? [selectedNote.tags.join(', ')] : ['No tags'],
    rightWidth,
  )

  appendSection(
    rightRows,
    'Sources',
    selectedNote.source_refs?.length > 0
      ? selectedNote.source_refs.map(source => `${source.path}${source.note ? ` — ${source.note}` : ''}`)
      : ['No source refs attached.'],
    rightWidth,
    { maxLines: 6 },
  )

  return { leftRows, rightRows }
}

function buildColumns(snapshot, state, leftWidth, rightWidth) {
  if (state.view === 'sessions') return buildSessionsColumns(snapshot, state, leftWidth, rightWidth)
  if (state.view === 'inbox') return buildInboxColumns(snapshot, state, leftWidth, rightWidth)
  if (state.view === 'knowledge') return buildKnowledgeColumns(snapshot, state, leftWidth, rightWidth)
  return buildOverviewColumns(snapshot, state, leftWidth, rightWidth)
}

function selectedLineForView(snapshot, state) {
  if (state.view === 'sessions') return 2 + clampIndex(state.selectedSessionIndex, snapshot.sessions)
  if (state.view === 'inbox') return 2 + clampIndex(state.selectedInboxIndex, snapshot.inbox)
  if (state.view === 'knowledge') return 2 + clampIndex(state.selectedKnowledgeIndex, snapshot.knowledge)
  return 2 + clampIndex(state.selectedRepoIndex, snapshot.repos)
}

function renderControlCenter({ width, height, snapshot, state, footerMessage }) {
  const usableWidth = Math.max(width, MIN_WIDTH)
  const usableHeight = Math.max(height, MIN_HEIGHT)
  const leftWidth = Math.max(30, Math.floor(usableWidth * 0.38))
  const rightWidth = usableWidth - leftWidth - 3

  const remoteRow = snapshot.auth.status === 'connected'
    ? `Remote: connected${snapshot.auth.email ? ` as ${snapshot.auth.email}` : ''}  sessions: ${snapshot.counts.active_sessions}  managed: ${snapshot.counts.managed_sessions ?? 0}  inbox: ${snapshot.counts.pending_messages}  knowledge: ${snapshot.counts.knowledge_notes}  refreshed: ${formatClock(snapshot.refreshed_at)}`
    : `Remote: ${snapshot.auth.status}${snapshot.auth.error ? `  ${snapshot.auth.error}` : ''}  refreshed: ${formatClock(snapshot.refreshed_at)}`

  const headerRows = [
    truncate(
      `HEXGRID CONTROL CENTER  workspace: ${snapshot.workspace_name}  repos: ${snapshot.repos.length}  active: ${snapshot.counts.active}  blocked: ${snapshot.counts.blocked}  attention: ${snapshot.counts.attention}`,
      usableWidth,
    ),
    truncate(remoteRow, usableWidth),
    renderTabs(state.view, usableWidth),
  ]

  const { leftRows, rightRows } = buildColumns(snapshot, state, leftWidth, rightWidth)
  const bodyHeight = usableHeight - headerRows.length - 3
  const rowCount = Math.max(bodyHeight, 1)
  const visibleLeftRows = windowRows(leftRows, rowCount, selectedLineForView(snapshot, state))
  const lines = [
    ...headerRows,
    line(usableWidth),
  ]

  for (let index = 0; index < rowCount; index += 1) {
    const left = visibleLeftRows[index] ?? ''
    const right = rightRows[index] ?? ''
    lines.push(`${pad(truncate(left, leftWidth), leftWidth)} | ${pad(truncate(right, rightWidth), rightWidth)}`)
  }

  const defaultFooter = '[o/s/i/n] view  [j/k] move  [Enter] focus repo  [r] start  [a] attach  [x] stop  [u] refresh  [q] quit'
  lines.push(line(usableWidth))
  lines.push(truncate(footerMessage || defaultFooter, usableWidth))

  return lines.slice(0, usableHeight).join('\n')
}

export async function runWorkspaceTui({ loadSnapshot, startRepo, attachRepo, stopRepo }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The TUI requires an interactive terminal.')
  }

  emitKeypressEvents(process.stdin)

  const state = {
    view: 'overview',
    mode: 'normal',
    selectedRepoIndex: 0,
    selectedSessionIndex: 0,
    selectedInboxIndex: 0,
    selectedKnowledgeIndex: 0,
  }

  let snapshot = await loadSnapshot()
  let footerMessage = null
  let refreshBusy = false
  let closed = false
  let resolveExit = null

  const clampSelections = () => {
    state.selectedRepoIndex = clampIndex(state.selectedRepoIndex, snapshot.repos)
    state.selectedSessionIndex = clampIndex(state.selectedSessionIndex, snapshot.sessions)
    state.selectedInboxIndex = clampIndex(state.selectedInboxIndex, snapshot.inbox)
    state.selectedKnowledgeIndex = clampIndex(state.selectedKnowledgeIndex, snapshot.knowledge)
  }

  const render = () => {
    if (closed || state.mode === 'attached') return
    clampSelections()
    process.stdout.write('\x1b[H\x1b[2J')
    process.stdout.write(renderControlCenter({
      width: process.stdout.columns ?? MIN_WIDTH,
      height: process.stdout.rows ?? MIN_HEIGHT,
      snapshot,
      state,
      footerMessage,
    }))
  }

  const refresh = async (message = null) => {
    if (refreshBusy) return
    refreshBusy = true
    try {
      snapshot = await loadSnapshot()
      footerMessage = message
      render()
    } finally {
      refreshBusy = false
    }
  }

  const enterUi = () => {
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    process.stdin.resume()
    process.stdin.setRawMode(true)
  }

  const exitUi = () => {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }

  const runManagedSession = async (repoId, runtime) => {
    try {
      await startRepo(repoId, runtime)
      footerMessage = `Started ${repoId} (${runtime}).`
      await refresh(footerMessage)
      await attachManagedSession(repoId)
    } catch (err) {
      footerMessage = err instanceof Error ? err.message : String(err)
      render()
    }
  }

  const attachManagedSession = async (repoId) => {
    state.mode = 'attached'
    exitUi()
    try {
      const result = await attachRepo(repoId)
      footerMessage = result?.reason === 'exited'
        ? `Session ${repoId} exited while attached.`
        : `Detached from ${repoId}.`
    } catch (err) {
      footerMessage = err instanceof Error ? err.message : String(err)
    } finally {
      state.mode = 'normal'
      enterUi()
      await refresh(footerMessage)
    }
  }

  const currentRepoId = () => {
    if (state.view === 'sessions') return getSelectedSession(snapshot, state)?.repo_id ?? null
    if (state.view === 'inbox') return getSelectedInboxMessage(snapshot, state)?.repo_id ?? null
    if (state.view === 'knowledge') return getSelectedKnowledgeNote(snapshot, state)?.repo_id ?? null
    return getSelectedRepo(snapshot, state)?.repo_id ?? null
  }

  const cycleView = (direction) => {
    const currentIndex = VIEW_ORDER.indexOf(state.view)
    const nextIndex = (currentIndex + direction + VIEW_ORDER.length) % VIEW_ORDER.length
    state.view = VIEW_ORDER[nextIndex]
    footerMessage = null
    render()
  }

  const moveSelection = (direction) => {
    if (state.view === 'sessions') {
      state.selectedSessionIndex += direction
    } else if (state.view === 'inbox') {
      state.selectedInboxIndex += direction
    } else if (state.view === 'knowledge') {
      state.selectedKnowledgeIndex += direction
    } else {
      state.selectedRepoIndex += direction
    }
    footerMessage = null
    render()
  }

  const finish = () => {
    if (!closed) cleanup()
    if (resolveExit) {
      const resolve = resolveExit
      resolveExit = null
      resolve()
    }
  }

  const onKeypress = async (_, key = {}) => {
    if (closed) return
    if (state.mode === 'attached') return

    if (key.ctrl && key.name === 'c') {
      finish()
      return
    }

    if (state.mode === 'run-picker') {
      if (key.name === 'escape') {
        state.mode = 'normal'
        footerMessage = 'Run cancelled.'
        render()
        return
      }

      const repoId = currentRepoId()
      if (!repoId) {
        state.mode = 'normal'
        footerMessage = 'No repo available for that action.'
        render()
        return
      }

      if (key.name === 'c') {
        state.mode = 'normal'
        await runManagedSession(repoId, 'codex')
        return
      }

      if (key.name === 'l') {
        state.mode = 'normal'
        await runManagedSession(repoId, 'claude')
        return
      }

      return
    }

    if (key.name === 'q') {
      finish()
      return
    }

    if (key.name === 'down' || key.name === 'j') {
      moveSelection(1)
      return
    }

    if (key.name === 'up' || key.name === 'k') {
      moveSelection(-1)
      return
    }

    if (key.name === 'right' || key.name === 'l') {
      cycleView(1)
      return
    }

    if (key.name === 'left' || key.name === 'h') {
      cycleView(-1)
      return
    }

    if (key.name === 'tab') {
      cycleView(1)
      return
    }

    if (key.name === 'u') {
      try {
        await refresh('Workspace refreshed.')
      } catch (err) {
        footerMessage = err instanceof Error ? err.message : String(err)
        render()
      }
      return
    }

    if (key.name === 'o') {
      state.view = 'overview'
      footerMessage = null
      render()
      return
    }

    if (key.name === 's') {
      state.view = 'sessions'
      footerMessage = null
      render()
      return
    }

    if (key.name === 'i') {
      state.view = 'inbox'
      footerMessage = null
      render()
      return
    }

    if (key.name === 'n') {
      state.view = 'knowledge'
      footerMessage = null
      render()
      return
    }

    if (key.name === 'return' || key.name === 'enter') {
      const repoId = currentRepoId()
      if (repoId && focusRepo(state, snapshot, repoId)) {
        footerMessage = `Focused repo ${repoId}.`
        render()
      }
      return
    }

    if (key.name === 'r' && currentRepoId()) {
      state.mode = 'run-picker'
      footerMessage = `Start ${currentRepoId()}: [c] codex  [l] claude  [Esc] cancel`
      render()
      return
    }

    if (key.name === 'a' && currentRepoId()) {
      await attachManagedSession(currentRepoId())
      return
    }

    if (key.name === 'x' && currentRepoId()) {
      const repoId = currentRepoId()
      try {
        await stopRepo(repoId)
        await refresh(`Stopping ${repoId}...`)
      } catch (err) {
        footerMessage = err instanceof Error ? err.message : String(err)
        render()
      }
      return
    }
  }

  const onResize = () => render()

  const interval = setInterval(() => {
    refresh().catch(err => {
      footerMessage = err instanceof Error ? err.message : String(err)
      render()
    })
  }, REFRESH_INTERVAL_MS)

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(interval)
    process.stdout.off('resize', onResize)
    process.stdin.off('keypress', onKeypress)
    exitUi()
  }

  process.stdout.on('resize', onResize)
  process.stdin.on('keypress', onKeypress)

  enterUi()
  render()

  return new Promise(resolve => {
    resolveExit = resolve
    process.stdin.once('end', finish)
    process.stdin.once('close', finish)
  })
}
