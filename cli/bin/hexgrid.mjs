#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_API_URL = process.env.HEXGRID_API_URL ?? 'https://api.hexgrid.app'
const CONFIG_PATH = path.join(os.homedir(), '.config', 'hexgrid', 'config.json')
const TOOL_CANDIDATES = ['git', 'rg', 'npm', 'pnpm', 'bun', 'yarn', 'docker', 'pytest', 'go', 'cargo', 'node', 'python3']
const CLI_PACKAGE_NAME = '@jackpickard/hexgrid-cli'
const DEFAULT_HEARTBEAT_SECONDS = 300
const HEXGRID_CODEX_BLOCK_START = '# BEGIN HEXGRID MCP (managed by hexgrid)'
const HEXGRID_CODEX_BLOCK_END = '# END HEXGRID MCP (managed by hexgrid)'

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
  hexgrid setup [all|codex|claude] [--mcp]
  hexgrid doctor [all|codex|claude] [--fix]
  hexgrid connect [--runtime RUNTIME] [--name NAME] [--description TEXT]
  hexgrid run <codex|claude> [--name NAME] [--description TEXT] [--heartbeat-seconds N] [-- ...agent args]
  hexgrid heartbeat [SESSION_ID]
  hexgrid disconnect [SESSION_ID]
  hexgrid sessions
  hexgrid ask --capability CAP --question TEXT [--context TEXT] [--session SESSION_ID]
  hexgrid ask --to TARGET --question TEXT [--session SESSION_ID]
  hexgrid listen [--capability CAP] [--name NAME] [--poll-seconds N]
  hexgrid inbox [SESSION_ID]
  hexgrid reply --message MESSAGE_ID --answer TEXT [--session SESSION_ID]
  hexgrid response MESSAGE_ID
  hexgrid me
  hexgrid logout
  hexgrid update
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

function firstPositional(args) {
  return args.find(arg => !arg.startsWith('-')) ?? null
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function splitPassthroughArgs(args) {
  const idx = args.indexOf('--')
  if (idx === -1) return { primary: args, passthrough: [] }
  return {
    primary: args.slice(0, idx),
    passthrough: args.slice(idx + 1),
  }
}

function mcpUrlFromApiUrl(apiUrl) {
  return `${apiUrl.replace(/\/+$/, '')}/mcp`
}

function parseRuntime(input, { allowAll = false, fallback = null } = {}) {
  if (!input) return fallback
  const value = input.trim().toLowerCase()
  if (value === 'codex' || value === 'claude') return value
  if (allowAll && value === 'all') return value
  throw new Error(`Unsupported runtime "${input}". Use codex${allowAll ? ', claude, all' : ' or claude'}.`)
}

function parseRuntimes(primaryArgs, fallback = 'all') {
  const runtimeValue = parseRuntime(firstPositional(primaryArgs), { allowAll: true, fallback })
  if (runtimeValue === 'all') return ['codex', 'claude']
  return [runtimeValue]
}

function parsePositiveInt(input, fallback) {
  if (input == null) return fallback
  const value = Number.parseInt(String(input), 10)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

function renderCodexHexgridBlock(mcpUrl) {
  return [
    HEXGRID_CODEX_BLOCK_START,
    '[mcp_servers.hexgrid]',
    `url = "${mcpUrl}"`,
    'bearer_token_env_var = "HEXGRID_API_KEY"',
    HEXGRID_CODEX_BLOCK_END,
  ].join('\n')
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

function readJsonMaybe(filePath) {
  return readFile(filePath, 'utf8')
    .then(raw => JSON.parse(raw))
    .catch(() => null)
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

async function assertApiHealthy(apiUrl) {
  const { response } = await requestJson(apiUrl, '/health', { method: 'GET' })
  if (!response.ok) {
    throw new Error(`API health check failed (${response.status}) for ${apiUrl}`)
  }
}

async function assertLoggedIn(apiUrl, token) {
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const me = await requestJson(apiUrl, '/api/cli/me', {
    method: 'GET',
    token,
  })
  if (!me.response.ok) {
    throw new Error(me.data.error ?? `Authentication failed (${me.response.status}). Run \`hexgrid login\` again.`)
  }
  return me.data
}

async function ensureCodexSetup(repoRoot, mcpUrl) {
  const codexDir = path.join(repoRoot, '.codex')
  const codexConfigPath = path.join(codexDir, 'config.toml')
  const block = renderCodexHexgridBlock(mcpUrl)

  await mkdir(codexDir, { recursive: true })

  let nextContent = block
  if (await fileExists(codexConfigPath)) {
    const current = await readFile(codexConfigPath, 'utf8')
    const escapedStart = HEXGRID_CODEX_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedEnd = HEXGRID_CODEX_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const managedRegex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'm')

    if (managedRegex.test(current)) {
      nextContent = current.replace(managedRegex, block)
    } else {
      nextContent = `${current.trimEnd()}\n\n${block}\n`
    }
  } else {
    nextContent = `${block}\n`
  }

  await writeFile(codexConfigPath, nextContent)
  return codexConfigPath
}

const HEXGRID_CLAUDE_BLOCK_START = '<!-- BEGIN HEXGRID (managed by hexgrid setup) -->'
const HEXGRID_CLAUDE_BLOCK_END = '<!-- END HEXGRID -->'

function renderClaudeHexgridBlock() {
  return [
    HEXGRID_CLAUDE_BLOCK_START,
    '',
    '## HexGrid — Cross-Repo Collaboration',
    '',
    'This repo is connected to HexGrid. When you need information about code in',
    'another repository (API contracts, schemas, config, architecture), use the',
    '`hexgrid` CLI rather than guessing.',
    '',
    '### Ask another repo',
    '```bash',
    'hexgrid ask --capability repo:<name> --question "..." --context "why you need this"',
    '```',
    '',
    '- `--capability`: which repo/service to ask (e.g. `repo:api-service`)',
    '- `--question`: what you need to know',
    '- `--context`: why you\'re asking — improves answer quality',
    '- Blocks until answered or cached knowledge is returned',
    '',
    '### See active sessions',
    '```bash',
    'hexgrid sessions',
    '```',
    '',
    'Use this to discover available capabilities before asking.',
    '',
    '### Guidelines',
    '- Do not guess cross-repo details — ask. Answers are cached, so repeated questions are free.',
    '- Treat responses as authoritative context from the target codebase.',
    '- Always include `--context` so the answering agent understands why you need the information.',
    '',
    HEXGRID_CLAUDE_BLOCK_END,
  ].join('\n')
}

async function ensureClaudeMcpSetup(repoRoot, mcpUrl, token) {
  const mcpPath = path.join(repoRoot, '.mcp.json')
  const claudeDir = path.join(repoRoot, '.claude')
  const claudeSettingsPath = path.join(claudeDir, 'settings.local.json')

  const mcpConfig = (await readJsonMaybe(mcpPath)) ?? {}
  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
    mcpConfig.mcpServers = {}
  }

  mcpConfig.mcpServers.hexgrid = {
    type: 'streamable-http',
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }
  await writeFile(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`)

  await mkdir(claudeDir, { recursive: true })
  const claudeSettings = (await readJsonMaybe(claudeSettingsPath)) ?? {}
  const enabled = Array.isArray(claudeSettings.enabledMcpjsonServers)
    ? claudeSettings.enabledMcpjsonServers.filter(item => typeof item === 'string')
    : []

  if (!enabled.includes('hexgrid')) {
    enabled.push('hexgrid')
  }

  claudeSettings.enabledMcpjsonServers = enabled
  claudeSettings.enableAllProjectMcpServers = true

  await writeFile(claudeSettingsPath, `${JSON.stringify(claudeSettings, null, 2)}\n`)
  return { mcpPath, claudeSettingsPath }
}

async function ensureClaudeSetup(repoRoot) {
  const claudeDir = path.join(repoRoot, '.claude')
  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md')

  await mkdir(claudeDir, { recursive: true })

  const block = renderClaudeHexgridBlock()
  let nextContent = block

  if (await fileExists(claudeMdPath)) {
    const current = await readFile(claudeMdPath, 'utf8')
    const escapedStart = HEXGRID_CLAUDE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedEnd = HEXGRID_CLAUDE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const managedRegex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'm')

    if (managedRegex.test(current)) {
      nextContent = current.replace(managedRegex, block)
    } else {
      nextContent = `${current.trimEnd()}\n\n${block}\n`
    }
  } else {
    nextContent = `${block}\n`
  }

  await writeFile(claudeMdPath, nextContent)
  return { claude_md_path: claudeMdPath }
}

async function setupRuntimes({ runtimes, repoRoot, apiUrl, token, mcp = false }) {
  const mcpUrl = mcpUrlFromApiUrl(apiUrl)
  const result = {}

  for (const runtime of runtimes) {
    if (runtime === 'codex') {
      const codexConfigPath = await ensureCodexSetup(repoRoot, mcpUrl)
      result.codex = { ok: true, config_path: codexConfigPath }
      continue
    }

    if (runtime === 'claude') {
      const claudeFiles = await ensureClaudeSetup(repoRoot)
      result.claude = { ok: true, ...claudeFiles }

      if (mcp) {
        const mcpFiles = await ensureClaudeMcpSetup(repoRoot, mcpUrl, token)
        result.claude = { ...result.claude, ...mcpFiles }
      }
    }
  }

  return result
}

async function inspectRuntimeSetup(runtime, repoRoot, apiUrl) {
  const mcpUrl = mcpUrlFromApiUrl(apiUrl)

  if (runtime === 'codex') {
    const codexConfigPath = path.join(repoRoot, '.codex', 'config.toml')
    if (!(await fileExists(codexConfigPath))) {
      return { ok: false, reason: `missing ${codexConfigPath}` }
    }
    const content = await readFile(codexConfigPath, 'utf8')
    const ok = content.includes('[mcp_servers.hexgrid]')
      && content.includes(`url = "${mcpUrl}"`)
      && content.includes('bearer_token_env_var = "HEXGRID_API_KEY"')
    return ok
      ? { ok: true, config_path: codexConfigPath }
      : { ok: false, reason: 'hexgrid MCP block missing or stale in .codex/config.toml' }
  }

  if (runtime === 'claude') {
    const claudeMdPath = path.join(repoRoot, 'CLAUDE.md')
    if (!(await fileExists(claudeMdPath))) {
      return { ok: false, reason: 'missing CLAUDE.md — run `hexgrid setup claude`' }
    }
    const content = await readFile(claudeMdPath, 'utf8')
    const hasBlock = content.includes(HEXGRID_CLAUDE_BLOCK_START) && content.includes(HEXGRID_CLAUDE_BLOCK_END)
    if (hasBlock) {
      return { ok: true, claude_md_path: claudeMdPath }
    }
    return { ok: false, reason: 'CLAUDE.md is missing HexGrid block — run `hexgrid setup claude`' }
  }

  return { ok: false, reason: `unsupported runtime ${runtime}` }
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

async function connectRepoSession({ config, apiUrl, token, context, runtime, name, description }) {
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

  return connect.data
}

async function disconnectRepoSession({ config, apiUrl, token, sessionId, repoRoot }) {
  const disconnect = await requestJson(apiUrl, '/api/cli/disconnect', {
    method: 'POST',
    token,
    body: { session_id: sessionId },
  })

  if (!disconnect.response.ok) {
    throw new Error(disconnect.data.error ?? `Disconnect failed (${disconnect.response.status})`)
  }

  const sessions = { ...(config.sessions ?? {}) }
  const key = sessionKey(repoRoot)
  if (sessions[key]?.session_id === sessionId) delete sessions[key]

  await saveConfig({
    ...config,
    sessions,
    last_session_id: config.last_session_id === sessionId ? null : config.last_session_id,
  })

  return disconnect.data
}

async function commandSetup(args) {
  const { primary } = splitPassthroughArgs(args)
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(primary, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  await assertApiHealthy(apiUrl)
  await assertLoggedIn(apiUrl, token)

  const runtimes = parseRuntimes(primary, 'all')
  const useMcp = hasFlag(primary, '--mcp')
  const context = await detectRepoContext()
  const setupResult = await setupRuntimes({
    runtimes,
    repoRoot: context.repoRoot,
    apiUrl,
    token,
    mcp: useMcp,
  })

  console.log(JSON.stringify({
    ok: true,
    api_url: apiUrl,
    repo: context.repoName,
    runtimes,
    setup: setupResult,
  }, null, 2))
}

async function commandDoctor(args) {
  const { primary } = splitPassthroughArgs(args)
  const shouldFix = hasFlag(primary, '--fix')
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(primary, config)
  const token = resolveToken(config)
  const runtimes = parseRuntimes(primary, 'all')
  const context = await detectRepoContext()
  const checks = []

  if (shouldFix) {
    if (token) {
      try {
        await setupRuntimes({
          runtimes,
          repoRoot: context.repoRoot,
          apiUrl,
          token,
        })
        checks.push({ check: 'auto_fix', ok: true, detail: 'Applied runtime setup fixes' })
      } catch (err) {
        checks.push({ check: 'auto_fix', ok: false, detail: String(err instanceof Error ? err.message : err) })
      }
    } else {
      checks.push({ check: 'auto_fix', ok: false, detail: 'Skipped --fix because CLI login token is missing' })
    }
  }

  try {
    await assertApiHealthy(apiUrl)
    checks.push({ check: 'api_health', ok: true, detail: apiUrl })
  } catch (err) {
    checks.push({ check: 'api_health', ok: false, detail: String(err instanceof Error ? err.message : err) })
  }

  if (token) {
    try {
      const me = await assertLoggedIn(apiUrl, token)
      checks.push({ check: 'cli_auth', ok: true, detail: me.email ?? me.user_id ?? 'authenticated' })
    } catch (err) {
      checks.push({ check: 'cli_auth', ok: false, detail: String(err instanceof Error ? err.message : err) })
    }
  } else {
    checks.push({ check: 'cli_auth', ok: false, detail: 'Missing CLI token. Run `hexgrid login`.' })
  }

  checks.push({
    check: 'repo_context',
    ok: Boolean(context.repoRoot && context.repoName),
    detail: context.repoRoot,
  })

  for (const runtime of runtimes) {
    const hasBinary = commandExists(runtime)
    checks.push({
      check: `runtime_binary:${runtime}`,
      ok: hasBinary,
      detail: hasBinary ? `${runtime} found` : `${runtime} not found in PATH`,
    })

    const setupState = await inspectRuntimeSetup(runtime, context.repoRoot, apiUrl)
    checks.push({
      check: `runtime_setup:${runtime}`,
      ok: setupState.ok,
      detail: setupState.ok ? JSON.stringify(setupState) : setupState.reason,
    })
  }

  const ok = checks.every(item => item.ok)
  console.log(JSON.stringify({
    ok,
    api_url: apiUrl,
    runtimes,
    repo: context.repoName,
    checks,
  }, null, 2))

  if (!ok) process.exitCode = 1
}

async function commandConnect(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  await assertLoggedIn(apiUrl, token)

  const runtime = parseFlag(args, '--runtime', 'cli')
  const context = await detectRepoContext()
  const name = parseFlag(args, '--name', `${context.repoName}-${runtime}`)
  const description = parseFlag(
    args,
    '--description',
    `${runtime} session for ${context.repoName} (${context.repoType})`,
  )

  const connected = await connectRepoSession({
    config,
    apiUrl,
    token,
    context,
    runtime,
    name,
    description,
  })

  console.log(JSON.stringify({
    session_id: connected.session_id,
    hex_id: connected.hex_id,
    active_sessions: connected.active_sessions?.length ?? 0,
    repo: context.repoName,
    runtime,
  }, null, 2))
}

async function commandRun(args) {
  const { primary, passthrough } = splitPassthroughArgs(args)
  const runtime = parseRuntime(firstPositional(primary), { allowAll: false })
  if (!runtime) {
    throw new Error('Missing runtime. Use `hexgrid run codex` or `hexgrid run claude`.')
  }

  const config = await loadConfig()
  const apiUrl = resolveApiUrl(primary, config)
  const token = resolveToken(config)
  await assertApiHealthy(apiUrl)
  await assertLoggedIn(apiUrl, token)

  const context = await detectRepoContext()
  await setupRuntimes({
    runtimes: [runtime],
    repoRoot: context.repoRoot,
    apiUrl,
    token,
  })

  const name = parseFlag(primary, '--name', `${context.repoName}-${runtime}`)
  const description = parseFlag(
    primary,
    '--description',
    `${runtime} session for ${context.repoName} (${context.repoType})`,
  )
  const heartbeatSeconds = parsePositiveInt(parseFlag(primary, '--heartbeat-seconds', null), DEFAULT_HEARTBEAT_SECONDS)

  const connected = await connectRepoSession({
    config,
    apiUrl,
    token,
    context,
    runtime,
    name,
    description,
  })
  const sessionId = connected.session_id

  console.log(JSON.stringify({
    ok: true,
    runtime,
    repo: context.repoName,
    session_id: sessionId,
    hex_id: connected.hex_id,
    heartbeat_seconds: heartbeatSeconds,
  }, null, 2))

  let heartbeatTimer = null
  let heartbeatBusy = false
  let signalTriggered = false
  let child
  const childEnv = {
    ...process.env,
    HEXGRID_API_KEY: token,
    HEXGRID_API_URL: apiUrl,
    HEXGRID_SESSION_ID: sessionId,
  }

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      try {
        const hb = await requestJson(apiUrl, '/api/cli/heartbeat', {
          method: 'POST',
          token,
          body: { session_id: sessionId },
        })
        if (!hb.response.ok) {
          const detail = hb.data?.error ?? `status=${hb.response.status}`
          console.error(`Warning: heartbeat failed (${detail})`)
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`Warning: heartbeat error (${detail})`)
      } finally {
        heartbeatBusy = false
      }
    }, heartbeatSeconds * 1000)

    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref()
    }
  }

  try {
    startHeartbeat()

    const childCommand = runtime === 'codex' ? 'codex' : 'claude'
    child = spawn(childCommand, passthrough, {
      cwd: context.repoRoot,
      env: childEnv,
      stdio: 'inherit',
    })

    const handleSignal = (signal) => {
      if (signalTriggered) return
      signalTriggered = true
      if (child && !child.killed) {
        child.kill(signal)
      }
    }

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    for (const signal of signals) {
      process.on(signal, handleSignal)
    }

    let exitResult
    try {
      exitResult = await new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (code, signal) => resolve({ code, signal }))
      })
    } finally {
      for (const signal of signals) {
        process.removeListener(signal, handleSignal)
      }
    }

    if (exitResult.signal) {
      process.exitCode = 1
    } else if (typeof exitResult.code === 'number' && exitResult.code !== 0) {
      process.exitCode = exitResult.code
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    try {
      const latestConfig = await loadConfig()
      await disconnectRepoSession({
        config: latestConfig,
        apiUrl,
        token,
        sessionId,
        repoRoot: context.repoRoot,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`Warning: failed to disconnect session ${sessionId} (${detail})`)
    }
  }
}

async function resolveSessionId(config, args) {
  const positional = firstPositional(args)
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
  await assertLoggedIn(apiUrl, token)

  const sessionId = await resolveSessionId(config, args)
  if (!sessionId) throw new Error('No session_id found. Pass one explicitly or run connect in this repo.')

  const context = await detectRepoContext()
  const disconnected = await disconnectRepoSession({
    config,
    apiUrl,
    token,
    sessionId,
    repoRoot: context.repoRoot,
  })

  console.log(JSON.stringify(disconnected, null, 2))
}

async function commandSessions(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const sessions = await requestJson(apiUrl, '/api/cli/sessions', {
    method: 'GET',
    token,
  })

  if (!sessions.response.ok) {
    throw new Error(sessions.data.error ?? `List sessions failed (${sessions.response.status})`)
  }

  console.log(JSON.stringify(sessions.data, null, 2))
}

async function resolveTargetSessionId(apiUrl, token, targetRaw) {
  if (!targetRaw) throw new Error('Missing target. Use `--to <session_id|name|hex_id>`.')
  if (isUuidLike(targetRaw)) return targetRaw

  const list = await requestJson(apiUrl, '/api/cli/sessions', {
    method: 'GET',
    token,
  })
  if (!list.response.ok) {
    throw new Error(list.data.error ?? `List sessions failed (${list.response.status})`)
  }

  const target = targetRaw.trim().toLowerCase()
  const sessions = Array.isArray(list.data.sessions) ? list.data.sessions : []

  const exact = sessions.find(session =>
    String(session.hex_id ?? '').toLowerCase() === target
    || String(session.name ?? '').toLowerCase() === target
    || String(session.session_id ?? '').toLowerCase() === target,
  )
  if (exact?.session_id) return exact.session_id

  const prefixed = sessions.filter(session => String(session.hex_id ?? '').toLowerCase().startsWith(target))
  if (prefixed.length === 1 && prefixed[0]?.session_id) return prefixed[0].session_id
  if (prefixed.length > 1) {
    throw new Error(`Target "${targetRaw}" is ambiguous. Use full session_id.`)
  }

  throw new Error(`Target "${targetRaw}" not found. Run \`hexgrid sessions\` to inspect active sessions.`)
}

async function resolveSourceSessionId(config, args) {
  const fromFlag = parseFlag(args, '--session', null) ?? parseFlag(args, '--from', null)
  if (fromFlag) return fromFlag
  return resolveSessionId(config, [])
}

async function commandAsk(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const question = parseFlag(args, '--question', null)
  const capability = parseFlag(args, '--capability', null)
  const targetRaw = parseFlag(args, '--to', null)
  const context = parseFlag(args, '--context', null)
  if (!question) throw new Error('Missing question. Use `--question "..."`.')

  const sessionId = await resolveSourceSessionId(config, args)
  if (!sessionId) throw new Error('No source session_id found. Pass `--session` or run connect in this repo.')

  // Capability-based ask
  if (capability) {
    const askBody = { session_id: sessionId, capability, question }
    if (context) askBody.context = context

    const ask = await requestJson(apiUrl, '/api/cli/ask', {
      method: 'POST',
      token,
      body: askBody,
    })

    if (!ask.response.ok) {
      throw new Error(ask.data.error ?? `Ask failed (${ask.response.status})`)
    }

    // Knowledge hit — instant answer
    if (ask.data.source === 'knowledge') {
      console.log(`[knowledge] Answer from knowledge graph (id: ${ask.data.knowledge_id}):\n`)
      console.log(ask.data.answer)
      return
    }

    // Routed — poll for response
    const messageIds = ask.data.message_ids ?? []
    if (messageIds.length === 0) {
      throw new Error('No messages were routed.')
    }

    console.log(`Routed to ${ask.data.routed_to?.length ?? 0} session(s). Waiting for answer...`)
    const startedAt = Date.now()
    const deadline = startedAt + 5 * 60 * 1000 // 5 min timeout

    while (Date.now() < deadline) {
      await sleep(3000)
      for (const msgId of messageIds) {
        const resp = await requestJson(apiUrl, '/api/cli/response', {
          method: 'POST',
          token,
          body: { message_id: msgId },
        })

        if (resp.response.ok && resp.data.status === 'answered' && resp.data.answer) {
          console.log(`\n[answered] Response received:\n`)
          console.log(resp.data.answer)
          return
        }

        if (resp.response.ok && resp.data.status === 'expired') {
          throw new Error('Message expired without an answer.')
        }
      }
      process.stdout.write('.')
    }

    throw new Error('Timed out waiting for answer (5 min).')
  }

  // Direct session-id ask (existing behavior)
  const toSessionId = await resolveTargetSessionId(apiUrl, token, targetRaw)

  const ask = await requestJson(apiUrl, '/api/cli/ask', {
    method: 'POST',
    token,
    body: {
      session_id: sessionId,
      to_session_id: toSessionId,
      question,
    },
  })

  if (!ask.response.ok) {
    throw new Error(ask.data.error ?? `Ask failed (${ask.response.status})`)
  }

  console.log(JSON.stringify(ask.data, null, 2))
}

function invokeClaudeHeadless(question, repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', question], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000, // 5 minute timeout
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (err) => reject(new Error(`Failed to invoke claude: ${err.message}`)))
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

const DEFAULT_POLL_SECONDS = 10

async function commandListen(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  await assertApiHealthy(apiUrl)
  await assertLoggedIn(apiUrl, token)

  const context = await detectRepoContext()
  const capability = parseFlag(args, '--capability', `repo:${context.repoName}`)
  const name = parseFlag(args, '--name', `${context.repoName}-listener`)
  const pollSeconds = parsePositiveInt(parseFlag(args, '--poll-seconds', null), DEFAULT_POLL_SECONDS)

  // Register as listener
  const register = await requestJson(apiUrl, '/api/cli/register', {
    method: 'POST',
    token,
    body: {
      name,
      repo_url: context.repoUrl,
      description: `Listener for ${capability}`,
      capabilities: [capability],
    },
  })

  if (!register.response.ok) {
    throw new Error(register.data.error ?? `Register failed (${register.response.status})`)
  }

  const sessionId = register.data.session_id
  console.log(JSON.stringify({
    ok: true,
    mode: 'listen',
    session_id: sessionId,
    capability,
    poll_seconds: pollSeconds,
    repo: context.repoName,
  }, null, 2))

  let heartbeatTimer = null
  let heartbeatBusy = false
  let running = true

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      try {
        await requestJson(apiUrl, '/api/cli/heartbeat', {
          method: 'POST',
          token,
          body: { session_id: sessionId },
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`Warning: heartbeat error (${detail})`)
      } finally {
        heartbeatBusy = false
      }
    }, DEFAULT_HEARTBEAT_SECONDS * 1000)

    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref()
    }
  }

  const shutdown = async () => {
    if (!running) return
    running = false
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    try {
      await requestJson(apiUrl, '/api/cli/disconnect', {
        method: 'POST',
        token,
        body: { session_id: sessionId },
      })
      console.log('\nDisconnected.')
    } catch {
      // best-effort
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  startHeartbeat()
  console.log(`Listening for questions on capability "${capability}"... (Ctrl+C to stop)`)

  while (running) {
    await sleep(pollSeconds * 1000)
    if (!running) break

    try {
      const poll = await requestJson(apiUrl, '/api/cli/poll', {
        method: 'POST',
        token,
        body: { session_id: sessionId, capability },
      })

      if (!poll.response.ok) continue

      const messages = poll.data.messages ?? []
      for (const msg of messages) {
        if (!running) break
        console.log(`\n[question] From ${msg.from_session_name}: ${msg.question}`)
        if (msg.context) console.log(`[context] ${msg.context}`)

        try {
          const prompt = msg.context
            ? `Question: ${msg.question}\nContext: ${msg.context}`
            : msg.question
          console.log('[answering] Invoking claude...')
          const answer = await invokeClaudeHeadless(prompt, context.repoRoot)

          const reply = await requestJson(apiUrl, '/api/cli/reply', {
            method: 'POST',
            token,
            body: {
              session_id: sessionId,
              message_id: msg.message_id,
              answer,
            },
          })

          if (reply.response.ok) {
            console.log(`[answered] Reply sent for message ${msg.message_id}`)
          } else {
            console.error(`[error] Reply failed: ${reply.data.error ?? reply.response.status}`)
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          console.error(`[error] Failed to answer message ${msg.message_id}: ${detail}`)
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`Warning: poll error (${detail})`)
    }
  }
}

async function commandInbox(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const sessionArg = parseFlag(args, '--session', null) ?? parseFlag(args, '--for', null)
  const sessionId = sessionArg ?? await resolveSessionId(config, args)
  if (!sessionId) throw new Error('No session_id found. Pass one explicitly or run connect in this repo.')

  const inbox = await requestJson(apiUrl, '/api/cli/inbox', {
    method: 'POST',
    token,
    body: { session_id: sessionId },
  })

  if (!inbox.response.ok) {
    throw new Error(inbox.data.error ?? `Inbox failed (${inbox.response.status})`)
  }

  console.log(JSON.stringify(inbox.data, null, 2))
}

async function commandReply(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const messageId = parseFlag(args, '--message', null) ?? firstPositional(args)
  const answer = parseFlag(args, '--answer', null)
  if (!messageId) throw new Error('Missing message ID. Use `--message <id>` or pass it as first positional argument.')
  if (!answer) throw new Error('Missing answer. Use `--answer "..."`.')

  const sessionId = await resolveSourceSessionId(config, args)
  if (!sessionId) throw new Error('No session_id found. Pass `--session` or run connect in this repo.')

  const reply = await requestJson(apiUrl, '/api/cli/reply', {
    method: 'POST',
    token,
    body: {
      session_id: sessionId,
      message_id: messageId,
      answer,
    },
  })

  if (!reply.response.ok) {
    throw new Error(reply.data.error ?? `Reply failed (${reply.response.status})`)
  }

  console.log(JSON.stringify(reply.data, null, 2))
}

async function commandResponse(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  const messageId = parseFlag(args, '--message', null) ?? firstPositional(args)
  if (!messageId) throw new Error('Missing message ID. Use `hexgrid response <message_id>`.')

  const response = await requestJson(apiUrl, '/api/cli/response', {
    method: 'POST',
    token,
    body: { message_id: messageId },
  })

  if (!response.response.ok) {
    throw new Error(response.data.error ?? `Get response failed (${response.response.status})`)
  }

  console.log(JSON.stringify(response.data, null, 2))
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

async function commandUpdate() {
  if (!commandExists('npm')) {
    throw new Error('npm is required for `hexgrid update` but was not found in PATH.')
  }

  const target = `${CLI_PACKAGE_NAME}@latest`
  console.log(`Updating ${target}...`)

  const result = spawnSync('npm', ['install', '-g', target], {
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status ?? 1}`)
  }

  console.log(`Updated ${CLI_PACKAGE_NAME} to latest.`)
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
  if (command === 'setup') {
    await commandSetup(args)
    return
  }
  if (command === 'doctor') {
    await commandDoctor(args)
    return
  }
  if (command === 'connect') {
    await commandConnect(args)
    return
  }
  if (command === 'run') {
    await commandRun(args)
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
  if (command === 'sessions') {
    await commandSessions(args)
    return
  }
  if (command === 'ask') {
    await commandAsk(args)
    return
  }
  if (command === 'listen') {
    await commandListen(args)
    return
  }
  if (command === 'inbox') {
    await commandInbox(args)
    return
  }
  if (command === 'reply') {
    await commandReply(args)
    return
  }
  if (command === 'response') {
    await commandResponse(args)
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
  if (command === 'update') {
    await commandUpdate()
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
