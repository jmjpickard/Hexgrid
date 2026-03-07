#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_API_URL = process.env.HEXGRID_API_URL ?? 'https://api.hexgrid.app'
const CONFIG_PATH = path.join(os.homedir(), '.config', 'hexgrid', 'config.json')
const TOOL_CANDIDATES = ['git', 'rg', 'npm', 'pnpm', 'bun', 'yarn', 'docker', 'pytest', 'go', 'cargo', 'node', 'python3']

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadConfig() {
  if (!(await fileExists(CONFIG_PATH))) return {}
  const raw = await readFile(CONFIG_PATH, 'utf8')
  return JSON.parse(raw)
}

async function saveConfig(config) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function usage() {
  console.log(`HexGrid CLI

Usage:
  hexgrid login [--api-url URL] [--no-open] [--client-name NAME]
  hexgrid connect [--runtime RUNTIME] [--name NAME] [--description TEXT]
  hexgrid heartbeat [SESSION_ID]
  hexgrid disconnect [SESSION_ID]
  hexgrid me
  hexgrid logout
`)
}

function parseFlag(args, name, fallback = null) {
  const idx = args.indexOf(name)
  if (idx === -1) return fallback
  return args[idx + 1] ?? fallback
}

function hasFlag(args, name) {
  return args.includes(name)
}

async function requestJson(apiUrl, endpoint, options = {}) {
  const { method = 'GET', body, token } = options
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(`${apiUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  return { response, data }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function openBrowser(url) {
  let cmd = null
  let args = []

  if (process.platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (process.platform === 'linux') {
    cmd = 'xdg-open'
    args = [url]
  } else {
    return false
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' })
  return result.status === 0
}

async function detectRepoContext() {
  const repoRoot = runGit(['rev-parse', '--show-toplevel']) ?? process.cwd()
  const repoName = path.basename(repoRoot)
  const repoUrl = runGit(['remote', 'get-url', 'origin']) ?? `local://${repoRoot}`
  const repoType = await detectRepoType(repoRoot)
  const tools = TOOL_CANDIDATES.filter(commandExists)

  return { repoRoot, repoName, repoUrl, repoType, tools }
}

async function detectRepoType(repoRoot) {
  const frontendMarkers = ['next.config.js', 'next.config.ts', 'vite.config.js', 'vite.config.ts']
  const backendMarkers = ['pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Dockerfile']

  const hasFrontend = (await Promise.all(frontendMarkers.map(marker => fileExists(path.join(repoRoot, marker))))).some(Boolean)
  const hasBackend = (await Promise.all(backendMarkers.map(marker => fileExists(path.join(repoRoot, marker))))).some(Boolean)

  if (hasFrontend && hasBackend) return 'fullstack'
  if (hasFrontend) return 'frontend'
  if (hasBackend) return 'backend'
  return 'fullstack'
}

function resolveApiUrl(args, config) {
  return parseFlag(args, '--api-url', null) ?? config.api_url ?? DEFAULT_API_URL
}

function resolveToken(config) {
  return process.env.HEXGRID_TOKEN ?? config.access_token ?? null
}

async function commandLogin(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const clientName = parseFlag(args, '--client-name', `hexgrid-cli@${os.hostname()}`)
  const shouldOpen = !hasFlag(args, '--no-open')

  const start = await requestJson(apiUrl, '/auth/device/start', {
    method: 'POST',
    body: { client_name: clientName },
  })

  if (!start.response.ok) {
    throw new Error(start.data.error ?? `Failed to start login (${start.response.status})`)
  }

  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    interval_seconds: intervalSeconds,
    expires_in_seconds: expiresInSeconds,
  } = start.data

  console.log(`Open this URL to approve login:\n${verificationUriComplete ?? verificationUri}\n`)
  console.log(`Device code: ${userCode}`)

  if (shouldOpen) {
    const opened = openBrowser(verificationUriComplete ?? verificationUri)
    if (opened) console.log('Opened browser for approval.')
  }

  const startedAt = Date.now()
  const deadline = startedAt + Number(expiresInSeconds ?? 600) * 1000
  const intervalMs = Math.max(1000, Number(intervalSeconds ?? 3) * 1000)

  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const poll = await requestJson(apiUrl, '/auth/device/poll', {
      method: 'POST',
      body: { device_code: deviceCode },
    })

    if (poll.response.ok && poll.data.access_token) {
      const next = {
        ...config,
        api_url: apiUrl,
        access_token: poll.data.access_token,
        access_token_expires_at: Math.floor(Date.now() / 1000) + Number(poll.data.expires_in_seconds ?? 0),
      }

      const me = await requestJson(apiUrl, '/api/cli/me', {
        method: 'GET',
        token: poll.data.access_token,
      })
      if (me.response.ok) {
        next.user_id = me.data.user_id
        next.email = me.data.email
      }

      await saveConfig(next)
      console.log(`Login successful${next.email ? ` for ${next.email}` : ''}.`)
      return
    }

    if (poll.response.ok && poll.data.status === 'pending') {
      process.stdout.write('.')
      continue
    }

    throw new Error(poll.data.error ?? `Device login failed (${poll.response.status})`)
  }

  throw new Error('Device login timed out. Run `hexgrid login` again.')
}

function sessionKey(repoRoot) {
  return path.resolve(repoRoot)
}

async function commandConnect(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const runtime = parseFlag(args, '--runtime', 'cli')
  const context = await detectRepoContext()
  const name = parseFlag(args, '--name', `${context.repoName}-${runtime}`)
  const description = parseFlag(
    args,
    '--description',
    `${runtime} session for ${context.repoName} (${context.repoType})`,
  )

  const capabilities = [
    `repo:${context.repoName}`,
    `surface:${context.repoType}`,
    `runtime:${runtime}`,
    ...context.tools.map(tool => `tool:${tool}`),
  ]

  const connect = await requestJson(apiUrl, '/api/cli/connect', {
    method: 'POST',
    token,
    body: {
      name,
      repo_url: context.repoUrl,
      description,
      capabilities: Array.from(new Set(capabilities)),
    },
  })

  if (!connect.response.ok) {
    throw new Error(connect.data.error ?? `Connect failed (${connect.response.status})`)
  }

  const sessions = config.sessions ?? {}
  sessions[sessionKey(context.repoRoot)] = {
    session_id: connect.data.session_id,
    repo_root: context.repoRoot,
    repo_url: context.repoUrl,
    runtime,
    name,
    connected_at: Math.floor(Date.now() / 1000),
  }

  await saveConfig({
    ...config,
    api_url: apiUrl,
    sessions,
    last_session_id: connect.data.session_id,
  })

  console.log(JSON.stringify({
    session_id: connect.data.session_id,
    hex_id: connect.data.hex_id,
    active_sessions: connect.data.active_sessions?.length ?? 0,
    repo: context.repoName,
    runtime,
  }, null, 2))
}

async function resolveSessionId(config, args) {
  const positional = args.find(arg => !arg.startsWith('-'))
  if (positional) return positional

  const context = await detectRepoContext()
  const byRepo = config.sessions?.[sessionKey(context.repoRoot)]?.session_id
  return byRepo ?? config.last_session_id ?? null
}

async function commandHeartbeat(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const sessionId = await resolveSessionId(config, args)
  if (!sessionId) throw new Error('No session_id found. Pass one explicitly or run connect in this repo.')

  const heartbeat = await requestJson(apiUrl, '/api/cli/heartbeat', {
    method: 'POST',
    token,
    body: { session_id: sessionId },
  })

  if (!heartbeat.response.ok) {
    throw new Error(heartbeat.data.error ?? `Heartbeat failed (${heartbeat.response.status})`)
  }

  console.log(JSON.stringify(heartbeat.data, null, 2))
}

async function commandDisconnect(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const sessionId = await resolveSessionId(config, args)
  if (!sessionId) throw new Error('No session_id found. Pass one explicitly or run connect in this repo.')

  const disconnect = await requestJson(apiUrl, '/api/cli/disconnect', {
    method: 'POST',
    token,
    body: { session_id: sessionId },
  })

  if (!disconnect.response.ok) {
    throw new Error(disconnect.data.error ?? `Disconnect failed (${disconnect.response.status})`)
  }

  const context = await detectRepoContext()
  const sessions = { ...(config.sessions ?? {}) }
  const key = sessionKey(context.repoRoot)
  if (sessions[key]?.session_id === sessionId) delete sessions[key]

  await saveConfig({
    ...config,
    sessions,
    last_session_id: config.last_session_id === sessionId ? null : config.last_session_id,
  })

  console.log(JSON.stringify(disconnect.data, null, 2))
}

async function commandMe(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const me = await requestJson(apiUrl, '/api/cli/me', {
    method: 'GET',
    token,
  })

  if (!me.response.ok) {
    throw new Error(me.data.error ?? `Failed to fetch profile (${me.response.status})`)
  }

  console.log(JSON.stringify(me.data, null, 2))
}

async function commandLogout(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)

  if (token) {
    await requestJson(apiUrl, '/api/cli/logout', {
      method: 'POST',
      token,
    })
  }

  const next = {
    ...config,
    access_token: null,
    access_token_expires_at: null,
    user_id: null,
    email: null,
  }
  await saveConfig(next)
  console.log('Logged out.')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  if (command === 'login') {
    await commandLogin(args)
    return
  }
  if (command === 'connect') {
    await commandConnect(args)
    return
  }
  if (command === 'heartbeat') {
    await commandHeartbeat(args)
    return
  }
  if (command === 'disconnect') {
    await commandDisconnect(args)
    return
  }
  if (command === 'me') {
    await commandMe(args)
    return
  }
  if (command === 'logout') {
    await commandLogout(args)
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Error: ${message}`)
  process.exit(1)
})
