'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { fetchConnections, fetchSessions, type AgentSession, type Connection } from '@/lib/api'

interface HexMapProps {
  onSelectSession?: (session: AgentSession | null) => void
}

interface HexCluster {
  hex_id: string
  sessions: AgentSession[]
  primary: AgentSession
  lat: number
  lng: number
  x: number
  y: number
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

function rankSessions(a: AgentSession, b: AgentSession): number {
  if (b.last_heartbeat !== a.last_heartbeat) return b.last_heartbeat - a.last_heartbeat
  return b.connected_at - a.connected_at
}

function buildHexClusters(sessions: AgentSession[]): HexCluster[] {
  const grouped = new Map<string, AgentSession[]>()

  for (const session of [...sessions].sort(rankSessions)) {
    const list = grouped.get(session.hex_id)
    if (list) list.push(session)
    else grouped.set(session.hex_id, [session])
  }

  return Array.from(grouped.entries()).map(([hex_id, clusterSessions]) => {
    const primary = [...clusterSessions].sort(rankSessions)[0]
    return {
      hex_id,
      sessions: clusterSessions,
      primary: { ...primary, stack_count: clusterSessions.length },
      lat: primary.hex_center_lat,
      lng: primary.hex_center_lng,
      x: 0,
      y: 0,
    }
  })
}

function projectHexClusters(clusters: HexCluster[], width: number, height: number): HexCluster[] {
  const innerWidth = Math.max(width - HEX_SIZE * 2, HEX_SIZE * 6)
  const innerHeight = Math.max(height - HEX_SIZE * 2, HEX_SIZE * 6)

  if (clusters.length === 0) return []
  if (clusters.length === 1) {
    return [{ ...clusters[0], x: innerWidth / 2, y: innerHeight / 2 }]
  }

  const referenceLat = d3.mean(clusters, cluster => cluster.lat) ?? 0
  const projected = clusters.map(cluster => ({
    cluster,
    rawX: cluster.lng * Math.cos((referenceLat * Math.PI) / 180),
    rawY: -cluster.lat,
  }))

  const minX = d3.min(projected, point => point.rawX) ?? 0
  const maxX = d3.max(projected, point => point.rawX) ?? 0
  const minY = d3.min(projected, point => point.rawY) ?? 0
  const maxY = d3.max(projected, point => point.rawY) ?? 0

  const spanX = Math.max(maxX - minX, Number.EPSILON)
  const spanY = Math.max(maxY - minY, Number.EPSILON)
  const fitScale = Math.min((innerWidth * 0.35) / spanX, (innerHeight * 0.35) / spanY)

  let nearestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < projected.length; i++) {
    for (let j = i + 1; j < projected.length; j++) {
      const distance = Math.hypot(
        projected[i].rawX - projected[j].rawX,
        projected[i].rawY - projected[j].rawY,
      )
      if (distance > 0 && distance < nearestDistance) nearestDistance = distance
    }
  }

  const spacingScale = Number.isFinite(nearestDistance)
    ? (HEX_SIZE * 1.9) / nearestDistance
    : fitScale
  const scale = Number.isFinite(fitScale) && fitScale > 0
    ? Math.min(fitScale, spacingScale)
    : spacingScale

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  return projected.map(({ cluster, rawX, rawY }) => ({
    ...cluster,
    x: (rawX - centerX) * scale + innerWidth / 2,
    y: (rawY - centerY) * scale + innerHeight / 2,
  }))
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
      if (sessionsData.length === 0) onSelectSession?.(null)
    } catch (e) {
      console.error('Failed to fetch data', e)
    } finally {
      setLoading(false)
    }
  }, [onSelectSession])

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
    const innerWidth = Math.max(width - HEX_SIZE * 2, HEX_SIZE * 6)
    const innerHeight = Math.max(height - HEX_SIZE * 2, HEX_SIZE * 6)

    const hexW = Math.sqrt(3) * HEX_SIZE
    const hexH = 1.5 * HEX_SIZE
    const cols = Math.ceil(width / hexW) + 2
    const rows = Math.ceil(height / hexH) + 2

    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    const radGrad = defs.append('radialGradient')
      .attr('id', 'bg-vignette')
      .attr('cx', '50%')
      .attr('cy', '50%')
      .attr('r', '70%')
    radGrad.append('stop').attr('offset', '0%').attr('stop-color', '#0d1525').attr('stop-opacity', 1)
    radGrad.append('stop').attr('offset', '100%').attr('stop-color', '#060a13').attr('stop-opacity', 1)

    svg.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'url(#bg-vignette)')

    const g = svg.append('g')
      .attr('transform', `translate(${HEX_SIZE}, ${HEX_SIZE})`)

    const grid = generateHexGrid(cols, rows, HEX_SIZE)

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

    const clusteredSessions = projectHexClusters(buildHexClusters(sessions), width, height)

    const sessionPositionMap = new Map<string, { x: number; y: number; hex_id: string }>()
    clusteredSessions.forEach(cluster => {
      cluster.sessions.forEach(session => {
        sessionPositionMap.set(session.session_id, {
          x: cluster.x,
          y: cluster.y,
          hex_id: cluster.hex_id,
        })
      })
    })

    if (connections.length > 0) {
      const connectionLines = connections.filter(connection => {
        const from = sessionPositionMap.get(connection.session_a_id)
        const to = sessionPositionMap.get(connection.session_b_id)
        if (!from || !to) return false
        return from.hex_id !== to.hex_id
      })

      g.selectAll('.connection-line')
        .data(connectionLines)
        .enter()
        .append('path')
        .attr('class', 'connection-line')
        .attr('d', connection => {
          const from = sessionPositionMap.get(connection.session_a_id)!
          const to = sessionPositionMap.get(connection.session_b_id)!
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
        .attr('stroke-width', connection => Math.max(0.5, Math.min(3, connection.strength * 0.5)))
        .attr('stroke-opacity', connection =>
          connection.strength < 1 ? 0.2 : connection.strength > 5 ? 0.6 : 0.15 + connection.strength * 0.09,
        )
        .attr('stroke-linecap', 'round')
    }

    const glowFilter = defs.append('filter').attr('id', 'hex-glow')
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur')
    glowFilter.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'blur').attr('operator', 'over')

    const hexGroups = g.selectAll('.hex-session')
      .data(clusteredSessions)
      .enter()
      .append('g')
      .attr('class', 'hex-session')
      .attr('transform', cluster => `translate(${cluster.x}, ${cluster.y})`)
      .style('cursor', 'pointer')
      .on('click', (event, cluster) => {
        onSelectSession?.(cluster.primary)
        g.selectAll('.hex-session .hex-fill').attr('stroke', OCCUPIED_STROKE).attr('stroke-width', 1)
        const target = event.currentTarget as SVGGElement
        d3.select(target).select('.hex-fill')
          .attr('stroke', '#e2e8f0')
          .attr('stroke-width', 2)
      })
      .on('mouseenter', (event, cluster) => {
        const target = event.currentTarget as SVGGElement
        const baseColour = cluster.primary.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR
        const colour = d3.color(baseColour)
        d3.select(target).select('.hex-fill')
          .attr('fill', colour ? colour.brighter(0.5).toString() : baseColour)
      })
      .on('mouseleave', (event, cluster) => {
        const target = event.currentTarget as SVGGElement
        d3.select(target).select('.hex-fill')
          .attr('fill', cluster.primary.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
          .attr('fill-opacity', cluster.primary.status === 'active' ? 0.7 : 0.3)
      })

    hexGroups.append('path')
      .attr('d', hexPath(HEX_SIZE + 4))
      .attr('fill', cluster => cluster.primary.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
      .attr('fill-opacity', cluster => cluster.primary.status === 'active' ? 0.12 : 0.04)
      .attr('stroke', 'none')
      .attr('filter', 'url(#hex-glow)')

    hexGroups.append('path')
      .attr('class', 'hex-fill')
      .attr('d', hexPath(HEX_SIZE - 1))
      .attr('fill', cluster => cluster.primary.status === 'active' ? ACTIVE_COLOUR : DISCONNECTED_COLOUR)
      .attr('fill-opacity', cluster => cluster.primary.status === 'active' ? 0.7 : 0.3)
      .attr('stroke', OCCUPIED_STROKE)
      .attr('stroke-width', 1)
      .style('transition', 'fill 0.15s ease, fill-opacity 0.15s ease')

    hexGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('y', 1)
      .attr('fill', cluster => cluster.primary.status === 'active' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('font-family', "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace")
      .attr('letter-spacing', '0.5px')
      .text(cluster => cluster.primary.name.slice(0, 3).toUpperCase())

    const stackedHexes = hexGroups.filter(cluster => cluster.sessions.length > 1)

    stackedHexes.append('circle')
      .attr('cx', HEX_SIZE * 0.45)
      .attr('cy', -HEX_SIZE * 0.3)
      .attr('r', 10)
      .attr('fill', '#e2e8f0')
      .attr('fill-opacity', 0.95)

    stackedHexes.append('text')
      .attr('x', HEX_SIZE * 0.45)
      .attr('y', -HEX_SIZE * 0.3 + 0.5)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#0f172a')
      .attr('font-size', '10px')
      .attr('font-weight', '700')
      .attr('font-family', "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace")
      .text(cluster => cluster.sessions.length)

    hexGroups
      .filter(cluster => cluster.primary.status === 'active')
      .append('path')
      .attr('d', hexPath(HEX_SIZE - 1))
      .attr('fill', 'none')
      .attr('stroke', ACTIVE_COLOUR)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.5)
      .style('animation', 'hexPulse 3s ease-in-out infinite')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on('zoom', event => {
        g.attr('transform', event.transform)
      })

    svg.call(zoom)
    svg.call(zoom.transform, d3.zoomIdentity.translate(HEX_SIZE, HEX_SIZE))
  }, [connections, onSelectSession, sessions])

  return (
    <div className="relative w-full h-full overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-slate-500 text-xs font-mono tracking-wider">LOADING MAP</p>
        </div>
      )}

      <svg ref={svgRef} className="w-full h-full" style={{ minHeight: 500 }} />

      <div className="absolute bottom-3 left-3 flex items-center gap-4 text-[10px] font-mono uppercase tracking-wider">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: ACTIVE_COLOUR }} />
          <span className="text-slate-400">live hex</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: '#e2e8f0' }} />
          <span className="text-slate-500">shared repo hex</span>
        </div>
      </div>

      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <div className="text-slate-700 text-4xl mb-3">⬡</div>
            <p className="text-slate-600 text-sm font-mono">No active sessions</p>
            <p className="text-slate-700 text-xs font-mono mt-1">Connect a repo to claim a home hex.</p>
          </div>
        </div>
      )}
    </div>
  )
}
