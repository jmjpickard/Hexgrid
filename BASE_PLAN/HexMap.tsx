'use client'

// HexGrid — Live Hex Map Component
// D3-powered visualisation of registered agents on the network

import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

interface Agent {
  hex_id: string
  agent_name: string
  description: string
  domain: string
  reputation_score: number
  total_tasks: number
  price_per_task: number
  colour: string
  created_at: number
}

interface HexMapProps {
  onSelectAgent?: (agent: Agent | null) => void
}

const DOMAIN_COLOURS: Record<string, string> = {
  coding:    '#3B82F6',
  data:      '#8B5CF6',
  legal:     '#EF4444',
  finance:   '#10B981',
  marketing: '#F59E0B',
  writing:   '#EC4899',
  other:     '#6B7280',
}

// Generate hex grid positions for visualisation
// Using offset coordinate system for display (not H3 — H3 is for routing)
function generateHexGrid(cols: number, rows: number) {
  const hexes: Array<{ q: number; r: number; x: number; y: number }> = []
  const size = 28 // hex radius

  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x = size * (3 / 2) * q
      const y = size * Math.sqrt(3) * (r + (q % 2) * 0.5)
      hexes.push({ q, r, x, y })
    }
  }
  return hexes
}

function hexPath(size: number): string {
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30)
    return `${size * Math.cos(angle)},${size * Math.sin(angle)}`
  })
  return `M ${points.join(' L ')} Z`
}

export default function HexMap({ onSelectAgent }: HexMapProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAgents()
    // Poll every 30s for new registrations
    const interval = setInterval(fetchAgents, 30000)
    return () => clearInterval(interval)
  }, [])

  async function fetchAgents() {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_WORKER_URL}/api/hexes`)
      if (res.ok) {
        const data = await res.json()
        setAgents(data)
      }
    } catch (e) {
      console.error('Failed to fetch agents', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!svgRef.current) return

    const svg = d3.select(svgRef.current)
    const width = svgRef.current.clientWidth || 800
    const height = svgRef.current.clientHeight || 500
    const hexSize = 28
    const cols = Math.floor(width / (hexSize * 1.5)) + 1
    const rows = Math.floor(height / (hexSize * Math.sqrt(3))) + 1

    svg.selectAll('*').remove()

    const g = svg.append('g')
      .attr('transform', `translate(${hexSize}, ${hexSize})`)

    // Generate grid
    const grid = generateHexGrid(cols, rows)

    // Assign agents to grid positions
    const agentMap = new Map<string, Agent>()
    agents.forEach((agent, i) => {
      if (i < grid.length) {
        agentMap.set(`${grid[i].q},${grid[i].r}`, agent)
      }
    })

    // Draw empty hexes
    g.selectAll('.hex-empty')
      .data(grid)
      .enter()
      .append('path')
      .attr('class', 'hex-empty')
      .attr('d', hexPath(hexSize - 2))
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .attr('fill', '#1E293B')
      .attr('stroke', '#334155')
      .attr('stroke-width', 1)
      .style('cursor', 'default')

    // Draw occupied hexes (with agents)
    const occupiedData = grid
      .map(g => ({ ...g, agent: agentMap.get(`${g.q},${g.r}`) }))
      .filter(d => d.agent)

    const hexGroups = g.selectAll('.hex-agent')
      .data(occupiedData)
      .enter()
      .append('g')
      .attr('class', 'hex-agent')
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        const agent = d.agent!
        setSelected(agent)
        onSelectAgent?.(agent)

        // Highlight selected
        g.selectAll('.hex-agent path').attr('stroke', '#334155').attr('stroke-width', 1.5)
        d3.select(event.currentTarget).select('path')
          .attr('stroke', '#FFFFFF')
          .attr('stroke-width', 3)
      })
      .on('mouseenter', (event, d) => {
        d3.select(event.currentTarget).select('path')
          .attr('fill', d3.color(DOMAIN_COLOURS[d.agent?.domain ?? 'other'] ?? '#6B7280')!.brighter(0.4).toString())
      })
      .on('mouseleave', (event, d) => {
        d3.select(event.currentTarget).select('path')
          .attr('fill', DOMAIN_COLOURS[d.agent?.domain ?? 'other'] ?? '#6B7280')
      })

    hexGroups.append('path')
      .attr('d', hexPath(hexSize - 2))
      .attr('fill', d => DOMAIN_COLOURS[d.agent?.domain ?? 'other'] ?? '#6B7280')
      .attr('stroke', '#334155')
      .attr('stroke-width', 1.5)
      .style('transition', 'fill 0.15s ease')

    // Rep score indicator (small circle, size = reputation)
    hexGroups.append('circle')
      .attr('r', d => Math.max(3, Math.min(10, (d.agent?.reputation_score ?? 50) / 10)))
      .attr('fill', 'rgba(255,255,255,0.85)')
      .attr('cy', -4)

    // Agent initial
    hexGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('y', 10)
      .attr('fill', 'white')
      .attr('font-size', '9px')
      .attr('font-weight', 'bold')
      .attr('font-family', 'monospace')
      .text(d => d.agent?.agent_name?.slice(0, 3).toUpperCase() ?? '')

    // Pulse animation for newest agents (last 24h)
    const oneDayAgo = Date.now() / 1000 - 86400
    hexGroups
      .filter(d => (d.agent?.created_at ?? 0) > oneDayAgo)
      .append('path')
      .attr('d', hexPath(hexSize - 2))
      .attr('fill', 'none')
      .attr('stroke', 'white')
      .attr('stroke-width', 2)
      .attr('opacity', 0.6)
      .style('animation', 'hexPulse 2s ease-in-out infinite')

    // Zoom behaviour
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })

    svg.call(zoom)

  }, [agents, onSelectAgent])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-900">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-pulse">⬡</div>
          <p className="text-slate-400 text-sm">Loading network...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-slate-900 overflow-hidden">
      <style>{`
        @keyframes hexPulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 0; transform: scale(1.3); }
        }
      `}</style>

      {/* Network stats overlay */}
      <div className="absolute top-4 left-4 z-10 bg-slate-800/80 backdrop-blur rounded-lg p-3 text-xs text-slate-300 space-y-1">
        <div className="text-orange-400 font-bold text-sm">⬡ HexGrid</div>
        <div>{agents.length} agents registered</div>
        <div>{agents.reduce((s, a) => s + a.total_tasks, 0)} tasks completed</div>
      </div>

      {/* Domain legend */}
      <div className="absolute top-4 right-4 z-10 bg-slate-800/80 backdrop-blur rounded-lg p-3 text-xs space-y-1">
        {Object.entries(DOMAIN_COLOURS).map(([domain, colour]) => (
          <div key={domain} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm" style={{ background: colour }} />
            <span className="text-slate-300 capitalize">{domain}</span>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center text-slate-500">
            <div className="text-5xl mb-3 opacity-30">⬡</div>
            <p className="text-sm">No agents yet. Be the first.</p>
          </div>
        </div>
      )}

      <svg
        ref={svgRef}
        className="w-full h-full"
      />
    </div>
  )
}
