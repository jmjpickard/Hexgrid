import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

export const WORKSPACE_MANIFEST_FILE = 'hexgrid.workspace.json'
const VALID_LISTEN_MODES = new Set(['auto', 'manual', 'off'])

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function canonicalPath(targetPath) {
  const absolutePath = path.resolve(targetPath)
  try {
    return await realpath(absolutePath)
  } catch {
    return absolutePath
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normaliseOnboardingState(onboarding) {
  if (!isPlainObject(onboarding)) return null

  const next = {}
  const status = typeof onboarding.status === 'string' ? onboarding.status.trim().toLowerCase() : ''
  if (status) next.status = status

  for (const key of ['started_at', 'completed_at', 'updated_at']) {
    if (Number.isInteger(onboarding[key])) next[key] = onboarding[key]
  }

  if (typeof onboarding.error === 'string' && onboarding.error.trim()) {
    next.error = onboarding.error.trim()
  }

  return Object.keys(next).length > 0 ? next : null
}

function normaliseWorkspaceRepoBindingRecord(input) {
  if (typeof input === 'string' && input.trim()) {
    return { path: path.resolve(input.trim()) }
  }

  if (!isPlainObject(input)) return {}

  const next = {}
  for (const key of ['path', 'source_path', 'seed_file']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      next[key] = path.resolve(input[key].trim())
    }
  }

  if (typeof input.source_kind === 'string' && input.source_kind.trim()) {
    next.source_kind = input.source_kind.trim().toLowerCase()
  }

  const onboarding = normaliseOnboardingState(input.onboarding)
  if (onboarding) next.onboarding = onboarding

  return next
}

function normaliseRepoRecord(repo) {
  if (!isPlainObject(repo)) return {}

  const next = {}
  if (typeof repo.remote === 'string' && repo.remote.trim()) next.remote = repo.remote.trim()
  if (typeof repo.description === 'string' && repo.description.trim()) next.description = repo.description.trim()
  if (typeof repo.defaultRuntime === 'string' && repo.defaultRuntime.trim()) {
    next.defaultRuntime = repo.defaultRuntime.trim().toLowerCase()
  }
  if (typeof repo.listen === 'string' && repo.listen.trim()) {
    next.listen = normaliseListenMode(repo.listen)
  }
  if (Array.isArray(repo.dependsOn)) {
    next.dependsOn = repo.dependsOn.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  }
  if (isPlainObject(repo.startup)) {
    const startup = {}
    if (typeof repo.startup.command === 'string' && repo.startup.command.trim()) {
      startup.command = repo.startup.command.trim()
    }
    if (typeof repo.startup.health === 'string' && repo.startup.health.trim()) {
      startup.health = repo.startup.health.trim()
    }
    if (Object.keys(startup).length > 0) next.startup = startup
  }

  return next
}

function normaliseManifest(raw, fallbackName) {
  const repos = isPlainObject(raw?.repos) ? raw.repos : {}
  const nextRepos = {}

  for (const [repoId, repo] of Object.entries(repos)) {
    nextRepos[repoId] = normaliseRepoRecord(repo)
  }

  return {
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName,
    version: Number.isInteger(raw?.version) ? raw.version : 1,
    repos: nextRepos,
  }
}

export function createWorkspaceManifest(name, { version = 1 } = {}) {
  return {
    name,
    version,
    repos: {},
  }
}

export function normaliseListenMode(mode, fallback = 'manual') {
  if (mode == null) return fallback
  const value = String(mode).trim().toLowerCase()
  if (!value) return fallback
  if (!VALID_LISTEN_MODES.has(value)) {
    throw new Error(`Unsupported listen mode "${mode}". Use auto, manual, or off.`)
  }
  return value
}

export async function findWorkspaceRoot(startDir = process.cwd()) {
  let current = await canonicalPath(startDir)

  while (true) {
    const manifestPath = path.join(current, WORKSPACE_MANIFEST_FILE)
    if (await fileExists(manifestPath)) {
      return { workspaceRoot: current, manifestPath }
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function loadWorkspaceManifest(startDir = process.cwd()) {
  const found = await findWorkspaceRoot(startDir)
  if (!found) return null

  return loadWorkspaceManifestFromRoot(found.workspaceRoot)
}

export async function loadWorkspaceManifestFromRoot(workspaceRoot) {
  const canonicalRoot = await canonicalPath(workspaceRoot)
  const manifestPath = path.join(canonicalRoot, WORKSPACE_MANIFEST_FILE)
  if (!(await fileExists(manifestPath))) return null

  const raw = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(raw)
  const manifest = normaliseManifest(parsed, path.basename(canonicalRoot))

  return {
    workspaceRoot: canonicalRoot,
    manifestPath,
    manifest,
  }
}

export async function initWorkspaceManifest(startDir = process.cwd(), name = null) {
  const initialRoot = path.resolve(startDir)
  await mkdir(initialRoot, { recursive: true })
  const workspaceRoot = await canonicalPath(initialRoot)
  const manifestPath = path.join(workspaceRoot, WORKSPACE_MANIFEST_FILE)

  if (await fileExists(manifestPath)) {
    throw new Error(`Workspace already exists at ${manifestPath}`)
  }

  const manifest = createWorkspaceManifest(
    typeof name === 'string' && name.trim() ? name.trim() : path.basename(workspaceRoot),
  )

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    workspaceRoot,
    manifestPath,
    manifest,
  }
}

export async function saveWorkspaceManifest(workspaceRoot, manifest) {
  const manifestPath = path.join(workspaceRoot, WORKSPACE_MANIFEST_FILE)
  const normalised = normaliseManifest(manifest, path.basename(workspaceRoot))
  await writeFile(manifestPath, `${JSON.stringify(normalised, null, 2)}\n`)
  return {
    workspaceRoot,
    manifestPath,
    manifest: normalised,
  }
}

export function ensureWorkspaceState(config, workspaceRoot, workspaceName = null) {
  const workspaces = isPlainObject(config?.workspaces) ? { ...config.workspaces } : {}
  const existing = isPlainObject(workspaces[workspaceRoot]) ? workspaces[workspaceRoot] : {}
  const repos = isPlainObject(existing.repos)
    ? Object.fromEntries(
        Object.entries(existing.repos)
          .filter(([, repo]) => isPlainObject(repo))
          .map(([repoId, repo]) => [repoId, normaliseWorkspaceRepoBindingRecord(repo)]),
      )
    : {}

  workspaces[workspaceRoot] = {
    ...existing,
    name: workspaceName ?? existing.name ?? path.basename(workspaceRoot),
    repos,
  }

  return {
    ...(config ?? {}),
    workspaces,
  }
}

export function getWorkspaceState(config, workspaceRoot) {
  if (!isPlainObject(config?.workspaces?.[workspaceRoot])) {
    return {
      name: null,
      repos: {},
    }
  }

  const workspace = config.workspaces[workspaceRoot]
  return {
    name: typeof workspace.name === 'string' ? workspace.name : null,
    repos: isPlainObject(workspace.repos) ? workspace.repos : {},
  }
}

export function upsertWorkspaceRepoBinding(config, workspaceRoot, workspaceName, repoId, repoBinding) {
  const next = ensureWorkspaceState(config, workspaceRoot, workspaceName)
  const currentWorkspace = next.workspaces[workspaceRoot]
  const currentRepo = isPlainObject(currentWorkspace.repos[repoId]) ? currentWorkspace.repos[repoId] : {}
  const normalisedBinding = normaliseWorkspaceRepoBindingRecord(repoBinding)

  currentWorkspace.repos[repoId] = {
    ...currentRepo,
    ...normalisedBinding,
  }

  return next
}

export function getWorkspaceRepoBinding(config, workspaceRoot, repoId) {
  const state = getWorkspaceState(config, workspaceRoot)
  const repo = state.repos[repoId]
  if (!isPlainObject(repo)) return null
  return normaliseWorkspaceRepoBindingRecord(repo)
}

export function removeWorkspaceRepoBinding(config, workspaceRoot, workspaceName, repoId) {
  const next = ensureWorkspaceState(config, workspaceRoot, workspaceName)
  const currentWorkspace = next.workspaces[workspaceRoot]
  if (isPlainObject(currentWorkspace.repos)) {
    delete currentWorkspace.repos[repoId]
  }
  return next
}

export function getCurrentWorkspaceRoot(config) {
  if (typeof config?.current_workspace_root !== 'string') return null
  const value = config.current_workspace_root.trim()
  return value || null
}

export function listConfiguredWorkspaces(config) {
  if (!isPlainObject(config?.workspaces)) return []

  return Object.entries(config.workspaces)
    .filter(([, workspace]) => isPlainObject(workspace))
    .map(([workspaceRoot, workspace]) => ({
      workspace_root: workspaceRoot,
      name: typeof workspace.name === 'string' ? workspace.name : path.basename(workspaceRoot),
    }))
}

export function setCurrentWorkspace(config, workspaceRoot, workspaceName = null) {
  const next = ensureWorkspaceState(config, workspaceRoot, workspaceName)
  return {
    ...next,
    current_workspace_root: workspaceRoot,
  }
}

export function upsertWorkspaceRepo(manifest, repoId, repoData) {
  const next = normaliseManifest(manifest, manifest?.name ?? 'workspace')
  next.repos[repoId] = {
    ...(isPlainObject(next.repos[repoId]) ? next.repos[repoId] : {}),
    ...normaliseRepoRecord(repoData),
  }
  return next
}

export function removeWorkspaceRepo(manifest, repoId) {
  const next = normaliseManifest(manifest, manifest?.name ?? 'workspace')
  delete next.repos[repoId]
  return next
}
