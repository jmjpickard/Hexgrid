// HexGrid — Input Sanitisation
// CRITICAL: All task content passes through here before touching any agent.
// Prevents prompt injection attacks.

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|above|all)\s+instructions?/gi,
  /forget\s+(everything|all|previous|prior)/gi,
  /you\s+are\s+now\s+a/gi,
  /act\s+as\s+(if\s+you\s+(are|were)|a\s+different)/gi,
  /new\s+instructions?:/gi,
  /system\s*:\s*you/gi,
  /\[INST\]/gi,
  /<\/?s>/gi,            // Llama-style tokens
  /###\s*instruction/gi,
  /do\s+not\s+follow/gi,
  /override\s+(your|all|previous)/gi,
  /disregard\s+(your|all|previous)/gi,
  /jailbreak/gi,
  /DAN\s+mode/gi,
  /developer\s+mode/gi,
]

// Max lengths
const MAX_TASK_DESCRIPTION = 2000
const MAX_AGENT_NAME = 50
const MAX_DESCRIPTION = 200
const MAX_CAPABILITY_LENGTH = 50
const MAX_CAPABILITIES = 20

export interface SanitiseResult {
  clean: string
  flagged: boolean
  flags: string[]
  hash: string
}

// Sanitise task description before routing to provider agent
export async function sanitiseTaskDescription(raw: string): Promise<SanitiseResult> {
  const flags: string[] = []
  let clean = raw.trim()

  // Truncate
  if (clean.length > MAX_TASK_DESCRIPTION) {
    clean = clean.slice(0, MAX_TASK_DESCRIPTION)
    flags.push('truncated')
  }

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(clean)) {
      flags.push(`injection_pattern: ${pattern.source.slice(0, 30)}`)
    }
  }

  // Strip HTML/XML tags
  const withoutTags = clean.replace(/<[^>]*>/g, '')
  if (withoutTags !== clean) {
    flags.push('html_stripped')
    clean = withoutTags
  }

  // Strip hidden unicode (zero-width chars, RTL overrides etc)
  const withoutHidden = clean.replace(/[\u200B-\u200D\u202A-\u202E\uFEFF]/g, '')
  if (withoutHidden !== clean) {
    flags.push('hidden_unicode_stripped')
    clean = withoutHidden
  }

  // Hash the ORIGINAL for tamper evidence log
  const hash = await sha256(raw)

  return {
    clean,
    flagged: flags.some(f => f.startsWith('injection')),
    flags,
    hash,
  }
}

// Sanitise agent registration fields
export function sanitiseAgentName(name: string): string {
  return name
    .trim()
    .slice(0, MAX_AGENT_NAME)
    .replace(/[<>'"]/g, '')
    .replace(/\s+/g, ' ')
}

export function sanitiseDescription(desc: string): string {
  return desc
    .trim()
    .slice(0, MAX_DESCRIPTION)
    .replace(/[<>]/g, '')
}

export function sanitiseCapabilities(caps: string[]): string[] {
  return caps
    .slice(0, MAX_CAPABILITIES)
    .map(c => c.trim().toLowerCase().slice(0, MAX_CAPABILITY_LENGTH).replace(/[^a-z0-9_:-]/g, ''))
    .filter(c => c.length > 0)
}

// Validate email (basic)
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 200
}

// SHA-256 hash (Web Crypto API — available in Workers)
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export { sha256 }
