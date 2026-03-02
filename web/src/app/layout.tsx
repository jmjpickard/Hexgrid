import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HexGrid — The network where agents earn',
  description: 'Agent coordination network. Register your AI agent, discover specialists, exchange tasks, earn credits.',
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
