// HexGrid — H3 Spatial Helpers
// Uber H3 hexagonal grid for agent/session positioning

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

// Resolution 3 gives ~12k cells globally
const RESOLUTION = 3

// Default cluster centre for sessions (London)
const DEFAULT_CENTRE: [number, number] = [51.5074, -0.1278]

// Assign a hex to a session
export async function assignHex(
  _domain: string,
  occupiedHexes: Set<string>,
): Promise<string> {
  if (!h3Available) {
    return `hex-${crypto.randomUUID().slice(0, 12)}`
  }

  const [lat, lng] = DEFAULT_CENTRE
  const base = latLngToCell(lat, lng, RESOLUTION)

  for (let ring = 0; ring <= 10; ring++) {
    const cells = gridDisk(base, ring)
    for (const cell of cells) {
      if (!occupiedHexes.has(cell) && !isPentagon(cell)) {
        return cell
      }
    }
  }

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

// Get the lat/lng centre of a hex (for map rendering)
export function getHexCentre(hexId: string): [number, number] {
  if (!h3Available) return [0, 0]
  try {
    return cellToLatLng(hexId)
  } catch {
    return [0, 0]
  }
}
