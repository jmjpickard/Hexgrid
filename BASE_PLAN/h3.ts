// HexGrid — H3 Spatial Helpers
// Uber H3 hexagonal grid for agent positioning

import { latLngToCell, cellToLatLng, gridDisk, isPentagon } from 'h3-js'
import type { Domain } from './types'

// Resolution 3 gives ~12k cells globally, good balance for our clustering
const RESOLUTION = 3

// Domain cluster centres — lat/lng coordinates that map to different H3 regions
// These spread domains across the globe so clusters are spatially distinct
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
  const [lat, lng] = DOMAIN_CENTRES[domain]
  return latLngToCell(lat, lng, RESOLUTION)
}

// Assign a hex to an agent within a domain cluster
// Finds the nearest unoccupied cell to the cluster centre
export async function assignHex(
  domain: Domain,
  occupiedHexes: Set<string>
): Promise<string> {
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
  try {
    const [lat, lng] = cellToLatLng(hexId)
    return [lat, lng]
  } catch {
    return [0, 0]
  }
}

// Determine if a hex is a "border hex" (neighbours from multiple domains)
// Border hexes get special highlighting in the explorer
export function isBorderHex(
  hexId: string,
  hexDomainMap: Map<string, Domain>
): boolean {
  const thisDomain = hexDomainMap.get(hexId)
  if (!thisDomain) return false

  const neighbours = getNeighbours(hexId)
  const neighbourDomains = neighbours
    .map(h => hexDomainMap.get(h))
    .filter(Boolean) as Domain[]

  const uniqueDomains = new Set(neighbourDomains)
  uniqueDomains.delete(thisDomain)

  return uniqueDomains.size > 0
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
