import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.join(SRC_ROOT, 'ui')
const XTERM_JS_PATH = path.join(SRC_ROOT, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')
const XTERM_CSS_PATH = path.join(SRC_ROOT, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')
const XTERM_FIT_PATH = path.join(SRC_ROOT, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')

const STATIC_ASSETS = new Map([
  ['/', { path: path.join(UI_ROOT, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/app.js', { path: path.join(UI_ROOT, 'app.js'), type: 'application/javascript; charset=utf-8' }],
  ['/styles.css', { path: path.join(UI_ROOT, 'styles.css'), type: 'text/css; charset=utf-8' }],
  ['/vendor/xterm.js', { path: XTERM_JS_PATH, type: 'application/javascript; charset=utf-8' }],
  ['/vendor/xterm.css', { path: XTERM_CSS_PATH, type: 'text/css; charset=utf-8' }],
  ['/vendor/addon-fit.js', { path: XTERM_FIT_PATH, type: 'application/javascript; charset=utf-8' }],
])

const staticCache = new Map()

function encodeSseData(payload) {
  return JSON.stringify(payload).split('\n').map(line => `data: ${line}`).join('\n')
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`)
  res.write(`${encodeSseData(payload)}\n\n`)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readStaticAsset(filePath) {
  if (!staticCache.has(filePath)) {
    staticCache.set(filePath, readFile(filePath))
  }
  return staticCache.get(filePath)
}

async function parseJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function createEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 15_000)

  return () => clearInterval(heartbeat)
}

export async function startLocalUiServer({
  port = 4681,
  host = '127.0.0.1',
  loadSnapshot,
  startRepo,
  stopRepo,
  supervisor,
}) {
  const authToken = crypto.randomUUID().replace(/-/g, '')
  const stateClients = new Set()
  const terminalClients = new Map()
  let closed = false
  let resolveClosed = null
  const closedPromise = new Promise(resolve => {
    resolveClosed = resolve
  })

  const isAuthorised = (url) => url.searchParams.get('token') === authToken

  const addTerminalClient = (repoId, client) => {
    const clients = terminalClients.get(repoId) ?? new Set()
    clients.add(client)
    terminalClients.set(repoId, clients)
  }

  const removeTerminalClient = (repoId, client) => {
    const clients = terminalClients.get(repoId)
    if (!clients) return
    clients.delete(client)
    if (clients.size === 0) terminalClients.delete(repoId)
  }

  const broadcastState = (event) => {
    for (const client of stateClients) {
      sendSse(client, 'state', event)
    }
  }

  const broadcastTerminal = (repoId, event, payload) => {
    const clients = terminalClients.get(repoId)
    if (!clients) return
    for (const client of clients) {
      sendSse(client, event, payload)
    }
  }

  const unsubscribe = supervisor.subscribe((event) => {
    if (event.type === 'session-output') {
      broadcastTerminal(event.repoId, 'output', {
        repo_id: event.repoId,
        chunk: event.chunk,
        at: event.at,
      })
      return
    }

    if (event.type === 'session-starting' || event.type === 'session-started') {
      broadcastTerminal(event.repoId, 'reset', { repo_id: event.repoId })
    }

    if (event.repoId) {
      const session = supervisor.getSession(event.repoId)
      broadcastTerminal(event.repoId, 'status', {
        repo_id: event.repoId,
        session,
        message: event.message ?? null,
      })
    }

    broadcastState({
      type: event.type,
      repo_id: event.repoId ?? null,
      message: event.message ?? null,
      at: Date.now(),
    })
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
    const pathname = url.pathname

    try {
      if (pathname === '/favicon.ico') {
        res.writeHead(204)
        res.end()
        return
      }

      const staticAsset = STATIC_ASSETS.get(pathname)
      if (staticAsset && req.method === 'GET') {
        const body = await readStaticAsset(staticAsset.path)
        res.writeHead(200, {
          'Content-Type': staticAsset.type,
          'Content-Length': body.byteLength,
          'Cache-Control': 'no-store',
        })
        res.end(body)
        return
      }

      if (pathname.startsWith('/api/') && !isAuthorised(url)) {
        sendJson(res, 401, { error: 'Unauthorised local UI request.' })
        return
      }

      if (pathname === '/api/snapshot' && req.method === 'GET') {
        const snapshot = await loadSnapshot()
        sendJson(res, 200, snapshot)
        return
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        const clearHeartbeat = createEventStream(res)
        stateClients.add(res)
        sendSse(res, 'ready', { ok: true, at: Date.now() })
        req.on('close', () => {
          clearHeartbeat()
          stateClients.delete(res)
        })
        return
      }

      let match = pathname.match(/^\/api\/repos\/([^/]+)\/(start|stop)$/)
      if (match && req.method === 'POST') {
        const repoId = decodeURIComponent(match[1])
        const action = match[2]

        if (action === 'start') {
          const body = await parseJsonBody(req)
          const session = await startRepo(repoId, body.runtime ?? null)
          sendJson(res, 200, { ok: true, session })
          return
        }

        const session = await stopRepo(repoId)
        sendJson(res, 200, { ok: true, session })
        return
      }

      match = pathname.match(/^\/api\/repos\/([^/]+)\/terminal\/(stream|input|resize)$/)
      if (match) {
        const repoId = decodeURIComponent(match[1])
        const action = match[2]

        if (action === 'stream' && req.method === 'GET') {
          const clearHeartbeat = createEventStream(res)
          addTerminalClient(repoId, res)

          const session = supervisor.getSession(repoId)
          sendSse(res, 'status', {
            repo_id: repoId,
            session,
            message: null,
          })

          const replay = supervisor.getRawOutput(repoId)
          if (replay) {
            sendSse(res, 'reset', { repo_id: repoId })
            sendSse(res, 'output', {
              repo_id: repoId,
              chunk: replay,
              replay: true,
            })
          }

          req.on('close', () => {
            clearHeartbeat()
            removeTerminalClient(repoId, res)
          })
          return
        }

        if (action === 'input' && req.method === 'POST') {
          const body = await parseJsonBody(req)
          const session = supervisor.writeInput(repoId, body.data ?? '')
          sendJson(res, 200, { ok: true, session })
          return
        }

        if (action === 'resize' && req.method === 'POST') {
          const body = await parseJsonBody(req)
          const session = supervisor.resizeSession(repoId, body.cols, body.rows)
          sendJson(res, 200, { ok: true, session })
          return
        }
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: detail })
    }
  })

  server.on('close', () => {
    if (closed) return
    closed = true
    unsubscribe()
    for (const client of stateClients) {
      client.end()
    }
    stateClients.clear()

    for (const clients of terminalClients.values()) {
      for (const client of clients) {
        client.end()
      }
    }
    terminalClients.clear()
    resolveClosed?.()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const origin = `http://${host}:${actualPort}`

  return {
    origin,
    auth_url: `${origin}/?token=${encodeURIComponent(authToken)}`,
    async close() {
      if (closed) return
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
    waitUntilClosed() {
      return closedPromise
    },
  }
}
