#!/usr/bin/env node

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  getCurrentWorkspaceRoot,
  getWorkspaceRepoBinding,
  getWorkspaceState,
  initWorkspaceManifest,
  listConfiguredWorkspaces,
  loadWorkspaceManifest,
  loadWorkspaceManifestFromRoot,
  normaliseListenMode,
  saveWorkspaceManifest,
  setCurrentWorkspace,
  upsertWorkspaceRepo,
  upsertWorkspaceRepoBinding,
} from '../src/workspace.mjs'
import { runWorkspaceTui } from '../src/tui.mjs'
import { createSessionSupervisor } from '../src/session-supervisor.mjs'
import { startLocalUiServer } from '../src/ui-server.mjs'

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
  hexgrid
  hexgrid tui
  hexgrid ui [--port PORT] [--no-open]
  hexgrid workspace [status]
  hexgrid workspace init [--name NAME]
  hexgrid repo add <repo_id> [--path PATH] [--remote URL] [--description TEXT] [--runtime RUNTIME] [--listen MODE]
  hexgrid repo list
  hexgrid repo run <repo_id> [--runtime RUNTIME] [--name NAME] [--description TEXT] [--heartbeat-seconds N] [-- ...agent args]
  hexgrid repo listen <repo_id> [--runtime claude] [--capability CAP] [--name NAME] [--poll-seconds N]
  hexgrid login [--api-url URL] [--no-open] [--client-name NAME]
  hexgrid setup [all|codex|claude] [--mcp]
  hexgrid doctor [all|codex|claude] [--fix]
  hexgrid connect [--runtime RUNTIME] [--name NAME] [--description TEXT]
  hexgrid onboard [--name NAME] [--description TEXT]
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

function resolveCommandPath(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

function readJsonMaybe(filePath) {
  return readFile(filePath, 'utf8')
    .then(raw => JSON.parse(raw))
    .catch(() => null)
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)))
}

function limitItems(items, max = 10) {
  return items.slice(0, max)
}

function formatInlineList(items, fallback = 'none') {
  return items.length > 0 ? items.join(', ') : fallback
}

function formatBulletList(items, fallback = '- none detected') {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : fallback
}

function truncateText(input, max = 4000) {
  if (!input || input.length <= max) return input
  return `${input.slice(0, Math.max(0, max - 3))}...`
}

function humaniseLabel(input) {
  return input.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

async function listDirEntries(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function detectPackageFrameworks(pkg, hasWrangler) {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  }
  const frameworks = []

  if (deps.next) frameworks.push('nextjs')
  if (deps.react) frameworks.push('react')
  if (deps.vite) frameworks.push('vite')
  if (deps.typescript) frameworks.push('typescript')
  if (deps['@modelcontextprotocol/sdk']) frameworks.push('mcp')
  if (deps.wrangler || hasWrangler) frameworks.push('cloudflare-worker')
  if (deps.tailwindcss) frameworks.push('tailwindcss')
  if (deps.zod) frameworks.push('zod')

  return uniq(frameworks)
}

async function detectProjectUnit(repoRoot, relPath) {
  const absPath = relPath === '.' ? repoRoot : path.join(repoRoot, relPath)
  const packageJsonPath = path.join(absPath, 'package.json')
  const pyprojectPath = path.join(absPath, 'pyproject.toml')
  const cargoPath = path.join(absPath, 'Cargo.toml')
  const goModPath = path.join(absPath, 'go.mod')
  const dockerPath = path.join(absPath, 'Dockerfile')
  const wranglerPath = path.join(absPath, 'wrangler.toml')

  const [
    packageJson,
    hasPyproject,
    hasCargo,
    hasGoMod,
    hasDocker,
    hasWrangler,
  ] = await Promise.all([
    readJsonMaybe(packageJsonPath),
    fileExists(pyprojectPath),
    fileExists(cargoPath),
    fileExists(goModPath),
    fileExists(dockerPath),
    fileExists(wranglerPath),
  ])

  if (!packageJson && !hasPyproject && !hasCargo && !hasGoMod && !hasDocker && !hasWrangler) {
    return null
  }

  if (packageJson) {
    const workspaceConfig = packageJson.workspaces
    const workspaces = Array.isArray(workspaceConfig)
      ? workspaceConfig
      : Array.isArray(workspaceConfig?.packages)
        ? workspaceConfig.packages
        : []

    return {
      path: relPath,
      name: packageJson.name ?? (relPath === '.' ? path.basename(repoRoot) : path.basename(relPath)),
      ecosystem: 'node',
      scripts: Object.keys(packageJson.scripts ?? {}),
      frameworks: detectPackageFrameworks(packageJson, hasWrangler),
      workspaces,
      hasDocker,
      hasWrangler,
      source_ref: relPath === '.' ? 'package.json' : path.posix.join(relPath, 'package.json'),
    }
  }

  if (hasPyproject) {
    return {
      path: relPath,
      name: path.basename(absPath),
      ecosystem: 'python',
      scripts: [],
      frameworks: ['python'],
      workspaces: [],
      hasDocker,
      hasWrangler,
      source_ref: relPath === '.' ? 'pyproject.toml' : path.posix.join(relPath, 'pyproject.toml'),
    }
  }

  if (hasCargo) {
    return {
      path: relPath,
      name: path.basename(absPath),
      ecosystem: 'rust',
      scripts: [],
      frameworks: ['rust'],
      workspaces: [],
      hasDocker,
      hasWrangler,
      source_ref: relPath === '.' ? 'Cargo.toml' : path.posix.join(relPath, 'Cargo.toml'),
    }
  }

  if (hasGoMod) {
    return {
      path: relPath,
      name: path.basename(absPath),
      ecosystem: 'go',
      scripts: [],
      frameworks: ['go'],
      workspaces: [],
      hasDocker,
      hasWrangler,
      source_ref: relPath === '.' ? 'go.mod' : path.posix.join(relPath, 'go.mod'),
    }
  }

  return {
    path: relPath,
    name: path.basename(absPath),
    ecosystem: hasWrangler ? 'cloudflare' : 'container',
    scripts: [],
    frameworks: uniq([
      hasWrangler ? 'cloudflare-worker' : null,
      hasDocker ? 'docker' : null,
    ]),
    workspaces: [],
    hasDocker,
    hasWrangler,
    source_ref: hasWrangler
      ? (relPath === '.' ? 'wrangler.toml' : path.posix.join(relPath, 'wrangler.toml'))
      : (relPath === '.' ? 'Dockerfile' : path.posix.join(relPath, 'Dockerfile')),
  }
}

async function detectProjectUnits(repoRoot) {
  const units = []
  const rootUnit = await detectProjectUnit(repoRoot, '.')
  if (rootUnit) units.push(rootUnit)

  const rootEntries = await listDirEntries(repoRoot)
  const childDirs = rootEntries
    .filter(entry => entry.isDirectory() && (!entry.name.startsWith('.') || entry.name === '.github'))
    .map(entry => entry.name)

  for (const dirName of childDirs) {
    const unit = await detectProjectUnit(repoRoot, dirName)
    if (unit) units.push(unit)
  }

  return units
}

function detectPackageManagers(repoRoot) {
  const managers = []
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'pnpm-lock.yaml')}" ]`]).status === 0) managers.push('pnpm')
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'bun.lockb')}" ] || [ -f "${path.join(repoRoot, 'bun.lock')}" ]`]).status === 0) managers.push('bun')
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'yarn.lock')}" ]`]).status === 0) managers.push('yarn')
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'package-lock.json')}" ]`]).status === 0) managers.push('npm')
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'uv.lock')}" ]`]).status === 0) managers.push('uv')
  if (spawnSync('sh', ['-lc', `[ -f "${path.join(repoRoot, 'poetry.lock')}" ]`]).status === 0) managers.push('poetry')
  return uniq(managers)
}

function detectLanguages(repoRoot) {
  const tracked = runGit(['-C', repoRoot, 'ls-files'])
  const files = tracked ? tracked.split('\n').filter(Boolean).slice(0, 4000) : []
  const counts = new Map()
  const extensions = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.sql': 'SQL',
    '.css': 'CSS',
    '.scss': 'SCSS',
    '.html': 'HTML',
    '.md': 'Markdown',
    '.toml': 'TOML',
    '.yml': 'YAML',
    '.yaml': 'YAML',
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const label = extensions[ext]
    if (!label) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label)
    .slice(0, 6)
}

async function readReadmeSummary(repoRoot) {
  const candidates = ['README.md', 'README.mdx', 'README']

  for (const fileName of candidates) {
    const absPath = path.join(repoRoot, fileName)
    if (!(await fileExists(absPath))) continue
    const raw = await readFile(absPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    const paragraph = []
    let started = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        if (started) break
        continue
      }
      if (!started && trimmed.startsWith('#')) continue
      started = true
      paragraph.push(trimmed)
    }

    return paragraph.length > 0 ? truncateText(paragraph.join(' '), 500) : null
  }

  return null
}

async function detectWorkflows(repoRoot) {
  const workflowDir = path.join(repoRoot, '.github', 'workflows')
  const entries = await listDirEntries(workflowDir)
  return entries
    .filter(entry => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')))
    .map(entry => entry.name)
    .sort()
}

async function detectEnvExamples(repoRoot) {
  const envFiles = []
  const rootEntries = await listDirEntries(repoRoot)

  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.includes('.env') && entry.name.includes('example')) {
      envFiles.push(entry.name)
    }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nestedEntries = await listDirEntries(path.join(repoRoot, entry.name))
      for (const nested of nestedEntries) {
        if (nested.isFile() && nested.name.includes('.env') && nested.name.includes('example')) {
          envFiles.push(path.posix.join(entry.name, nested.name))
        }
      }
    }
  }

  return uniq(envFiles).sort()
}

async function listTopLevelEntries(repoRoot) {
  const entries = await listDirEntries(repoRoot)
  const dirs = []
  const files = []

  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (entry.isDirectory()) dirs.push(entry.name)
    if (entry.isFile()) files.push(entry.name)
  }

  return {
    dirs: dirs.sort(),
    files: files.sort(),
  }
}

function buildGlossaryTerms(context, units, topLevelDirs) {
  return uniq([
    context.repoName,
    ...units.map(unit => unit.name),
    ...units.map(unit => unit.path === '.' ? null : unit.path),
    ...topLevelDirs.filter(name => !name.startsWith('.')),
  ])
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 15)
}

async function analyzeRepoForOnboarding(context) {
  const [
    units,
    readmeSummary,
    workflows,
    envExamples,
    topLevel,
  ] = await Promise.all([
    detectProjectUnits(context.repoRoot),
    readReadmeSummary(context.repoRoot),
    detectWorkflows(context.repoRoot),
    detectEnvExamples(context.repoRoot),
    listTopLevelEntries(context.repoRoot),
  ])

  const packageManagers = detectPackageManagers(context.repoRoot)
  const languages = detectLanguages(context.repoRoot)
  const glossaryTerms = buildGlossaryTerms(context, units, topLevel.dirs)

  return {
    units,
    readmeSummary,
    workflows,
    envExamples,
    topLevel,
    packageManagers,
    languages,
    glossaryTerms,
  }
}

function buildRepoBriefNote(context, analysis) {
  const lines = [
    '# Repo Brief',
    '',
    `- Repo: \`${context.repoName}\``,
    `- Repo URL: \`${context.repoUrl}\``,
    `- Repo type: \`${context.repoType}\``,
    `- Package managers: ${formatInlineList(analysis.packageManagers)}`,
    `- Languages: ${formatInlineList(analysis.languages)}`,
    `- Top-level directories: ${formatInlineList(limitItems(analysis.topLevel.dirs, 12))}`,
    `- CI workflows: ${formatInlineList(limitItems(analysis.workflows, 10))}`,
    '',
  ]

  if (analysis.readmeSummary) {
    lines.push('## README summary', '', analysis.readmeSummary, '')
  }

  lines.push('## Detected surfaces', '')
  lines.push(formatBulletList(
    analysis.units.map(unit => {
      const location = unit.path === '.' ? 'repo root' : unit.path
      const frameworks = unit.frameworks.length > 0 ? ` using ${unit.frameworks.join(', ')}` : ''
      return `\`${location}\`: ${unit.ecosystem}${frameworks}`
    }),
    '- no runnable surfaces detected from manifests',
  ))

  return {
    topic: 'Repo brief',
    kind: 'repo-brief',
    status: 'canonical',
    confidence: 0.92,
    freshness: 'stable',
    tags: ['onboarding', context.repoName, context.repoType],
    source_refs: uniq([
      analysis.readmeSummary ? 'README.md' : null,
      ...analysis.units.map(unit => unit.source_ref),
    ]).map(source => ({ path: source })),
    content: truncateText(lines.join('\n').trim(), 4800),
  }
}

function buildArchitectureNote(context, analysis) {
  const unitBullets = analysis.units.map(unit => {
    const location = unit.path === '.' ? 'repo root' : unit.path
    const frameworks = unit.frameworks.length > 0 ? `; frameworks: ${unit.frameworks.join(', ')}` : ''
    const scripts = unit.scripts.length > 0 ? `; scripts: ${unit.scripts.slice(0, 6).join(', ')}` : ''
    const workspaces = unit.workspaces.length > 0 ? `; workspaces: ${unit.workspaces.join(', ')}` : ''
    return `\`${location}\`: ${unit.ecosystem}${frameworks}${scripts}${workspaces}`
  })

  const content = truncateText([
    '# Architecture',
    '',
    'This note is heuristic and should be reviewed after a deeper local investigation.',
    '',
    '## Detected units',
    '',
    formatBulletList(unitBullets, '- no architecture units detected from manifests'),
    '',
    '## Top-level layout',
    '',
    formatBulletList(limitItems(analysis.topLevel.dirs, 15).map(dir => `\`${dir}\``), '- no top-level directories detected'),
  ].join('\n').trim(), 4800)

  return {
    topic: 'Architecture overview',
    kind: 'architecture',
    status: 'candidate',
    confidence: 0.72,
    freshness: 'working',
    tags: ['onboarding', 'architecture', context.repoName],
    source_refs: analysis.units.map(unit => ({ path: unit.source_ref })),
    content,
  }
}

function buildCommandsNote(context, analysis) {
  const sections = []

  for (const unit of analysis.units) {
    if (unit.scripts.length === 0) continue
    const title = unit.path === '.' ? 'root' : unit.path
    sections.push(`## ${title}`)
    sections.push('')
    for (const scriptName of unit.scripts.slice(0, 12)) {
      const commandPrefix = analysis.packageManagers[0] === 'pnpm'
        ? 'pnpm'
        : analysis.packageManagers[0] === 'yarn'
          ? 'yarn'
          : analysis.packageManagers[0] === 'bun'
            ? 'bun run'
            : 'npm run'
      const scriptCommand = commandPrefix === 'yarn'
        ? `yarn ${scriptName}`
        : `${commandPrefix} ${scriptName}`
      sections.push(`- \`${scriptCommand}\``)
    }
    sections.push('')
  }

  if (sections.length === 0) {
    sections.push('No package scripts were detected from the current manifests.')
  }

  return {
    topic: 'Commands',
    kind: 'commands',
    status: 'canonical',
    confidence: 0.97,
    freshness: 'working',
    tags: ['onboarding', 'commands', context.repoName],
    source_refs: analysis.units.map(unit => ({ path: unit.source_ref })),
    content: truncateText([
      '# Commands',
      '',
      `Primary package managers detected: ${formatInlineList(analysis.packageManagers)}`,
      '',
      ...sections,
    ].join('\n').trim(), 4800),
  }
}

function buildGlossaryNote(context, analysis) {
  const glossaryBullets = analysis.glossaryTerms.map(term => {
    const matchingUnit = analysis.units.find(unit => unit.name === term || unit.path === term)
    if (matchingUnit) {
      const detail = matchingUnit.path === '.' ? 'repo root unit' : `unit at \`${matchingUnit.path}\``
      return `\`${term}\`: ${detail}`
    }
    return `\`${term}\`: detected project term from the repo layout`
  })

  return {
    topic: 'Glossary',
    kind: 'glossary',
    status: 'candidate',
    confidence: 0.61,
    freshness: 'stable',
    tags: ['onboarding', 'glossary', context.repoName],
    source_refs: analysis.units.map(unit => ({ path: unit.source_ref })),
    content: truncateText([
      '# Glossary',
      '',
      'These terms were inferred from package names and top-level structure.',
      '',
      formatBulletList(glossaryBullets, '- no glossary terms inferred'),
    ].join('\n').trim(), 4800),
  }
}

function buildPitfallsNote(context, analysis) {
  const pitfalls = []

  if (analysis.units.length > 1) {
    pitfalls.push(`This repo has multiple runnable surfaces (${analysis.units.map(unit => `\`${unit.path === '.' ? 'root' : unit.path}\``).join(', ')}); local setup may require starting more than one service.`)
  }
  if (analysis.units.some(unit => unit.hasWrangler)) {
    pitfalls.push('Cloudflare Wrangler is present; local development may depend on Worker/D1 configuration and applied schema.')
  }
  if (analysis.envExamples.length === 0) {
    pitfalls.push('No environment example files were detected during onboarding; verify required secrets and local env setup manually.')
  }
  if (analysis.packageManagers.length > 1) {
    pitfalls.push(`Multiple package managers were detected (${analysis.packageManagers.join(', ')}); follow the repo convention before installing or running scripts.`)
  }

  return {
    topic: 'Pitfalls',
    kind: 'pitfall',
    status: 'candidate',
    confidence: pitfalls.length > 0 ? 0.68 : 0.55,
    freshness: 'working',
    tags: ['onboarding', 'pitfalls', context.repoName],
    source_refs: uniq([
      ...analysis.units.filter(unit => unit.hasWrangler).map(unit => unit.path === '.' ? 'wrangler.toml' : path.posix.join(unit.path, 'wrangler.toml')),
      ...analysis.envExamples,
    ]).map(source => ({ path: source })),
    content: truncateText([
      '# Pitfalls',
      '',
      pitfalls.length > 0
        ? formatBulletList(pitfalls)
        : 'No strong pitfalls were inferred from the manifest scan. Verify deployment, environment, and data requirements manually.',
    ].join('\n').trim(), 4800),
  }
}

function buildOpenQuestionsNote(context, analysis) {
  const questions = []

  if (!analysis.readmeSummary) {
    questions.push('No readable top-level README summary was detected. Add or verify a high-signal entry point for new contributors and agents.')
  }
  if (analysis.workflows.length === 0) {
    questions.push('No CI workflows were detected. Verify how linting, tests, and deploys are expected to run.')
  }
  if (analysis.units.every(unit => unit.scripts.every(script => !/test/i.test(script)))) {
    questions.push('No obvious test script was detected from the current package manifests. Confirm the expected validation path.')
  }
  if (analysis.envExamples.length === 0) {
    questions.push('Required environment variables are unclear from the current repo scan.')
  }

  return {
    topic: 'Open questions',
    kind: 'open-question',
    status: 'candidate',
    confidence: 0.7,
    freshness: 'working',
    tags: ['onboarding', 'open-questions', context.repoName],
    source_refs: uniq([
      analysis.readmeSummary ? 'README.md' : null,
      ...analysis.units.map(unit => unit.source_ref),
      ...analysis.workflows.map(file => path.posix.join('.github/workflows', file)),
    ]).map(source => ({ path: source })),
    content: truncateText([
      '# Open Questions',
      '',
      questions.length > 0
        ? formatBulletList(questions)
        : 'No immediate open questions were inferred from the heuristic scan.',
    ].join('\n').trim(), 4800),
  }
}

async function generateOnboardingNotes(context) {
  const analysis = await analyzeRepoForOnboarding(context)
  const notes = [
    buildRepoBriefNote(context, analysis),
    buildArchitectureNote(context, analysis),
    buildCommandsNote(context, analysis),
    buildGlossaryNote(context, analysis),
    buildPitfallsNote(context, analysis),
    buildOpenQuestionsNote(context, analysis),
  ]

  return { analysis, notes }
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

function requireLeadingPositional(args, label) {
  const value = args[0]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing ${label}.`)
  }
  return value
}

function validateRepoId(repoId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoId)) {
    throw new Error(`Invalid repo id "${repoId}". Use letters, numbers, ".", "_" or "-".`)
  }
  return repoId
}

function stripFlagWithValue(args, name) {
  const next = []

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx]
    if (arg === '--') {
      next.push(...args.slice(idx))
      break
    }
    if (arg === name) {
      idx += 1
      continue
    }
    next.push(arg)
  }

  return next
}

function resolveRepoRootFromPath(repoPath) {
  const absolutePath = path.resolve(repoPath)
  return runGit(['-C', absolutePath, 'rev-parse', '--show-toplevel']) ?? absolutePath
}

function resolveRepoRemote(repoRoot) {
  return runGit(['-C', repoRoot, 'remote', 'get-url', 'origin']) ?? `local://${repoRoot}`
}

function canPromptUser() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function promptLine(rl, label, { defaultValue = null, optional = false, parse = null } = {}) {
  while (true) {
    const suffix = defaultValue && defaultValue.length > 0
      ? ` [${defaultValue}]`
      : optional
        ? ' (optional)'
        : ''
    const answer = (await rl.question(`${label}${suffix}: `)).trim()
    const value = answer || defaultValue || ''

    if (!value) {
      if (optional) return null
      console.log(`${label} is required.`)
      continue
    }

    if (!parse) return value

    try {
      return await parse(value)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.log(detail)
    }
  }
}

async function resolveRepoAddInput({ workspace, repoId, repoArgs, existing, existingBinding }) {
  const explicitPath = parseFlag(repoArgs, '--path', null)
  const explicitDescription = parseFlag(repoArgs, '--description', null)
  const explicitRuntime = parseFlag(repoArgs, '--runtime', null)
  const explicitListen = parseFlag(repoArgs, '--listen', null)
  const explicitRemote = parseFlag(repoArgs, '--remote', null)

  const inferredRepoRoot = resolveRepoRootFromPath(process.cwd())
  const suggestedPath = existingBinding?.path
    ?? (inferredRepoRoot !== workspace.workspaceRoot ? inferredRepoRoot : null)

  let repoPath
  if (explicitPath) {
    repoPath = path.resolve(explicitPath)
    if (!(await fileExists(repoPath))) {
      throw new Error(`Repo path does not exist: ${repoPath}`)
    }
  } else if (canPromptUser()) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      console.log(`Adding repo "${repoId}" to workspace "${workspace.manifest.name}".`)
      repoPath = await promptLine(rl, 'Local repo path', {
        defaultValue: suggestedPath,
        parse: async (value) => {
          const resolved = path.resolve(value)
          if (!(await fileExists(resolved))) {
            throw new Error(`Repo path does not exist: ${resolved}`)
          }
          return resolved
        },
      })

      const repoRoot = resolveRepoRootFromPath(repoPath)
      const detectedRemote = resolveRepoRemote(repoRoot)

      const remote = explicitRemote ?? await promptLine(rl, 'Remote URL', {
        defaultValue: existing.remote ?? detectedRemote,
      })
      const description = explicitDescription ?? await promptLine(rl, 'Description', {
        defaultValue: existing.description ?? null,
        optional: true,
      })
      const defaultRuntime = explicitRuntime
        ? parseRuntime(explicitRuntime, { allowAll: false })
        : await promptLine(rl, 'Default runtime', {
            defaultValue: existing.defaultRuntime ?? 'codex',
            parse: value => parseRuntime(value, { allowAll: false }),
          })
      const listen = explicitListen
        ? normaliseListenMode(explicitListen)
        : await promptLine(rl, 'Listen mode', {
            defaultValue: existing.listen ?? 'manual',
            parse: value => normaliseListenMode(value),
          })

      return {
        repoRoot,
        remote,
        description,
        defaultRuntime,
        listen,
      }
    } finally {
      rl.close()
    }
  } else {
    throw new Error('Missing repo path. Pass `--path PATH` or run `hexgrid repo add <repo_id>` interactively.')
  }

  const repoRoot = resolveRepoRootFromPath(repoPath)
  const defaultRuntime = parseRuntime(
    explicitRuntime ?? existing.defaultRuntime ?? 'codex',
    { allowAll: false, fallback: existing.defaultRuntime ?? 'codex' },
  )
  const listen = normaliseListenMode(explicitListen ?? existing.listen ?? 'manual')
  const description = explicitDescription ?? existing.description ?? null
  const remote = explicitRemote ?? existing.remote ?? resolveRepoRemote(repoRoot)

  return {
    repoRoot,
    remote,
    description,
    defaultRuntime,
    listen,
  }
}

async function withWorkingDirectory(nextCwd, callback) {
  const previousCwd = process.cwd()
  process.chdir(nextCwd)

  try {
    return await callback()
  } finally {
    process.chdir(previousCwd)
  }
}

function stripRepoSuffix(input) {
  return String(input ?? '').replace(/\.git$/i, '').replace(/\/+$/, '')
}

function normaliseRepoPath(pathname) {
  return stripRepoSuffix(pathname.trim()).replace(/^\/+/, '')
}

function normaliseWorkspaceRepoUrl(repoUrl) {
  const trimmed = String(repoUrl ?? '').trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('local://')) {
    const localPath = stripRepoSuffix(trimmed.slice('local://'.length)).replace(/\/{2,}/g, '/')
    return `local://${localPath}`
  }

  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname.toLowerCase()
    const pathname = normaliseRepoPath(parsed.pathname)
    if (host && pathname) return `${host}/${pathname}`
  } catch {
    // Fall through to SCP-style git remotes and opaque local strings.
  }

  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scpMatch) {
    const [, host, pathname] = scpMatch
    return `${host.toLowerCase()}/${normaliseRepoPath(pathname)}`
  }

  return stripRepoSuffix(trimmed)
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseCapabilities(value) {
  return parseJsonArray(value)
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function buildLocalSessionRuntimeIndex(config) {
  const entries = Object.values(config?.sessions ?? {})
  const index = new Map()

  for (const session of entries) {
    if (!session || typeof session !== 'object') continue
    if (typeof session.session_id !== 'string' || !session.session_id) continue
    if (typeof session.runtime !== 'string' || !session.runtime) continue
    index.set(session.session_id, session.runtime)
  }

  return index
}

function inferSessionRuntime(session, localRuntimeIndex) {
  const localRuntime = localRuntimeIndex.get(session.session_id)
  if (localRuntime) return localRuntime

  const capabilities = parseCapabilities(session.capabilities)
  const runtimeCapability = capabilities.find(capability => capability.startsWith('runtime:'))
  if (runtimeCapability) return runtimeCapability.slice('runtime:'.length)

  if (/listener/i.test(session.name ?? '')) return 'listener'
  return 'unknown'
}

function inferSessionMode(session, runtime) {
  if (/listener/i.test(session.name ?? '')) return 'listener'
  if (runtime === 'listener') return 'listener'
  return 'interactive'
}

function buildWorkspaceRepoKeys(repo) {
  const keys = new Set()
  if (repo.remote) keys.add(normaliseWorkspaceRepoUrl(repo.remote))
  if (repo.path) keys.add(normaliseWorkspaceRepoUrl(`local://${path.resolve(repo.path)}`))
  return Array.from(keys).filter(Boolean)
}

function buildWorkspaceRepoIndex(repos) {
  const repoIdByKey = new Map()
  const repoIdByCapability = new Map()

  for (const repo of repos) {
    for (const repoKey of buildWorkspaceRepoKeys(repo)) {
      if (!repoIdByKey.has(repoKey)) repoIdByKey.set(repoKey, repo.repo_id)
    }

    const capabilityKeys = [
      repo.repo_id,
      repo.path ? path.basename(repo.path) : null,
    ]

    for (const capabilityKey of capabilityKeys) {
      const clean = String(capabilityKey ?? '').trim().toLowerCase()
      if (clean && !repoIdByCapability.has(clean)) repoIdByCapability.set(clean, repo.repo_id)
    }
  }

  return {
    repoIdByKey,
    repoIdByCapability,
  }
}

function resolveWorkspaceRepoId({ repoUrl, capabilities }, repoIndex) {
  const repoKey = normaliseWorkspaceRepoUrl(repoUrl ?? '')
  if (repoKey && repoIndex.repoIdByKey.has(repoKey)) {
    return repoIndex.repoIdByKey.get(repoKey)
  }

  for (const capability of capabilities) {
    if (!capability.startsWith('repo:')) continue
    const repoName = capability.slice('repo:'.length).trim().toLowerCase()
    if (repoName && repoIndex.repoIdByCapability.has(repoName)) {
      return repoIndex.repoIdByCapability.get(repoName)
    }
  }

  return null
}

function previewText(input, max = 220) {
  const clean = String(input ?? '').replace(/\s+/g, ' ').trim()
  return truncateText(clean, max) ?? ''
}

async function loadWorkspaceSessions(apiUrl, token, config, repoIndex) {
  const response = await requestJson(apiUrl, '/api/cli/sessions', {
    method: 'GET',
    token,
  })

  if (!response.response.ok) {
    throw new Error(response.data.error ?? `List sessions failed (${response.response.status})`)
  }

  const localRuntimeIndex = buildLocalSessionRuntimeIndex(config)
  const sessions = Array.isArray(response.data.sessions) ? response.data.sessions : []

  return sessions
    .map(session => {
      const capabilities = parseCapabilities(session.capabilities)
      const repoId = resolveWorkspaceRepoId({
        repoUrl: session.repo_url,
        capabilities,
      }, repoIndex)

      if (!repoId) return null

      const runtime = inferSessionRuntime(session, localRuntimeIndex)
      return {
        session_id: session.session_id,
        name: session.name,
        repo_id: repoId,
        repo_url: session.repo_url,
        hex_id: session.hex_id,
        description: session.description,
        capabilities,
        runtime,
        mode: inferSessionMode(session, runtime),
        status: session.status,
        connected_at: session.connected_at,
        disconnected_at: session.disconnected_at,
        last_heartbeat: session.last_heartbeat,
      }
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.last_heartbeat ?? 0) - Number(left.last_heartbeat ?? 0))
}

async function loadWorkspaceInbox(apiUrl, token, sessions) {
  const results = await Promise.all(sessions.map(async (session) => {
    try {
      const response = await requestJson(apiUrl, '/api/cli/inbox', {
        method: 'POST',
        token,
        body: { session_id: session.session_id },
      })

      if (!response.response.ok) return []
      const messages = Array.isArray(response.data.messages) ? response.data.messages : []

      return messages.map(message => ({
        message_id: message.message_id,
        repo_id: session.repo_id,
        to_session_id: session.session_id,
        to_session_name: session.name,
        to_runtime: session.runtime,
        from_session_id: message.from_session_id,
        from_session_name: message.from_session_name,
        question: message.question,
        created_at: message.created_at,
      }))
    } catch {
      return []
    }
  }))

  return results
    .flat()
    .sort((left, right) => Number(right.created_at ?? 0) - Number(left.created_at ?? 0))
}

async function searchWorkspaceKnowledge(apiUrl, token, body) {
  const response = await requestJson(apiUrl, '/api/cli/knowledge/search', {
    method: 'POST',
    token,
    body,
  })

  if (!response.response.ok) {
    throw new Error(response.data.error ?? `Knowledge search failed (${response.response.status})`)
  }

  return Array.isArray(response.data.entries) ? response.data.entries : []
}

async function loadWorkspaceKnowledge(apiUrl, token, repoIndex) {
  const [candidateNotes, qaNotes] = await Promise.all([
    searchWorkspaceKnowledge(apiUrl, token, { status: 'candidate', limit: 100 }),
    searchWorkspaceKnowledge(apiUrl, token, { kind: 'qa', limit: 100 }),
  ])

  return [...candidateNotes, ...qaNotes]
    .map(note => {
      const repoId = repoIndex.repoIdByKey.get(note.repo_key) ?? null
      if (!repoId) return null

      return {
        id: note.id,
        repo_id: repoId,
        repo_key: note.repo_key,
        kind: note.kind,
        status: note.status,
        topic: note.topic,
        content: note.content,
        preview: previewText(note.content),
        tags: Array.isArray(note.tags) ? note.tags : [],
        source_refs: Array.isArray(note.source_refs) ? note.source_refs : [],
        confidence: note.confidence,
        freshness: note.freshness,
        session_name: note.session_name,
        created_at: note.created_at,
        updated_at: note.updated_at,
        verified_at: note.verified_at,
        expires_at: note.expires_at,
        capability: note.capability ?? null,
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftUpdated = Number(left.updated_at ?? left.created_at ?? 0)
      const rightUpdated = Number(right.updated_at ?? right.created_at ?? 0)
      return rightUpdated - leftUpdated
    })
}

async function loadWorkspaceRemoteSignals({ config, repos }) {
  const apiUrl = resolveApiUrl([], config)
  const token = resolveToken(config)

  if (!token) {
    return {
      auth: {
        status: 'logged_out',
        api_url: apiUrl,
        email: config.email ?? null,
        error: 'Run `hexgrid login` to load sessions, inbox, and shared knowledge.',
      },
      sessions: [],
      inbox: [],
      knowledge: [],
    }
  }

  const repoIndex = buildWorkspaceRepoIndex(repos)

  try {
    const sessions = await loadWorkspaceSessions(apiUrl, token, config, repoIndex)
    const [inbox, knowledge] = await Promise.all([
      loadWorkspaceInbox(apiUrl, token, sessions),
      loadWorkspaceKnowledge(apiUrl, token, repoIndex),
    ])

    return {
      auth: {
        status: 'connected',
        api_url: apiUrl,
        email: config.email ?? null,
        error: null,
      },
      sessions,
      inbox,
      knowledge,
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      auth: {
        status: 'error',
        api_url: apiUrl,
        email: config.email ?? null,
        error: detail,
      },
      sessions: [],
      inbox: [],
      knowledge: [],
    }
  }
}

function mergeWorkspaceRepoSignals(repos, remoteSignals) {
  const repoById = new Map(repos.map(repo => [repo.repo_id, {
    ...repo,
    repo_keys: buildWorkspaceRepoKeys(repo),
    active_sessions: [],
    pending_messages: [],
    knowledge_notes: [],
    candidate_notes: [],
    counts: {
      sessions: 0,
      pending_messages: 0,
      knowledge_notes: 0,
      candidate_notes: 0,
    },
    attention: [],
  }]))

  for (const session of remoteSignals.sessions) {
    const repo = repoById.get(session.repo_id)
    if (!repo) continue
    repo.active_sessions.push(session)
  }

  for (const message of remoteSignals.inbox) {
    const repo = repoById.get(message.repo_id)
    if (!repo) continue
    repo.pending_messages.push(message)
  }

  for (const note of remoteSignals.knowledge) {
    const repo = repoById.get(note.repo_id)
    if (!repo) continue
    repo.knowledge_notes.push(note)
    if (note.status === 'candidate') repo.candidate_notes.push(note)
  }

  const authConnected = remoteSignals.auth.status === 'connected'

  return repos.map(repo => {
    const merged = repoById.get(repo.repo_id)
    merged.active_sessions.sort((left, right) => Number(right.last_heartbeat ?? 0) - Number(left.last_heartbeat ?? 0))
    merged.pending_messages.sort((left, right) => Number(right.created_at ?? 0) - Number(left.created_at ?? 0))
    merged.knowledge_notes.sort((left, right) => Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0))
    merged.candidate_notes.sort((left, right) => Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0))

    merged.counts = {
      sessions: merged.active_sessions.length,
      pending_messages: merged.pending_messages.length,
      knowledge_notes: merged.knowledge_notes.length,
      candidate_notes: merged.candidate_notes.length,
    }

    if (!merged.path) {
      merged.attention.push('Repo path is not bound on this machine.')
    } else if (!merged.path_exists) {
      merged.attention.push('Repo path is missing or no longer accessible.')
    }

    if (merged.pending_messages.length > 0) {
      merged.attention.push(`${merged.pending_messages.length} pending message${merged.pending_messages.length === 1 ? '' : 's'} in the inbox.`)
    }

    if (merged.candidate_notes.length > 0) {
      merged.attention.push(`${merged.candidate_notes.length} candidate knowledge note${merged.candidate_notes.length === 1 ? '' : 's'} waiting for review.`)
    }

    if (authConnected && merged.local_session && merged.active_sessions.length === 0) {
      merged.attention.push('Local session cache exists, but the remote session is no longer active.')
    }

    if (authConnected) {
      if (merged.active_sessions.length > 0) merged.status = 'active'
      else if (merged.path && !merged.path_exists) merged.status = 'blocked'
      else if (merged.path) merged.status = 'idle'
      else merged.status = 'unknown'
    }

    return merged
  })
}

function buildWorkspaceAttention(repos, auth) {
  const items = []

  if (auth.status === 'logged_out') {
    items.push({
      severity: 'warn',
      repo_id: null,
      label: 'Remote visibility is off',
      detail: auth.error,
    })
  }

  if (auth.status === 'error') {
    items.push({
      severity: 'error',
      repo_id: null,
      label: 'Remote sync failed',
      detail: auth.error,
    })
  }

  for (const repo of repos) {
    if (!repo.path) {
      items.push({
        severity: 'error',
        repo_id: repo.repo_id,
        label: `${repo.repo_id} needs a local path`,
        detail: 'Re-run `hexgrid repo add <repo_id> --path ...` to bind this repo locally.',
      })
    } else if (!repo.path_exists) {
      items.push({
        severity: 'error',
        repo_id: repo.repo_id,
        label: `${repo.repo_id} path is missing`,
        detail: repo.path,
      })
    }

    if (repo.pending_messages.length > 0) {
      items.push({
        severity: 'warn',
        repo_id: repo.repo_id,
        label: `${repo.repo_id} has pending agent requests`,
        detail: `${repo.pending_messages.length} message${repo.pending_messages.length === 1 ? '' : 's'} waiting in the inbox.`,
      })
    }

    if (repo.candidate_notes.length > 0) {
      items.push({
        severity: 'info',
        repo_id: repo.repo_id,
        label: `${repo.repo_id} learned something new`,
        detail: `${repo.candidate_notes.length} candidate note${repo.candidate_notes.length === 1 ? '' : 's'} can be promoted into canonical knowledge.`,
      })
    }

    if (repo.managed_session?.status === 'errored') {
      items.push({
        severity: 'error',
        repo_id: repo.repo_id,
        label: `${repo.repo_id} managed session failed`,
        detail: repo.managed_session.error ?? 'The local PTY session exited with an error.',
      })
    }
  }

  return items
}

function mergeManagedSupervisorState(repos, sessions, supervisor) {
  if (!supervisor) {
    return {
      repos,
      sessions,
      managed_sessions: [],
    }
  }

  const managedSessions = supervisor.listSessions()
  const managedByRepo = new Map(managedSessions.map(session => [session.repo_id, session]))

  const nextRepos = repos.map(repo => {
    const managedSession = managedByRepo.get(repo.repo_id) ?? null
    const nextRepo = {
      ...repo,
      managed_session: managedSession,
    }

    if (!managedSession) return nextRepo

    if (['starting', 'running', 'stopping'].includes(managedSession.status) && nextRepo.status !== 'blocked') {
      nextRepo.status = 'active'
    }

    if (managedSession.status === 'starting') {
      nextRepo.attention = [
        `Managed ${managedSession.runtime} session is starting.`,
        ...nextRepo.attention,
      ]
    }

    if (managedSession.status === 'stopping') {
      nextRepo.attention = [
        'Managed session is stopping.',
        ...nextRepo.attention,
      ]
    }

    if (managedSession.status === 'errored') {
      nextRepo.attention = [
        `Managed session error: ${managedSession.error ?? 'unknown error'}`,
        ...nextRepo.attention,
      ]
    }

    if (managedSession.attached) {
      nextRepo.attention = [
        'Managed session is currently attached in this terminal.',
        ...nextRepo.attention,
      ]
    }

    return nextRepo
  })

  const nextSessions = sessions.map(session => {
    const managedSession = managedByRepo.get(session.repo_id)
    if (!managedSession) return session

    return {
      ...session,
      managed_status: managedSession.status,
      attached: managedSession.attached,
      local_error: managedSession.error,
      buffer_preview: managedSession.buffer_preview,
    }
  })

  const reposWithRemoteSessions = new Set(nextSessions.map(session => session.repo_id))
  for (const managedSession of managedSessions) {
    if (reposWithRemoteSessions.has(managedSession.repo_id)) continue
    if (managedSession.status === 'stopped' && !managedSession.error) continue

    nextSessions.push({
      session_id: managedSession.session_id ?? `local:${managedSession.repo_id}`,
      name: managedSession.name ?? `${managedSession.repo_id}-${managedSession.runtime}`,
      repo_id: managedSession.repo_id,
      repo_url: null,
      hex_id: managedSession.hex_id,
      description: managedSession.error,
      capabilities: [],
      runtime: managedSession.runtime,
      mode: 'interactive',
      status: managedSession.status === 'errored' ? 'errored' : 'active',
      connected_at: managedSession.started_at,
      disconnected_at: managedSession.exited_at,
      last_heartbeat: managedSession.last_output_at,
      managed_status: managedSession.status,
      attached: managedSession.attached,
      local_error: managedSession.error,
      buffer_preview: managedSession.buffer_preview,
    })
  }

  nextSessions.sort((left, right) => Number(right.last_heartbeat ?? right.connected_at ?? 0) - Number(left.last_heartbeat ?? left.connected_at ?? 0))

  return {
    repos: nextRepos,
    sessions: nextSessions,
    managed_sessions: managedSessions,
  }
}

async function buildWorkspaceRepoSummaries(manifest, localState, config) {
  const entries = Object.entries(manifest.repos ?? {}).sort(([left], [right]) => left.localeCompare(right))

  return Promise.all(entries.map(async ([repoId, repo]) => {
    const binding = localState.repos?.[repoId]
    const repoPath = typeof binding?.path === 'string' ? binding.path : null
    const pathExists = repoPath ? await fileExists(repoPath) : false
    const session = repoPath ? config.sessions?.[sessionKey(repoPath)] ?? null : null

    let status = 'unknown'
    if (session) status = 'active'
    else if (repoPath && pathExists) status = 'idle'
    else if (repoPath && !pathExists) status = 'blocked'

    return {
      repo_id: repoId,
      remote: repo.remote ?? null,
      description: repo.description ?? null,
      default_runtime: repo.defaultRuntime ?? null,
      listen: repo.listen ?? 'manual',
      path: repoPath,
      path_exists: pathExists,
      status,
      local_session: session ? {
        session_id: session.session_id,
        runtime: session.runtime,
        name: session.name,
        connected_at: session.connected_at,
      } : null,
    }
  }))
}

async function loadWorkspaceSnapshot({ supervisor = null } = {}) {
  const config = await loadConfig()
  const workspace = await resolveActiveWorkspace(config)
  const localState = getWorkspaceState(config, workspace.workspaceRoot)
  const baseRepos = await buildWorkspaceRepoSummaries(workspace.manifest, localState, config)
  const remoteSignals = await loadWorkspaceRemoteSignals({
    config,
    repos: baseRepos,
  })
  const mergedRepos = mergeWorkspaceRepoSignals(baseRepos, remoteSignals)
  const managedState = mergeManagedSupervisorState(
    mergedRepos,
    remoteSignals.sessions,
    supervisor,
  )
  const repos = managedState.repos
  const inbox = remoteSignals.inbox
  const knowledge = remoteSignals.knowledge
  const attention = buildWorkspaceAttention(repos, remoteSignals.auth)
  const activeSessionCount = managedState.sessions.filter(session =>
    session.status === 'active'
    || session.managed_status === 'starting'
    || session.managed_status === 'stopping',
  ).length

  return {
    workspace_root: workspace.workspaceRoot,
    workspace_name: workspace.manifest.name,
    repos,
    sessions: managedState.sessions,
    managed_sessions: managedState.managed_sessions,
    inbox,
    knowledge,
    attention,
    auth: remoteSignals.auth,
    counts: {
      active: repos.filter(repo => repo.status === 'active').length,
      blocked: repos.filter(repo => repo.status === 'blocked').length,
      active_sessions: activeSessionCount,
      managed_sessions: managedState.managed_sessions.filter(session => ['starting', 'running', 'stopping'].includes(session.status)).length,
      pending_messages: inbox.length,
      knowledge_notes: knowledge.length,
      candidate_notes: knowledge.filter(note => note.status === 'candidate').length,
      attention: attention.length,
    },
    refreshed_at: new Date(),
  }
}

async function resolveActiveWorkspace(config, { startDir = process.cwd(), required = true } = {}) {
  const localWorkspace = await loadWorkspaceManifest(startDir)
  if (localWorkspace) return localWorkspace

  const currentWorkspaceRoot = getCurrentWorkspaceRoot(config)
  if (currentWorkspaceRoot) {
    const currentWorkspace = await loadWorkspaceManifestFromRoot(currentWorkspaceRoot)
    if (currentWorkspace) return currentWorkspace
  }

  const configuredWorkspaces = listConfiguredWorkspaces(config)
  if (configuredWorkspaces.length === 1) {
    const onlyWorkspace = await loadWorkspaceManifestFromRoot(configuredWorkspaces[0].workspace_root)
    if (onlyWorkspace) return onlyWorkspace
  }

  if (!required) return null

  if (configuredWorkspaces.length > 1) {
    throw new Error('Multiple workspaces are configured, but no active workspace could be resolved from this directory.')
  }

  throw new Error('No workspace found. Run `hexgrid workspace init` in your workspace root first.')
}

async function commandWorkspace(args) {
  const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : 'status'
  const subArgs = subcommand === 'status' && (args[0]?.startsWith('-') ?? false) ? args : args.slice(1)

  if (subcommand === 'init') {
    const name = parseFlag(subArgs, '--name', null)
    const created = await initWorkspaceManifest(process.cwd(), name)
    const config = await loadConfig()
    const nextConfig = setCurrentWorkspace(config, created.workspaceRoot, created.manifest.name)
    await saveConfig(nextConfig)
    console.log(JSON.stringify({
      ok: true,
      workspace_root: created.workspaceRoot,
      manifest_path: created.manifestPath,
      workspace: created.manifest.name,
      repo_count: Object.keys(created.manifest.repos).length,
    }, null, 2))
    return
  }

  if (subcommand === 'status') {
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config)
    const localState = getWorkspaceState(config, workspace.workspaceRoot)
    const repos = await buildWorkspaceRepoSummaries(workspace.manifest, localState, config)

    console.log(JSON.stringify({
      ok: true,
      workspace_root: workspace.workspaceRoot,
      manifest_path: workspace.manifestPath,
      workspace: workspace.manifest.name,
      repo_count: repos.length,
      repos,
    }, null, 2))
    return
  }

  throw new Error(`Unsupported workspace command "${subcommand}". Use \`hexgrid workspace init\` or \`hexgrid workspace\`.`)
}

async function prepareManagedRepoLaunch({ repoId, runtime }) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl([], config)
  const token = resolveToken(config)
  await assertLoggedIn(apiUrl, token)
  await assertApiHealthy(apiUrl)

  const workspace = await resolveActiveWorkspace(config)
  const binding = getWorkspaceRepoBinding(config, workspace.workspaceRoot, repoId)
  const repoPath = typeof binding?.path === 'string' ? binding.path : null
  if (!repoPath) {
    throw new Error(`Repo "${repoId}" has no local path binding. Re-run \`hexgrid repo add ${repoId} --path ...\`.`)
  }
  if (!(await fileExists(repoPath))) {
    throw new Error(`Repo path does not exist: ${repoPath}`)
  }

  const repo = workspace.manifest.repos?.[repoId] ?? {}
  const selectedRuntime = parseRuntime(runtime ?? repo.defaultRuntime ?? 'codex', {
    allowAll: false,
    fallback: repo.defaultRuntime ?? 'codex',
  })
  const runtimeCommand = selectedRuntime === 'codex' ? 'codex' : 'claude'
  const commandPath = resolveCommandPath(runtimeCommand)
  if (!commandPath) {
    throw new Error(`Runtime "${runtimeCommand}" was not found in PATH.`)
  }

  return withWorkingDirectory(repoPath, async () => {
    const context = await detectRepoContext()
    await setupRuntimes({
      runtimes: [selectedRuntime],
      repoRoot: context.repoRoot,
      apiUrl,
      token,
    })

    const name = `${context.repoName}-${selectedRuntime}`
    const description = `${selectedRuntime} session for ${context.repoName} (${context.repoType})`
    const connected = await connectRepoSession({
      config,
      apiUrl,
      token,
      context,
      runtime: selectedRuntime,
      name,
      description,
    })
    const sessionId = connected.session_id

    return {
      repo_id: repoId,
      runtime: selectedRuntime,
      command: commandPath,
      args: [],
      cwd: context.repoRoot,
      env: {
        ...process.env,
        HEXGRID_API_KEY: token,
        HEXGRID_API_URL: apiUrl,
        HEXGRID_SESSION_ID: sessionId,
      },
      heartbeat_seconds: DEFAULT_HEARTBEAT_SECONDS,
      session_id: sessionId,
      hex_id: connected.hex_id,
      name,
      async heartbeat() {
        const heartbeat = await requestJson(apiUrl, '/api/cli/heartbeat', {
          method: 'POST',
          token,
          body: { session_id: sessionId },
        })
        if (!heartbeat.response.ok) {
          throw new Error(heartbeat.data.error ?? `Heartbeat failed (${heartbeat.response.status})`)
        }
        return heartbeat.data
      },
      async disconnect() {
        const latestConfig = await loadConfig()
        await disconnectRepoSession({
          config: latestConfig,
          apiUrl,
          token,
          sessionId,
          repoRoot: context.repoRoot,
        })
      },
    }
  })
}

async function commandTui() {
  const supervisor = createSessionSupervisor({
    prepareLaunch: prepareManagedRepoLaunch,
  })

  try {
    await runWorkspaceTui({
      loadSnapshot: () => loadWorkspaceSnapshot({ supervisor }),
      startRepo: async (repoId, runtime) => supervisor.startSession(repoId, runtime, {
        cols: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      }),
      attachRepo: async (repoId) => supervisor.attach(repoId, {
        stdin: process.stdin,
        stdout: process.stdout,
      }),
      stopRepo: async (repoId) => supervisor.stopSession(repoId),
    })
  } finally {
    await supervisor.shutdown()
  }
}

async function commandUi(args) {
  const requestedPort = parseFlag(args, '--port', null)
  const parsedPort = requestedPort == null ? 4681 : Number.parseInt(String(requestedPort), 10)
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error('Invalid port. Use `hexgrid ui --port <0-65535>`.')
  }

  const supervisor = createSessionSupervisor({
    prepareLaunch: prepareManagedRepoLaunch,
  })
  const loadSnapshot = () => loadWorkspaceSnapshot({ supervisor })

  // Fail fast if no workspace is active, so the browser UI doesn't boot into a blank error state.
  await loadSnapshot()

  let localUi = null
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (localUi) await localUi.close()
  }

  try {
    localUi = await startLocalUiServer({
      port: parsedPort,
      loadSnapshot,
      startRepo: async (repoId, runtime) => supervisor.startSession(repoId, runtime, {
        cols: 120,
        rows: 40,
      }),
      stopRepo: async (repoId) => supervisor.stopSession(repoId),
      supervisor,
    })

    const shouldOpen = !hasFlag(args, '--no-open')
    const opened = shouldOpen ? openBrowser(localUi.auth_url) : false

    console.log(`HexGrid Local UI: ${localUi.auth_url}`)
    if (shouldOpen && opened) {
      console.log('Opened browser for local UI.')
    } else if (shouldOpen) {
      console.log('Browser did not open automatically. Use the URL above.')
    }
    console.log('Press Ctrl+C to stop the local UI and managed sessions.')

    const handleSignal = () => {
      shutdown().catch(() => {})
    }

    process.on('SIGINT', handleSignal)
    process.on('SIGTERM', handleSignal)

    try {
      await localUi.waitUntilClosed()
    } finally {
      process.removeListener('SIGINT', handleSignal)
      process.removeListener('SIGTERM', handleSignal)
    }
  } finally {
    try {
      await localUi?.close()
    } catch {
      // Best-effort shutdown.
    }
    await supervisor.shutdown()
  }
}

async function commandRepo(args) {
  const subcommand = requireLeadingPositional(args, 'repo command')
  const subArgs = args.slice(1)

  if (subcommand === 'add') {
    const repoId = validateRepoId(requireLeadingPositional(subArgs, 'repo id'))
    const repoArgs = subArgs.slice(1)
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config)
    const existing = workspace.manifest.repos?.[repoId] ?? {}
    const existingBinding = getWorkspaceRepoBinding(config, workspace.workspaceRoot, repoId)
    const {
      repoRoot,
      remote,
      description,
      defaultRuntime,
      listen,
    } = await resolveRepoAddInput({
      workspace,
      repoId,
      repoArgs,
      existing,
      existingBinding,
    })

    const manifest = upsertWorkspaceRepo(workspace.manifest, repoId, {
      remote,
      description,
      defaultRuntime,
      listen,
    })
    await saveWorkspaceManifest(workspace.workspaceRoot, manifest)

    const nextConfig = upsertWorkspaceRepoBinding(
      config,
      workspace.workspaceRoot,
      manifest.name,
      repoId,
      repoRoot,
    )
    await saveConfig(nextConfig)

    console.log(JSON.stringify({
      ok: true,
      workspace_root: workspace.workspaceRoot,
      workspace: manifest.name,
      repo_id: repoId,
      path: repoRoot,
      remote,
      description,
      default_runtime: defaultRuntime,
      listen,
    }, null, 2))
    return
  }

  if (subcommand === 'list') {
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config)
    const localState = getWorkspaceState(config, workspace.workspaceRoot)
    const repos = await buildWorkspaceRepoSummaries(workspace.manifest, localState, config)

    console.log(JSON.stringify({
      ok: true,
      workspace_root: workspace.workspaceRoot,
      workspace: workspace.manifest.name,
      repos,
    }, null, 2))
    return
  }

  if (subcommand === 'run') {
    const repoId = validateRepoId(requireLeadingPositional(subArgs, 'repo id'))
    const repoArgs = subArgs.slice(1)
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config)
    const binding = getWorkspaceRepoBinding(config, workspace.workspaceRoot, repoId)
    const repoPath = typeof binding?.path === 'string' ? binding.path : null
    if (!repoPath) {
      throw new Error(`Repo "${repoId}" has no local path binding. Re-run \`hexgrid repo add ${repoId} --path ...\`.`)
    }
    if (!(await fileExists(repoPath))) {
      throw new Error(`Repo path does not exist: ${repoPath}`)
    }

    const repo = workspace.manifest.repos?.[repoId] ?? {}
    const { primary, passthrough } = splitPassthroughArgs(repoArgs)
    const runtime = parseRuntime(parseFlag(primary, '--runtime', repo.defaultRuntime ?? 'codex'), {
      allowAll: false,
      fallback: repo.defaultRuntime ?? 'codex',
    })
    const forwardedPrimary = stripFlagWithValue(primary, '--runtime')
    const forwardedArgs = [
      runtime,
      ...forwardedPrimary,
      ...(passthrough.length > 0 ? ['--', ...passthrough] : []),
    ]

    await withWorkingDirectory(repoPath, () => commandRun(forwardedArgs))
    return
  }

  if (subcommand === 'listen') {
    const repoId = validateRepoId(requireLeadingPositional(subArgs, 'repo id'))
    const repoArgs = subArgs.slice(1)
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config)
    const binding = getWorkspaceRepoBinding(config, workspace.workspaceRoot, repoId)
    const repoPath = typeof binding?.path === 'string' ? binding.path : null
    if (!repoPath) {
      throw new Error(`Repo "${repoId}" has no local path binding. Re-run \`hexgrid repo add ${repoId} --path ...\`.`)
    }
    if (!(await fileExists(repoPath))) {
      throw new Error(`Repo path does not exist: ${repoPath}`)
    }

    const runtime = parseFlag(repoArgs, '--runtime', 'claude')
    if (runtime && runtime.toLowerCase() !== 'claude') {
      throw new Error('Repo listeners currently support only `claude`.')
    }

    await withWorkingDirectory(repoPath, () => commandListen(stripFlagWithValue(repoArgs, '--runtime')))
    return
  }

  throw new Error(`Unsupported repo command "${subcommand}". Use add, list, run, or listen.`)
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

async function writeKnowledgeNote(apiUrl, token, body) {
  const write = await requestJson(apiUrl, '/api/cli/knowledge', {
    method: 'POST',
    token,
    body,
  })

  if (!write.response.ok) {
    throw new Error(write.data.error ?? `Knowledge write failed (${write.response.status})`)
  }

  return write.data
}

async function commandSetup(args) {
  const { primary } = splitPassthroughArgs(args)
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(primary, config)
  const token = resolveToken(config)
  if (!token) throw new Error('Not logged in. Run `hexgrid login` first.')

  await assertLoggedIn(apiUrl, token)
  await assertApiHealthy(apiUrl)

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

async function commandOnboard(args) {
  const config = await loadConfig()
  const apiUrl = resolveApiUrl(args, config)
  const token = resolveToken(config)
  await assertLoggedIn(apiUrl, token)
  await assertApiHealthy(apiUrl)

  const context = await detectRepoContext()
  const name = parseFlag(args, '--name', `${context.repoName}-onboard`)
  const description = parseFlag(
    args,
    '--description',
    `onboarding session for ${context.repoName}`,
  )

  const connected = await connectRepoSession({
    config,
    apiUrl,
    token,
    context,
    runtime: 'onboard',
    name,
    description,
  })

  const sessionId = connected.session_id

  try {
    const { analysis, notes } = await generateOnboardingNotes(context)
    const created = []
    const capability = `repo:${context.repoName}`

    for (const note of notes) {
      const result = await writeKnowledgeNote(apiUrl, token, {
        session_id: sessionId,
        repo_url: context.repoUrl,
        topic: note.topic,
        content: note.content,
        tags: note.tags,
        kind: note.kind,
        status: note.status,
        confidence: note.confidence,
        freshness: note.freshness,
        source_refs: note.source_refs,
        capability,
      })

      created.push({
        id: result.id,
        topic: result.topic,
        kind: result.kind,
        status: result.status,
      })
    }

    console.log(JSON.stringify({
      ok: true,
      repo: context.repoName,
      repo_url: context.repoUrl,
      session_id: sessionId,
      capability,
      created,
      needs_review: created.filter(note => note.status !== 'canonical').map(note => note.topic),
      summary: {
        repo_type: context.repoType,
        units: analysis.units.map(unit => ({
          path: unit.path,
          ecosystem: unit.ecosystem,
          frameworks: unit.frameworks,
        })),
        package_managers: analysis.packageManagers,
        languages: analysis.languages,
      },
    }, null, 2))
  } finally {
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
      console.error(`Warning: failed to disconnect onboarding session ${sessionId} (${detail})`)
    }
  }
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
  await assertLoggedIn(apiUrl, token)
  await assertApiHealthy(apiUrl)

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

  await assertLoggedIn(apiUrl, token)
  await assertApiHealthy(apiUrl)

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

  if (!command) {
    const config = await loadConfig()
    const workspace = await resolveActiveWorkspace(config, { required: false })
    if (workspace) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await commandTui()
      } else {
        await commandWorkspace([])
      }
      return
    }
    usage()
    return
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  if (command === 'workspace') {
    await commandWorkspace(args)
    return
  }
  if (command === 'tui') {
    await commandTui()
    return
  }
  if (command === 'ui') {
    await commandUi(args)
    return
  }
  if (command === 'repo') {
    await commandRepo(args)
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
  if (command === 'onboard') {
    await commandOnboard(args)
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
