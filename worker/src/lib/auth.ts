// HexGrid — Auth and secret utilities

const SESSION_COOKIE = 'hg_session'

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

export function generateOtpCode(length = 6): string {
  const digits = '0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, b => digits[b % 10]).join('')
}

export function generateToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return toBase64Url(raw)
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map(n => n.toString(16).padStart(2, '0')).join('')
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {}
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=')
      if (idx <= 0) return acc
      const key = decodeURIComponent(part.slice(0, idx).trim())
      const value = decodeURIComponent(part.slice(idx + 1).trim())
      acc[key] = value
      return acc
    }, {})
}

export function getSessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'))
  return cookies[SESSION_COOKIE] ?? null
}

export function buildSessionCookie(token: string, isProduction: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (isProduction) parts.push('Secure')
  return parts.join('; ')
}

export function buildSessionClearCookie(isProduction: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (isProduction) parts.push('Secure')
  return parts.join('; ')
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token.trim()
}

export function keyPrefix(key: string): string {
  return key.slice(0, 16)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

