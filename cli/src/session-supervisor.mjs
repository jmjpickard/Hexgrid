import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const PREVIEW_BUFFER_LIMIT = 200
const STOP_GRACE_MS = 3_000
const FORCE_KILL_MS = 6_000
const DETACH_BYTE = 0x1d

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function appendOutput(session, chunk) {
  const text = String(chunk ?? '')
  if (!text) return

  const next = `${session.partial_output}${text}`
  const lines = next.replace(/\r/g, '').split('\n')
  session.partial_output = lines.pop() ?? ''

  for (const line of lines) {
    session.buffer.push(line)
  }

  if (session.buffer.length > PREVIEW_BUFFER_LIMIT) {
    session.buffer.splice(0, session.buffer.length - PREVIEW_BUFFER_LIMIT)
  }
}

function toPublicSession(session) {
  const preview = session.partial_output
    ? [...session.buffer.slice(-(PREVIEW_BUFFER_LIMIT - 1)), session.partial_output]
    : session.buffer.slice(-PREVIEW_BUFFER_LIMIT)

  return {
    repo_id: session.repo_id,
    runtime: session.runtime,
    status: session.status,
    attached: session.attached,
    pid: session.pid,
    started_at: session.started_at,
    exited_at: session.exited_at,
    exit_code: session.exit_code,
    last_output_at: session.last_output_at,
    error: session.error,
    session_id: session.session_id,
    hex_id: session.hex_id,
    name: session.name,
    buffer_preview: preview.slice(-20),
  }
}

export function createSessionSupervisor({ prepareLaunch }) {
  const sessions = new Map()
  const listeners = new Set()
  let attachedContext = null

  const emit = (event) => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Best-effort event fanout.
      }
    }
  }

  const detachInternal = ({ reason = 'detached', writeNotice = true } = {}) => {
    if (!attachedContext) return null

    const context = attachedContext
    attachedContext = null

    context.session.attached = false
    context.stdin.off('data', context.onInput)
    context.stdout.off('resize', context.onResize)

    try {
      if (context.stdin.isTTY) context.stdin.setRawMode(false)
    } catch {
      // Ignore TTY reset failures on detach.
    }

    context.stdin.pause()
    context.stdout.write('\x1b]0;HEXGRID CONTROL CENTER\x07')

    if (writeNotice) {
      context.stdout.write(`\r\n[hexgrid] Detached from ${context.session.repo_id}. Control center restored.\r\n`)
    }

    emit({ type: 'detached', repoId: context.session.repo_id, reason })
    context.resolve({ reason })
    return context.session.repo_id
  }

  const finalizeExit = async (session, { exitCode, signal, error = null }) => {
    if (session.finalized) return
    session.finalized = true

    if (session.heartbeat_timer) {
      clearInterval(session.heartbeat_timer)
      session.heartbeat_timer = null
    }

    if (attachedContext?.session?.repo_id === session.repo_id) {
      detachInternal({
        reason: 'exited',
        writeNotice: false,
      })
    }

    session.pid = null
    session.attached = false
    session.exited_at = nowSeconds()
    session.exit_code = typeof exitCode === 'number' ? exitCode : null
    session.last_signal = signal ?? null

    if (error) {
      session.status = 'errored'
      session.error = error
    } else if (session.status === 'stopping') {
      session.status = 'stopped'
    } else if ((exitCode ?? 0) === 0) {
      session.status = 'stopped'
      session.error = null
    } else {
      session.status = 'errored'
      session.error = `Process exited with code ${exitCode ?? 'unknown'}`
    }

    try {
      await session.disconnect()
    } catch (disconnectError) {
      const detail = disconnectError instanceof Error ? disconnectError.message : String(disconnectError)
      session.error = session.error ? `${session.error}; disconnect failed: ${detail}` : `Disconnect failed: ${detail}`
    }

    if (session.resolve_exit) session.resolve_exit(toPublicSession(session))

    emit({
      type: 'session-exited',
      repoId: session.repo_id,
      exitCode: session.exit_code,
      signal: session.last_signal,
    })
  }

  const listSessions = () => Array.from(sessions.values())
    .map(toPublicSession)
    .sort((left, right) => {
      const leftTime = Number(left.last_output_at ?? left.started_at ?? 0)
      const rightTime = Number(right.last_output_at ?? right.started_at ?? 0)
      return rightTime - leftTime
    })

  const getSession = (repoId) => {
    const session = sessions.get(repoId)
    return session ? toPublicSession(session) : null
  }

  const startSession = async (repoId, runtime, terminal = {}) => {
    const existing = sessions.get(repoId)
    if (existing && ['starting', 'running', 'stopping'].includes(existing.status)) {
      return toPublicSession(existing)
    }

    const cols = Number(terminal.cols ?? process.stdout.columns ?? 120)
    const rows = Number(terminal.rows ?? process.stdout.rows ?? 40)
    const launch = await prepareLaunch({ repoId, runtime })
    const session = {
      repo_id: repoId,
      runtime,
      status: 'starting',
      attached: false,
      pid: null,
      started_at: null,
      exited_at: null,
      exit_code: null,
      last_signal: null,
      last_output_at: null,
      error: null,
      buffer: [],
      partial_output: '',
      finalized: false,
      heartbeat_timer: null,
      resolve_exit: null,
      exit_promise: null,
      pty: null,
      session_id: launch.session_id,
      hex_id: launch.hex_id ?? null,
      name: launch.name ?? `${repoId}-${runtime}`,
      disconnect: launch.disconnect,
      heartbeat: launch.heartbeat,
    }

    session.exit_promise = new Promise(resolve => {
      session.resolve_exit = resolve
    })
    sessions.set(repoId, session)
    emit({ type: 'session-starting', repoId, runtime })

    try {
      const ptyProcess = pty.spawn(launch.command, launch.args ?? [], {
        name: process.env.TERM ?? 'xterm-256color',
        cols,
        rows,
        cwd: launch.cwd,
        env: launch.env,
      })

      session.pty = ptyProcess
      session.pid = ptyProcess.pid
      session.started_at = nowSeconds()
      session.status = 'running'

      if (launch.heartbeat_seconds > 0) {
        session.heartbeat_timer = setInterval(async () => {
          try {
            await session.heartbeat()
          } catch (heartbeatError) {
            const detail = heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)
            session.error = `Heartbeat failed: ${detail}`
            emit({ type: 'session-error', repoId, message: session.error })
          }
        }, launch.heartbeat_seconds * 1000)

        if (typeof session.heartbeat_timer.unref === 'function') {
          session.heartbeat_timer.unref()
        }
      }

      ptyProcess.onData((chunk) => {
        session.last_output_at = nowSeconds()
        appendOutput(session, chunk)

        if (attachedContext?.session?.repo_id === repoId) {
          attachedContext.stdout.write(chunk)
        }

        emit({ type: 'session-output', repoId, chunk, at: session.last_output_at })
      })

      ptyProcess.onExit(({ exitCode, signal }) => {
        finalizeExit(session, { exitCode, signal }).catch(() => {})
      })

      emit({ type: 'session-started', repoId, pid: session.pid })
      return toPublicSession(session)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      session.status = 'errored'
      session.error = detail
      session.exited_at = nowSeconds()

      try {
        await session.disconnect()
      } catch {
        // Best-effort disconnect on startup failure.
      }

      emit({ type: 'session-error', repoId, message: detail })
      throw err
    }
  }

  const stopSession = async (repoId) => {
    const session = sessions.get(repoId)
    if (!session || !session.pty || !['starting', 'running', 'stopping'].includes(session.status)) {
      return session ? toPublicSession(session) : null
    }

    session.status = 'stopping'

    try {
      session.pty.kill('SIGINT')
    } catch {
      // Fall through to timeout path.
    }

    const exitResult = await Promise.race([
      session.exit_promise,
      new Promise(resolve => setTimeout(() => resolve(null), STOP_GRACE_MS)),
    ])
    if (exitResult) return exitResult

    try {
      session.pty.kill('SIGTERM')
    } catch {
      // Fall through to force kill.
    }

    const termResult = await Promise.race([
      session.exit_promise,
      new Promise(resolve => setTimeout(() => resolve(null), FORCE_KILL_MS - STOP_GRACE_MS)),
    ])
    if (termResult) return termResult

    try {
      session.pty.kill('SIGKILL')
    } catch {
      // Nothing left to do.
    }

    return session.exit_promise
  }

  const attach = async (repoId, { stdin = process.stdin, stdout = process.stdout } = {}) => {
    const session = sessions.get(repoId)
    if (!session || !session.pty || session.status !== 'running') {
      throw new Error(`Repo "${repoId}" does not have a running managed session.`)
    }

    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error('Attach requires an interactive terminal.')
    }

    if (attachedContext && attachedContext.session.repo_id !== repoId) {
      throw new Error(`Detach from ${attachedContext.session.repo_id} before attaching to ${repoId}.`)
    }

    if (attachedContext?.session?.repo_id === repoId) {
      return attachedContext.promise
    }

    const onResize = () => {
      try {
        session.pty.resize(stdout.columns ?? 120, stdout.rows ?? 40)
      } catch {
        // Ignore resize failures for dead PTYs.
      }
    }

    const onInput = (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buffer.includes(DETACH_BYTE)) {
        detachInternal()
        return
      }
      session.pty.write(buffer.toString('utf8'))
    }

    let resolveAttach = null
    const promise = new Promise((resolve) => {
      resolveAttach = resolve
    })

    attachedContext = {
      session,
      stdin,
      stdout,
      onInput,
      onResize,
      resolve: resolveAttach,
      promise,
    }

    session.attached = true
    stdout.write(`\x1b]0;HEXGRID ATTACHED ${repoId}  Ctrl+] to return\x07`)
    stdout.write('\x1b[2J\x1b[H')
    stdout.write(`[hexgrid] Attached to ${repoId}.\r\n`)
    stdout.write('[hexgrid] Press Ctrl+] to return to the control center.\r\n')
    stdout.write('[hexgrid] The dashboard is paused while this session owns the terminal.\r\n\r\n')
    if (session.buffer.length > 0) {
      stdout.write('[hexgrid] Recent output tail:\r\n')
      stdout.write(`${session.buffer.slice(-20).join('\r\n')}\r\n`)
    }
    stdin.resume()
    stdin.setRawMode(true)
    stdin.on('data', onInput)
    stdout.on('resize', onResize)
    onResize()
    emit({ type: 'attached', repoId })

    return promise
  }

  const detach = async () => {
    const repoId = detachInternal()
    return repoId ? getSession(repoId) : null
  }

  const resize = (cols, rows) => {
    if (!attachedContext?.session?.pty) return
    try {
      attachedContext.session.pty.resize(cols, rows)
    } catch {
      // Ignore resize failures when the process is already exiting.
    }
  }

  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const shutdown = async () => {
    const activeSessions = Array.from(sessions.values())
      .filter(session => ['starting', 'running', 'stopping'].includes(session.status))
    await Promise.all(activeSessions.map(session => stopSession(session.repo_id).catch(() => null)))
  }

  return {
    listSessions,
    getSession,
    startSession,
    stopSession,
    attach,
    detach,
    resize,
    subscribe,
    shutdown,
  }
}
