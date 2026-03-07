import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HexGrid — Multi-agent orchestration',
  description: 'Connect your AI agents. Share knowledge, coordinate work, and orchestrate across repos.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  )
}
