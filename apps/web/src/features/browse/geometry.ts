import type { Cell, Dialect } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell, MAX_BINARY_BYTES } from '@tsmyadmin/shared'

type Point = [number, number]

/** A value of a spatial column, reduced to what can be drawn flat: two dimensions, no SRID. */
export type Shape =
  | { type: 'point'; at: Point }
  | { type: 'line'; points: Point[] }
  | { type: 'polygon'; rings: Point[][] }
  | { type: 'circle'; at: Point; r: number }
  | { type: 'collection'; parts: Shape[] }

/** How a column's values arrive: WKB bytes, PostGIS hex EWKB, or PostgreSQL's own geometric text. */
export type Encoding =
  | 'mysql-wkb'
  | 'ewkb-hex'
  | 'pg-point'
  | 'pg-lseg'
  | 'pg-box'
  | 'pg-path'
  | 'pg-polygon'
  | 'pg-circle'

const MYSQL_SPATIAL =
  /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)\b/i
const POSTGIS = /(?:^|\.)"?(?:geometry|geography)"?(?:\(.*\))?$/i
const PG_NATIVE: Record<string, Encoding> = {
  point: 'pg-point',
  lseg: 'pg-lseg',
  box: 'pg-box',
  path: 'pg-path',
  polygon: 'pg-polygon',
  circle: 'pg-circle',
}

/** The encoding of a column's values, or null when it is not a spatial column (arrays of shapes included). */
export function spatialEncoding(dialect: Dialect, dataType: string): Encoding | null {
  const type = dataType.trim()
  if (dialect === 'mysql') return MYSQL_SPATIAL.test(type) ? 'mysql-wkb' : null
  if (POSTGIS.test(type)) return 'ewkb-hex'
  return PG_NATIVE[type.toLowerCase()] ?? null
}

/** A cell as a shape; null for NULL, an empty geometry, or anything that does not read (a cut-off value). */
export function parseShape(encoding: Encoding, cell: Cell): Shape | null {
  if (cell === null) return null
  try {
    let shape: Shape | null
    if (encoding === 'mysql-wkb') {
      if (typeof cell !== 'object' || !('$bin' in cell)) return null
      // MySQL stores a 4-byte SRID ahead of standard WKB.
      shape = readWkb(base64Bytes(cell.$bin).subarray(4))
    } else if (typeof cell !== 'string') return null
    else shape = encoding === 'ewkb-hex' ? readWkb(hexBytes(cell)) : readNative(encoding, cell)
    return shape && drawable(shape) ? shape : null
  } catch {
    return null
  }
}

/**
 * A value the page holds only the start of: text cut to the display limit, or binary that reached the browse limit
 * (a longer value is cut without a marker, so a value of exactly that many bytes counts as cut too). Its whole
 * value is one download away, so such a value is not "unreadable".
 */
export function isCutCell(cell: Cell): boolean {
  if (isTruncatedCell(cell)) return true
  if (!isBinaryCell(cell)) return false
  const padding = cell.$bin.endsWith('==') ? 2 : cell.$bin.endsWith('=') ? 1 : 0
  return (cell.$bin.length * 3) / 4 - padding >= MAX_BINARY_BYTES
}

/** A whole value fetched on its own: the bytes MySQL keeps (SRID first, then WKB), or the text of the others. */
export function parseWholeValue(encoding: Encoding, value: Uint8Array | string): Shape | null {
  try {
    let shape: Shape | null
    if (typeof value !== 'string') shape = encoding === 'mysql-wkb' ? readWkb(value.subarray(4)) : null
    else
      shape =
        encoding === 'ewkb-hex'
          ? readWkb(hexBytes(value))
          : encoding === 'mysql-wkb'
            ? null
            : readNative(encoding, value)
    return shape && drawable(shape) ? shape : null
  } catch {
    return null
  }
}

const finite = ([x, y]: Point) => Number.isFinite(x) && Number.isFinite(y)

/**
 * Whether a shape can be drawn as it is: every coordinate finite (one NaN in a path makes the browser drop the
 * whole path, so a value holding one counts as unreadable rather than as drawn), and something to draw at all
 * (an empty line or collection is not a shape on screen).
 */
function drawable(shape: Shape): boolean {
  switch (shape.type) {
    case 'point':
      return finite(shape.at)
    case 'circle':
      return finite(shape.at) && Number.isFinite(shape.r) && shape.r >= 0
    case 'line':
      return shape.points.length > 0 && shape.points.every(finite)
    case 'polygon':
      return shape.rings.some((ring) => ring.length > 0) && shape.rings.every((ring) => ring.every(finite))
    default:
      return shape.parts.length > 0 && shape.parts.every(drawable)
  }
}

function base64Bytes(b64: string): Uint8Array {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function hexBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('not hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Reads (E)WKB: either byte order, EWKB's Z / M / SRID flags and ISO's 1000-step type codes alike. */
export function readWkb(bytes: Uint8Array): Shape | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new Error('short')
  }
  const geometry = (depth: number): Shape | null => {
    if (depth > 32) throw new Error('too deep')
    need(5)
    const little = view.getUint8(at) === 1
    const u32 = () => {
      need(4)
      const v = view.getUint32(at, little)
      at += 4
      return v
    }
    const f64 = () => {
      need(8)
      const v = view.getFloat64(at, little)
      at += 8
      return v
    }
    at += 1
    const raw = u32()
    if (raw & 0x20000000) u32() // EWKB SRID
    const iso = raw & 0x0fffffff
    const base = iso % 1000
    const extra = (raw & 0x80000000 ? 1 : 0) + (raw & 0x40000000 ? 1 : 0) || [0, 1, 1, 2][Math.floor(iso / 1000)] || 0
    const point = (): Point => {
      const x = f64()
      const y = f64()
      for (let i = 0; i < extra; i++) f64()
      return [x, y]
    }
    const count = (bytesEach: number) => {
      const n = u32()
      // A count the rest of the value cannot hold is a damaged value, not a reason to allocate billions.
      need(n * bytesEach)
      return n
    }
    const points = () => Array.from({ length: count((2 + extra) * 8) }, point)
    switch (base) {
      case 1: {
        const p = point()
        // POINT EMPTY is written as NaN coordinates.
        return Number.isNaN(p[0]) && Number.isNaN(p[1]) ? null : { type: 'point', at: p }
      }
      case 2:
        return { type: 'line', points: points() }
      case 3:
        return { type: 'polygon', rings: Array.from({ length: count(4) }, points) }
      case 4:
      case 5:
      case 6:
      case 7: {
        const parts = Array.from({ length: count(5) }, () => geometry(depth + 1)).filter((s): s is Shape => s !== null)
        return { type: 'collection', parts }
      }
      default:
        throw new Error(`unsupported type ${base}`)
    }
  }
  return geometry(0)
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

function pairs(text: string): Point[] {
  const n = (text.match(NUMBER) ?? []).map(Number)
  const out: Point[] = []
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i] ?? 0, n[i + 1] ?? 0])
  return out
}

/** PostgreSQL's built-in geometric types, in their text form. */
function readNative(encoding: Encoding, text: string): Shape | null {
  const ps = pairs(text)
  switch (encoding) {
    case 'pg-point':
      return ps[0] ? { type: 'point', at: ps[0] } : null
    case 'pg-lseg':
      return { type: 'line', points: ps }
    case 'pg-box': {
      const [a, b] = ps
      if (!a || !b) return null
      return {
        type: 'polygon',
        rings: [
          [
            [a[0], a[1]],
            [b[0], a[1]],
            [b[0], b[1]],
            [a[0], b[1]],
            [a[0], a[1]],
          ],
        ],
      }
    }
    // A closed path is written in parentheses, an open one in brackets.
    case 'pg-path':
      return text.trim().startsWith('(') ? { type: 'polygon', rings: [ps] } : { type: 'line', points: ps }
    case 'pg-polygon':
      return { type: 'polygon', rings: [ps] }
    case 'pg-circle': {
      const n = (text.match(NUMBER) ?? []).map(Number)
      const [x, y, r] = n
      return x === undefined || y === undefined || r === undefined ? null : { type: 'circle', at: [x, y], r }
    }
    default:
      return null
  }
}

/** The smallest box around every shape, or null when there is nothing to draw. */
export function bounds(shapes: readonly Shape[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const add = ([x, y]: Point, r = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x - r)
    minY = Math.min(minY, y - r)
    maxX = Math.max(maxX, x + r)
    maxY = Math.max(maxY, y + r)
  }
  const visit = (s: Shape) => {
    if (s.type === 'point') add(s.at)
    else if (s.type === 'circle') add(s.at, s.r)
    else if (s.type === 'line') s.points.forEach((p) => add(p))
    else if (s.type === 'polygon') s.rings.forEach((ring) => ring.forEach((p) => add(p)))
    else s.parts.forEach(visit)
  }
  shapes.forEach(visit)
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}
