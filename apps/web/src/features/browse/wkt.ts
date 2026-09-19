import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'

const NAMES = [
  '',
  'POINT',
  'LINESTRING',
  'POLYGON',
  'MULTIPOINT',
  'MULTILINESTRING',
  'MULTIPOLYGON',
  'GEOMETRYCOLLECTION',
]

/** Coordinates as WKT writes them: the shortest form that reads back as the same double. */
const num = (v: number) => (Object.is(v, -0) ? '0' : String(v))

/**
 * (E)WKB as WKT, keeping the MULTI* types, Z / M coordinates and a non-zero SRID (written EWKT-style, `SRID=n;`).
 * Throws on a value that does not read (cut off, or not WKB at all).
 */
export function wkbToWkt(bytes: Uint8Array, srid = 0): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  let outerSrid = srid
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new Error('short')
  }
  const geometry = (depth: number, tagged: boolean): string => {
    if (depth > 32) throw new Error('too deep')
    need(5)
    const little = view.getUint8(at) === 1
    at += 1
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
    const raw = u32()
    if (raw & 0x20000000) {
      const s = u32()
      if (depth === 0) outerSrid = s
    }
    const iso = raw & 0x0fffffff
    const base = iso % 1000
    const z = Boolean(raw & 0x80000000) || [1, 3].includes(Math.floor(iso / 1000))
    const m = Boolean(raw & 0x40000000) || [2, 3].includes(Math.floor(iso / 1000))
    const dims = 2 + (z ? 1 : 0) + (m ? 1 : 0)
    const name = NAMES[base]
    if (!name) throw new Error(`unsupported type ${base}`)
    const count = (each: number) => {
      const n = u32()
      need(n * each)
      return n
    }
    const coords = () => Array.from({ length: dims }, f64)
    const point = () => coords().map(num).join(' ')
    const list = () => `(${Array.from({ length: count(dims * 8) }, point).join(', ')})`
    let body: string
    switch (base) {
      case 1: {
        const p = coords()
        body = p.every(Number.isNaN) ? 'EMPTY' : `(${p.map(num).join(' ')})`
        break
      }
      case 2:
        body = list()
        if (body === '()') body = 'EMPTY'
        break
      case 3: {
        const n = count(4)
        body = n === 0 ? 'EMPTY' : `(${Array.from({ length: n }, list).join(', ')})`
        break
      }
      default: {
        const n = count(5)
        // MULTIPOINT ((1 2), (3 4)) and the like: each part without its own type name, except in a collection.
        const parts = Array.from({ length: n }, () => geometry(depth + 1, base === 7))
        body = n === 0 ? 'EMPTY' : `(${parts.join(', ')})`
      }
    }
    const suffix = z && m ? ' ZM' : z ? ' Z' : m ? ' M' : ''
    const text = body === 'EMPTY' ? ` ${body}` : body
    return tagged ? `${name}${suffix}${text}` : body
  }
  const wkt = geometry(0, true)
  return outerSrid ? `SRID=${outerSrid};${wkt}` : wkt
}

function base64Bytes(b64: string): Uint8Array {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * A spatial cell as WKT: MySQL's value (4-byte little-endian SRID, then WKB) or PostGIS's hex EWKB. Null when the
 * cell is not one of those, or does not read — the cell is then shown as it would be anyway.
 */
export function spatialCellToWkt(cell: Cell): string | null {
  try {
    if (isBinaryCell(cell)) {
      const bytes = base64Bytes(cell.$bin)
      if (bytes.byteLength < 9) return null
      const srid = new DataView(bytes.buffer).getUint32(0, true)
      return wkbToWkt(bytes.subarray(4), srid)
    }
    if (typeof cell === 'string' && /^(?:[0-9a-f]{2})+$/i.test(cell)) {
      const bytes = new Uint8Array(cell.length / 2)
      for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(cell.slice(i * 2, i * 2 + 2), 16)
      return wkbToWkt(bytes)
    }
    return null
  } catch {
    return null
  }
}
