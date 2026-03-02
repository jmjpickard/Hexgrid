// HexGrid — H3 Spatial Helpers
// Uber H3 hexagonal grid for agent positioning
// Falls back to domain-prefixed UUIDs if h3-js fails in CF Workers

import type { Domain } from './types'

let h3Available = true
let latLngToCell: (lat: number, lng: number, res: number) => string
let cellToLatLng: (h3Index: string) => [number, number]
let gridDisk: (h3Index: string, k: number) => string[]
let isPentagon: (h3Index: string) => boolean

try {
  const h3 = await import('h3-js')
  latLngToCell = h3.latLngToCell
  cellToLatLng = h3.cellToLatLng
  gridDisk = h3.gridDisk
  isPentagon = h3.isPentagon
} catch {
  h3Available = false
  latLngToCell = () => ''
  cellToLatLng = () => [0, 0]
  gridDisk = () => []
  isPentagon = () => false
}

// Resolution 3 gives ~12k cells globally, good balance for our clustering
const RESOLUTION = 3

// Domain cluster centres — lat/lng coordinates that map to different H3 regions
const DOMAIN_CENTRES: Record<Domain, [number, number]> = {
  coding:    [51.5074,  -0.1278],   // London
  data:      [37.7749, -122.4194],  // San Francisco
  legal:     [40.7128,  -74.0060],  // New York
  finance:   [1.3521,   103.8198],  // Singapore
  marketing: [48.8566,    2.3522],  // Paris
  writing:   [35.6762,  139.6503],  // Tokyo
  other:     [52.3676,    4.9041],  // Amsterdam
}

// Get the base H3 cell for a domain cluster
export function getDomainBaseCell(domain: Domain): string {
  if (!h3Available) return domain
  const [lat, lng] = DOMAIN_CENTRES[domain]
  return latLngToCell(lat, lng, RESOLUTION)
}

// Assign a hex to an agent within a domain cluster
export async function assignHex(
  domain: Domain,
  occupiedHexes: Set<string>
): Promise<string> {
  if (!h3Available) {
    // Fallback: domain-prefixed UUID
    return `${domain}-${crypto.randomUUID().slice(0, 12)}`
  }

  const base = getDomainBaseCell(domain)

  // Search outward in rings until we find a free hex
  for (let ring = 0; ring <= 10; ring++) {
    const cells = gridDisk(base, ring)
    for (const cell of cells) {
      if (!occupiedHexes.has(cell) && !isPentagon(cell)) {
        return cell
      }
    }
  }

  // Fallback — generate a unique ID (should never happen at MVP scale)
  return `${base}-overflow-${Date.now()}`
}

// Get the 6 neighbours of a hex
export function getNeighbours(hexId: string): string[] {
  if (!h3Available) return []
  try {
    return gridDisk(hexId, 1).filter(h => h !== hexId)
  } catch {
    return []
  }
}

// Check if two hexes are neighbours (within 1 hop)
export function areNeighbours(hex1: string, hex2: string): boolean {
  return getNeighbours(hex1).includes(hex2)
}

// Get the lat/lng centre of a hex (for map rendering)
export function getHexCentre(hexId: string): [number, number] {
  if (!h3Available) return [0, 0]
  try {
    const [lat, lng] = cellToLatLng(hexId)
    return [lat, lng]
  } catch {
    return [0, 0]
  }
}

// Domain colour map for visualisation
export const DOMAIN_COLOURS: Record<Domain, string> = {
  coding:    '#3B82F6', // blue
  data:      '#8B5CF6', // purple
  legal:     '#EF4444', // red
  finance:   '#10B981', // green
  marketing: '#F59E0B', // amber
  writing:   '#EC4899', // pink
  other:     '#6B7280', // gray
}
