import process from 'node:process'
import { emitKeypressEvents } from 'node:readline'

const REFRESH_INTERVAL_MS = 10_000
const MIN_WIDTH = 80
const MIN_HEIGHT = 18

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

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function statusGlyph(status) {
  if (status === 'active') return '*'
  if (status === 'blocked') return '!'
  if (status === 'idle') return '.'
  return '?'
}

function renderTwoPane({ width, height, header, repos, selectedIndex, modeLabel, flashMessage }) {
  const usableWidth = Math.max(width, MIN_WIDTH)
  const usableHeight = Math.max(height, MIN_HEIGHT)
  const leftWidth = Math.max(28, Math.floor(usableWidth * 0.42))
  const rightWidth = usableWidth - leftWidth - 3

  const selectedRepo = repos[selectedIndex] ?? null
  const leftRows = []
  const visibleRows = usableHeight - 6
  const startIndex = Math.max(0, selectedIndex - Math.floor(visibleRows / 2))
  const visibleRepos = repos.slice(startIndex, startIndex + visibleRows)

  if (repos.length === 0) {
    leftRows.push(pad('No repos registered yet.', leftWidth))
    leftRows.push(pad('Run `hexgrid repo add <repo_id>` from a repo checkout.', leftWidth))
  } else {
    for (let index = 0; index < visibleRepos.length; index += 1) {
      const repo = visibleRepos[index]
      const absoluteIndex = startIndex + index
      const prefix = absoluteIndex === selectedIndex ? '>' : ' '
      const label = `${prefix} ${statusGlyph(repo.status)} ${repo.repo_id}`
      const meta = repo.default_runtime ? ` ${repo.default_runtime}` : ''
      leftRows.push(pad(truncate(`${label}${meta}`, leftWidth), leftWidth))
    }
  }

  const detailRows = selectedRepo
    ? [
        `Repo: ${selectedRepo.repo_id}`,
        `Status: ${selectedRepo.status}`,
        `Runtime: ${selectedRepo.default_runtime ?? 'n/a'}`,
        `Listen: ${selectedRepo.listen ?? 'manual'}`,
        `Path: ${selectedRepo.path ?? 'not linked'}`,
        `Remote: ${selectedRepo.remote ?? 'n/a'}`,
        `Description: ${selectedRepo.description ?? 'n/a'}`,
        '',
        'Actions:',
        '[r] Run runtime picker',
        '[u] Refresh workspace',
        '[q] Quit',
      ]
    : [
        'No repo selected.',
        '',
        'Actions:',
        '[u] Refresh workspace',
        '[q] Quit',
      ]

  const rightRows = detailRows.map(row => pad(truncate(row, rightWidth), rightWidth))
  const rowCount = Math.max(leftRows.length, rightRows.length, usableHeight - 4)

  const lines = [
    truncate(header, usableWidth),
    line(usableWidth),
  ]

  for (let index = 0; index < rowCount; index += 1) {
    const left = leftRows[index] ?? ' '.repeat(leftWidth)
    const right = rightRows[index] ?? ' '.repeat(rightWidth)
    lines.push(`${left} | ${right}`)
  }

  lines.push(line(usableWidth))
  lines.push(truncate(modeLabel || flashMessage || '[j/k] move  [r] run  [u] refresh  [q] quit', usableWidth))

  return lines.slice(0, usableHeight).join('\n')
}

export async function runWorkspaceTui({ loadSnapshot, runRepo }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The TUI requires an interactive terminal.')
  }

  emitKeypressEvents(process.stdin)

  let selectedIndex = 0
  let snapshot = await loadSnapshot()
  let flashMessage = null
  let mode = 'normal'
  let closed = false
  let resolveExit = null

  const clampSelectedIndex = () => {
    if (snapshot.repos.length === 0) {
      selectedIndex = 0
      return
    }
    selectedIndex = Math.max(0, Math.min(selectedIndex, snapshot.repos.length - 1))
  }

  const render = () => {
    if (closed) return
    clampSelectedIndex()

    const header = `HEXGRID  workspace: ${snapshot.workspace_name}  repos: ${snapshot.repos.length}  active: ${snapshot.counts.active}  blocked: ${snapshot.counts.blocked}  refreshed: ${formatTime(snapshot.refreshed_at)}`
    const modeLabel = mode === 'run-picker'
      ? 'Run selected repo: press [c] for codex, [l] for claude, [Esc] to cancel'
      : null

    process.stdout.write('\x1b[H\x1b[2J')
    process.stdout.write(renderTwoPane({
      width: process.stdout.columns ?? MIN_WIDTH,
      height: process.stdout.rows ?? MIN_HEIGHT,
      header,
      repos: snapshot.repos,
      selectedIndex,
      modeLabel,
      flashMessage,
    }))
  }

  const refresh = async (message = null) => {
    snapshot = await loadSnapshot()
    flashMessage = message
    render()
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

  const suspendForAction = async (action) => {
    exitUi()
    try {
      await action()
      flashMessage = 'Action completed.'
    } catch (err) {
      flashMessage = err instanceof Error ? err.message : String(err)
    } finally {
      enterUi()
      await refresh(flashMessage)
    }
  }

  const selectedRepo = () => snapshot.repos[selectedIndex] ?? null

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

    if (key.ctrl && key.name === 'c') {
      finish()
      return
    }

    if (mode === 'run-picker') {
      if (key.name === 'escape') {
        mode = 'normal'
        flashMessage = 'Run cancelled.'
        render()
        return
      }

      const repo = selectedRepo()
      if (!repo) {
        mode = 'normal'
        render()
        return
      }

      if (key.name === 'c') {
        mode = 'normal'
        await suspendForAction(() => runRepo(repo.repo_id, 'codex'))
        return
      }

      if (key.name === 'l') {
        mode = 'normal'
        await suspendForAction(() => runRepo(repo.repo_id, 'claude'))
        return
      }

      return
    }

    if (key.name === 'q') {
      finish()
      return
    }

    if (key.name === 'down' || key.name === 'j') {
      selectedIndex = Math.min(selectedIndex + 1, Math.max(0, snapshot.repos.length - 1))
      render()
      return
    }

    if (key.name === 'up' || key.name === 'k') {
      selectedIndex = Math.max(selectedIndex - 1, 0)
      render()
      return
    }

    if (key.name === 'u') {
      try {
        await refresh('Workspace refreshed.')
      } catch (err) {
        flashMessage = err instanceof Error ? err.message : String(err)
        render()
      }
      return
    }

    if (key.name === 'r' && selectedRepo()) {
      mode = 'run-picker'
      render()
    }
  }

  const onResize = () => render()

  const interval = setInterval(() => {
    refresh().catch(err => {
      flashMessage = err instanceof Error ? err.message : String(err)
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
