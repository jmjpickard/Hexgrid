'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { fetchMe, type AgentSession } from '@/lib/api'
import ApiKeySetup from '@/components/ApiKeySetup'
import SessionPanel from '@/components/SessionPanel'
import KnowledgeExplorer from '@/components/KnowledgeExplorer'
import MessageFeed from '@/components/MessageFeed'
import NetworkStats from '@/components/NetworkStats'

const HexMap = dynamic(() => import('@/components/HexMap'), { ssr: false })

export default function Dashboard() {
  const [user, setUser] = useState<{ user_id: string; email: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSession, setSelectedSession] = useState<AgentSession | null>(null)
  const [tab, setTab] = useState<'map' | 'knowledge' | 'messages'>('map')

  useEffect(() => {
    fetchMe().then(u => {
      setUser(u)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: '#060a13' }}>
        <p className="text-slate-500 text-xs font-mono tracking-wider">LOADING</p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: '#060a13' }}>
        <div className="text-center">
          <p className="text-slate-400 text-sm font-mono mb-4">Sign in to access your dashboard</p>
          <a
            href="/"
            className="text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white px-4 py-2 transition-colors"
          >
            go to login
          </a>
        </div>
      </div>
    )
  }

  return (
    <main className="h-screen flex flex-col" style={{ background: '#060a13' }}>
      {/* Header */}
      <header className="flex-shrink-0 h-12 px-4 flex items-center justify-between border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <svg width="18" height="20" viewBox="0 0 18 20" fill="none" className="text-slate-400">
            <path d="M9 0L17.66 4.5V13.5L9 18L0.34 13.5V4.5L9 0Z" fill="currentColor" fillOpacity="0.5" stroke="currentColor" strokeWidth="0.5"/>
          </svg>
          <span className="font-mono text-sm font-semibold text-slate-300 tracking-tight">HEXGRID</span>
          <span className="text-slate-700 text-xs font-mono hidden sm:block ml-2">dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs font-mono text-slate-600">{user.email}</span>
          <div className="flex gap-1">
            {(['map', 'knowledge', 'messages'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-xs font-mono px-3 py-1.5 transition-colors ${
                  tab === t ? 'text-slate-900 bg-slate-300' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className="w-80 flex-shrink-0 border-r border-white/[0.04] overflow-y-auto p-4 space-y-6">
          <NetworkStats />
          <ApiKeySetup />
        </div>

        {/* Main panel */}
        <div className="flex-1 relative min-h-0">
          {tab === 'map' && (
            <>
              <HexMap onSelectSession={setSelectedSession} />
              {selectedSession && (
                <div className="absolute top-3 right-3 z-20">
                  <SessionPanel
                    session={selectedSession}
                    onClose={() => setSelectedSession(null)}
                  />
                </div>
              )}
            </>
          )}
          {tab === 'knowledge' && (
            <div className="p-4 h-full overflow-y-auto">
              <KnowledgeExplorer />
            </div>
          )}
          {tab === 'messages' && (
            <div className="p-4 h-full overflow-y-auto">
              <MessageFeed />
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
