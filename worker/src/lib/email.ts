// HexGrid — Email helpers

import type { Env } from './types'

export async function sendOtpEmail(env: Env, toEmail: string, code: string): Promise<'sent' | 'skipped'> {
  if (!env.RESEND_API_KEY) return 'skipped'

  const from = env.AUTH_FROM_EMAIL ?? 'HexGrid <auth@info.hexgrid.com>'
  const subject = 'Your HexGrid sign-in code'
  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #0f172a;">
      <h2 style="margin:0 0 12px 0;">HexGrid sign-in code</h2>
      <p style="margin:0 0 12px 0;">Use this code to sign in:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.15em; margin: 0 0 16px 0;">${escapeHtml(code)}</p>
      <p style="margin:0; color:#475569;">Code expires in 10 minutes.</p>
    </div>
  `

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject,
      html,
    }),
  })

  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`Failed to send auth email: ${res.status} ${errorText}`)
  }

  return 'sent'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

