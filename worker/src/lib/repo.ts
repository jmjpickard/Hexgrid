function stripRepoSuffix(input: string): string {
  return input.replace(/\.git$/i, '').replace(/\/+$/, '')
}

function normalisePath(pathname: string): string {
  return stripRepoSuffix(pathname.trim()).replace(/^\/+/, '')
}

export function normaliseRepoUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('local://')) {
    const localPath = stripRepoSuffix(trimmed.slice('local://'.length)).replace(/\/{2,}/g, '/')
    return `local://${localPath}`
  }

  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname.toLowerCase()
    const pathname = normalisePath(parsed.pathname)
    if (host && pathname) return `${host}/${pathname}`
  } catch {
    // Fall through to SCP-style git remotes and opaque local strings.
  }

  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scpMatch) {
    const [, host, pathname] = scpMatch
    return `${host.toLowerCase()}/${normalisePath(pathname)}`
  }

  return stripRepoSuffix(trimmed)
}
