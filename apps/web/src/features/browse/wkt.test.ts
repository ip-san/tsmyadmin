import { describe, expect, it } from 'vitest'
import { spatialCellToWkt, wkbToWkt } from './wkt.ts'

/** Little-endian WKB from a type code and a flat list of u32 counts and f64 coordinates. */
function wkb(parts: ({ u32: number } | { f64: number } | { geom: number })[]): Uint8Array {
  const out: number[] = []
  const view = new DataView(new ArrayBuffer(8))
  for (const p of parts) {
    if ('geom' in p) {
      out.push(1)
      view.setUint32(0, p.geom, true)
      out.push(...new Uint8Array(view.buffer, 0, 4))
    } else if ('u32' in p) {
      view.setUint32(0, p.u32, true)
      out.push(...new Uint8Array(view.buffer, 0, 4))
    } else {
      view.setFloat64(0, p.f64, true)
      out.push(...new Uint8Array(view.buffer, 0, 8))
    }
  }
  return new Uint8Array(out)
}
const pt = (x: number, y: number) => [{ f64: x }, { f64: y }]
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('wkbToWkt', () => {
  it('writes points, lines and polygons', () => {
    expect(wkbToWkt(wkb([{ geom: 1 }, ...pt(1, 2.5)]))).toBe('POINT(1 2.5)')
    expect(wkbToWkt(wkb([{ geom: 2 }, { u32: 2 }, ...pt(0, 0), ...pt(-1, 3)]))).toBe('LINESTRING(0 0, -1 3)')
    const ring = [{ u32: 4 }, ...pt(0, 0), ...pt(1, 0), ...pt(1, 1), ...pt(0, 0)]
    expect(wkbToWkt(wkb([{ geom: 3 }, { u32: 1 }, ...ring]))).toBe('POLYGON((0 0, 1 0, 1 1, 0 0))')
  })

  it('keeps MULTI* types and collections, and Z coordinates', () => {
    const multi = wkb([{ geom: 4 }, { u32: 2 }, { geom: 1 }, ...pt(1, 2), { geom: 1 }, ...pt(3, 4)])
    expect(wkbToWkt(multi)).toBe('MULTIPOINT((1 2), (3 4))')
    const collection = wkb([{ geom: 7 }, { u32: 1 }, { geom: 1 }, ...pt(5, 6)])
    expect(wkbToWkt(collection)).toBe('GEOMETRYCOLLECTION(POINT(5 6))')
    expect(wkbToWkt(wkb([{ geom: 1001 }, ...pt(1, 2), { f64: 3 }]))).toBe('POINT Z(1 2 3)')
    expect(wkbToWkt(wkb([{ geom: 7 }, { u32: 0 }]))).toBe('GEOMETRYCOLLECTION EMPTY')
  })

  it('reads a MySQL cell (SRID first) and a PostGIS hex EWKB cell; anything else is left alone', () => {
    const mysql = new Uint8Array([...wkb([{ u32: 4326 }]), ...wkb([{ geom: 1 }, ...pt(1, 2)])])
    expect(spatialCellToWkt({ $bin: toB64(mysql) })).toBe('SRID=4326;POINT(1 2)')
    const noSrid = new Uint8Array([0, 0, 0, 0, ...wkb([{ geom: 1 }, ...pt(1, 2)])])
    expect(spatialCellToWkt({ $bin: toB64(noSrid) })).toBe('POINT(1 2)')
    // EWKB with the SRID flag.
    const ewkb = wkb([{ geom: 0x20000001 }, { u32: 3857 }, ...pt(7, 8)])
    expect(spatialCellToWkt(toHex(ewkb))).toBe('SRID=3857;POINT(7 8)')
    expect(spatialCellToWkt('not hex')).toBeNull()
    expect(spatialCellToWkt({ $bin: toB64(mysql.subarray(0, 12)) })).toBeNull()
    expect(spatialCellToWkt(null)).toBeNull()
  })
})
