// HexGrid — Cloudflare Worker Entry Point

import { McpAgent } from 'agents/mcp'
import { createMcpServer } from './mcp'
import { getAllHexes } from './db/queries'
import { DOMAIN_COLOURS } from './lib/h3'
import type { Env } from './lib/types'

export class HexGridMCP extends McpAgent<Env> {
  server = createMcpServer(this.env)

  async init() {
    // Nothing extra needed — server created in constructor
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // ── CORS headers ──────────────────────────────────────────────────────────
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', service: 'hexgrid', version: '0.1.0' },
        { headers: corsHeaders }
      )
    }

    // ── MCP SSE endpoint ──────────────────────────────────────────────────────
    if (url.pathname === '/mcp' || url.pathname === '/sse') {
      return HexGridMCP.serve('/mcp').fetch(request, env)
    }

    // ── REST API for web frontend ─────────────────────────────────────────────

    // GET /api/hexes — all registered hexes (for map)
    if (url.pathname === '/api/hexes' && request.method === 'GET') {
      try {
        const hexes = await getAllHexes(env.DB)
        const data = hexes.map(h => ({
          hex_id: h.hex_id,
          agent_name: h.agent_name,
          description: h.description,
          domain: h.domain,
          reputation_score: h.reputation_score,
          total_tasks: h.total_tasks,
          price_per_task: h.price_per_task,
          colour: DOMAIN_COLOURS[h.domain as keyof typeof DOMAIN_COLOURS] ?? '#6B7280',
          created_at: h.created_at,
        }))
        return Response.json(data, { headers: corsHeaders })
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders })
      }
    }

    // GET /api/hexes/:id — single hex detail
    if (url.pathname.startsWith('/api/hexes/') && request.method === 'GET') {
      const hexId = url.pathname.replace('/api/hexes/', '')
      try {
        const { getHexById } = await import('./db/queries')
        const hex = await getHexById(env.DB, hexId)
        if (!hex) return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders })
        return Response.json(hex, { headers: corsHeaders })
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders })
      }
    }

    // POST /api/register — register a new hex (called from web form)
    if (url.pathname === '/api/register' && request.method === 'POST') {
      try {
        const body = await request.json()
        const { registerHex } = await import('./tools/register')
        const result = await registerHex(body, env)
        return Response.json(result, { headers: corsHeaders })
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400, headers: corsHeaders })
      }
    }

    // POST /api/discover — discover agents (called from web + agents)
    if (url.pathname === '/api/discover' && request.method === 'POST') {
      try {
        const body = await request.json()
        const { discoverAgents } = await import('./tools/discover')
        const result = await discoverAgents(body, env)
        return Response.json(result, { headers: corsHeaders })
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400, headers: corsHeaders })
      }
    }

    // GET /api/stats — network stats for homepage
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const hexes = await getAllHexes(env.DB)
        const byDomain = hexes.reduce((acc, h) => {
          acc[h.domain] = (acc[h.domain] ?? 0) + 1
          return acc
        }, {} as Record<string, number>)

        return Response.json({
          total_agents: hexes.length,
          total_tasks: hexes.reduce((sum, h) => sum + h.total_tasks, 0),
          avg_reputation: hexes.length
            ? Math.round(hexes.reduce((sum, h) => sum + h.reputation_score, 0) / hexes.length * 10) / 10
            : 0,
          by_domain: byDomain,
        }, { headers: corsHeaders })
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders })
      }
    }

    return Response.json(
      { error: 'Not found', hint: 'MCP endpoint is at /mcp' },
      { status: 404, headers: corsHeaders }
    )
  }
}
