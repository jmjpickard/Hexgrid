'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { fetchSessions, fetchConnections, type AgentSession, type Connection } from '@/lib/api'

interface HexMapProps {
  onSelectSession?: (session: AgentSession | null) => void
}

const ACTIVE_COLOUR = '#3B82F6'
const DISCONNECTED_COLOUR = '#374151'
const HEX_SIZE = 32
const EMPTY_FILL = '#0a1020'
const EMPTY_STROKE = 'rgba(148, 163, 184, 0.08)'
const OCCUPIED_STROKE = 'rgba(148, 163, 184, 0.15)'

function generateHexGrid(cols: number, rows: number, size: number) {
  const hexes: Array<{ q: number; r: number; x: number; y: number }> = []
  const w = Math.sqrt(3) * size
  const h = 1.5 * size
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x = w * (q + 0.5 * (r & 1))
      const y = h * r
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

export default function HexMap({ onSelectSession }: HexMapProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const [sessionsData, conns] = await Promise.all([
        fetchSessions(),
        fetchConnections(),
      ])
      setSessions(sessionsData)
      setConnections(conns)
    } catch (e) {
      console.error('Failed to fetch data', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => {
    if (!svgRef.current) return

    const svg = d3.select(svgRef.current)
    const width = svgRef.current.clientWidth || 800
    const height = svgRef.current.clientHeight || 600

    const hexW = Math.sqrt(3) * HEX_SIZE
    const hexH = 1.5 * HEX_SIZE
    const cols = Math.ceil(width / hexW) + 2
    const rows = Math.ceil(height / hexH) + 2

    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    const radGrad = defs.append('radialGradient')
      .attr('id', 'bg-vignette')
      .attr('cx', '50%').attr('cy', '50%').attr('r', '70%')
    radGrad.append('stop').attr('offset', '0%').attr('stop-color', '#0d1525').attr('stop-opacity', 1)
    radGrad.append('stop').attr('offset', '100%').attr('stop-color', '#060a13').attr('stop-opacity', 1)

    svg.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'url(#bg-vignette)')

    const g = svg.append('g')
      .attr('transform', `translate(${HEX_SIZE}, ${HEX_SIZE})`)

    const grid = generateHexGrid(cols, rows, HEX_SIZE)

    const centerQ = Math.floor(cols / 2)
    const centerR = Math.floor(rows / 2)

    const sortedGrid = [...grid].sort((a, b) => {
      const distA = Math.hypot(a.q - centerQ, a.r - centerR)
      const distB = Math.hypot(b.q - centerQ, b.r - centerR)
      return distA - distB
    })

    const sessionMap = new Map<string, AgentSession>()
    sessions.forEach((session, i) => {
      if (i < sortedGrid.length) {
        const cell = sortedGrid[i]
        sessionMap.set(`${cell.q},${cell.r}`, session)
      }
    })

    // Empty hexes
    g.selectAll('.hex-empty')
      .data(grid)
      .enter()
      .append('path')
      .attr('class', 'hex-empty')
      .attr('d', hexPath(HEX_SIZE - 1))
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .attr('fill', EMPTY_FILL)
      .attr('stroke', EMPTY_STROKE)
      .attr('stroke-width', 0.5)

    // Session position lookup for connection lines
    const sessionPositionMap = new Map<string, { x: number; y: number }>()
    sessions.forEach((session, i) => {
      if (i < sortedGrid.length) {
        const cell = sortedGrid[i]
        sessionPositionMap.set(session.session_id, { x: cell.x, y: cell.y })
      }
    })

    // Connection lines
    if (connections.length > 0) {
      const connectionLines = connections.filter(
        c => sessionPositionMap.has(c.session_a_id) && sessionPositionMap.has(c.session_b_id)
      )

      g.selectAll('.connection-line')
        .data(connectionLines)
        .enter()
        .append('path')
        .attr('class', 'connection-line')
        .attr('d', c => {
          const from = sessionPositionMap.get(c.session_a_id)!
          const to = sessionPositionMap.get(c.session_b_id)!
          const mx = (from.x + to.x) / 2
          const my = (from.y + to.y) / 2
          const dx = to.x - from.x
          const dy = to.y - from.y
          const len = Math.hypot(dx, dy) || 1
          const offset = Math.min(len * 0.15, 20)
          const cx = mx + (-dy / len) * offset
          const cy = my + (dx / len) * offset
          return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
        })
        .attr('fill', 'none')
        .attr('stroke', 'rgba(59, 130, 246, 0.4)')
        .attr('stroke-width', c => Math.max(0.5, Math.min(3, c.strength * 0.5)))
        .attr('stroke-opacity', c => c.strength < 1 ? 0.2 : c.strength > 5 ? 0.6 : 0.15 + c.strength * 0.09)
        .attr('stroke-linecap', 'round')
    }

    // Occupied hexes
    const occupiedData = grid
      .map(cell => ({ ...cell, session: sessionMap.get(`${cell.q},${cell.r}`) }))
      .filter((d): d is typeof d & { session: AgentSession } => d.session !== undefined)

    const glowFilter = defs.append('filter').attr('id', 'hex-glow')
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur')
    glowFilter.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'blur').attr('operator', 'over')

    const hexGroups = g.selectAll('.hex-session')
      .data(occupiedData)
      .enter()
      .append('g')
      .attr('class', 'hex-session')
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        onSelectSession?.(d.session)
        g.selectAll('.hex-session .hex-fill').attr('stroke', OCCUPIED_STROKE).attr('stroke-width', 1)
        const target = _event.currentTarget as SVGGElement
        d3.select(target).select('.hex-fill')
          .attr('stroke', '#e2e8f0')
          .attr('stroke-width', 2)
      })
      .on('mouseenter', (_event, d) => {
        const target = _event.currentTarget as SVGGElement
        const baseColour = d.session.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR
        const colour = d3.color(baseColour)
        d3.select(target).select('.hex-fill')
          .attr('fill', colour ? colour.brighter(0.5).toString() : baseColour)
      })
      .on('mouseleave', (_event, d) => {
        const target = _event.currentTarget as SVGGElement
        d3.select(target).select('.hex-fill')
          .attr('fill', d.session.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
          .attr('fill-opacity', d.session.status === 'active' ? 0.7 : 0.3)
      })

    // Glow layer
    hexGroups.append('path')
      .attr('d', hexPath(HEX_SIZE + 4))
      .attr('fill', d => d.session.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
      .attr('fill-opacity', d => d.session.status === 'active' ? 0.12 : 0.04)
      .attr('stroke', 'none')
      .attr('filter', 'url(#hex-glow)')

    // Hex fill
    hexGroups.append('path')
      .attr('class', 'hex-fill')
      .attr('d', hexPath(HEX_SIZE - 1))
      .attr('fill', d => d.session.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
      .attr('fill-opacity', d => d.session.status === 'active' ? 0.7 : 0.3)
      .attr('stroke', OCCUPIED_STROKE)
      .attr('stroke-width', 1)
      .style('transition', 'fill 0.15s ease, fill-opacity 0.15s ease')

    // Session name label
    hexGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('y', 1)
      .attr('fill', d => d.session.status === 'active' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('font-family', "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace")
      .attr('letter-spacing', '0.5px')
      .text(d => d.session.name.slice(0, 3).toUpperCase())

    // Pulse for active sessions
    hexGroups
      .filter(d => d.session.status === 'active')
      .append('path')
      .attr('d', hexPath(HEX_SIZE - 1))
      .attr('fill', 'none')
      .attr('stroke', ACTIVE_COLOUR)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.5)
      .style('animation', 'hexPulse 3s ease-in-out infinite')

    // Zoom + pan
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })

    svg.call(zoom)

    if (sessions.length > 0 && sortedGrid.length > 0) {
      const firstSession = sortedGrid[0]
      const offsetX = width / 2 - firstSession.x - HEX_SIZE
      const offsetY = height / 2 - firstSession.y - HEX_SIZE
      svg.call(zoom.transform, d3.zoomIdentity.translate(offsetX, offsetY))
    }

  }, [sessions, connections, onSelectSession])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#060a13' }}>
        <div className="text-center">
          <div className="hex-loader mb-4" />
          <p className="text-slate-500 text-xs font-mono tracking-wider">LOADING GRID</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: '#060a13' }}>
      <style>{`
        @keyframes hexPulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 0; transform: scale(1.4); }
        }
        @keyframes hexSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .hex-loader {
          width: 32px;
          height: 32px;
          border: 2px solid rgba(148, 163, 184, 0.1);
          border-top-color: rgba(148, 163, 184, 0.4);
          border-radius: 50%;
          animation: hexSpin 1s linear infinite;
          margin: 0 auto;
        }
      `}</style>

      {/* Status legend */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-3 text-xs font-mono">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: ACTIVE_COLOUR, opacity: 0.7 }} />
          <span className="text-slate-600">active</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: DISCONNECTED_COLOUR, opacity: 0.5 }} />
          <span className="text-slate-600">disconnected</span>
        </div>
      </div>

      {/* Empty state */}
      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center">
            <p className="text-slate-600 text-sm font-mono">No active sessions</p>
            <p className="text-slate-700 text-xs font-mono mt-1">Connect an agent to get started</p>
          </div>
        </div>
      )}

      <svg ref={svgRef} className="w-full h-full" />
    </div>
  )
}
