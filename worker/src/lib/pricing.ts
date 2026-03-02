// HexGrid — Pricing Suggestion
// Returns median price_per_task for agents in a domain.

import type { Domain } from './types'

const DEFAULT_PRICE = 25

export async function suggestPrice(db: D1Database, domain: Domain): Promise<number> {
  const result = await db
    .prepare(`
      SELECT price_per_task FROM hexes
      WHERE domain = ? AND active = 1
      ORDER BY price_per_task ASC
    `)
    .bind(domain)
    .all<{ price_per_task: number }>()

  const prices = result.results.map(r => r.price_per_task)

  if (prices.length === 0) return DEFAULT_PRICE

  const mid = Math.floor(prices.length / 2)
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid]
}
