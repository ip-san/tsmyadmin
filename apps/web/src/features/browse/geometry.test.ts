import { describe, expect, it } from 'vitest'
import { bounds, isCutCell, parseShape, parseWholeValue, readWkb, spatialEncoding } from './geometry.ts'

/** WKB built by hand: byte order, type code, then the numbers, so the tests do not trust the reader to build it. */
function wkb(little: boolean, type: number, body: (number | 'u32')[], extra: { srid?: number } = {}): Uint8Array {
  const bytes: Uint8Array[] = []
  const push = (size: number, write: (v: DataView) => void) => {
    const b = new Uint8Array(size)
    write(new DataView(b.buffer))
    bytes.push(b)
  }
  push(1, (v) => v.setUint8(0, little ? 1 : 0))
  push(4, (v) => v.setUint32(0, type, little))
  if (extra.srid !== undefined) push(4, (v) => v.setUint32(0, extra.srid ?? 0, little))
  let nextIsCount = false
  for (const item of body) {
    if (item === 'u32') {
      nextIsCount = true
      continue
    }
    if (nextIsCount) {
      push(4, (v) => v.setUint32(0, item, little))
      nextIsCount = false
    } else push(8, (v) => v.setFloat64(0, item, little))
  }
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of bytes) {
    out.set(b, at)
    at += b.length
  }
  return out
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))

describe('geometry', () => {
  it('tells spatial columns and how their values arrive', () => {
    expect(spatialEncoding('mysql', 'point')).toBe('mysql-wkb')
    expect(spatialEncoding('mysql', 'geomcollection')).toBe('mysql-wkb')
    expect(spatialEncoding('mysql', 'int')).toBeNull()
    expect(spatialEncoding('postgres', 'geometry(Point,4326)')).toBe('ewkb-hex')
    expect(spatialEncoding('postgres', 'public.geography')).toBe('ewkb-hex')
    expect(spatialEncoding('postgres', 'polygon')).toBe('pg-polygon')
    expect(spatialEncoding('postgres', 'point[]')).toBeNull()
    expect(spatialEncoding('postgres', 'text')).toBeNull()
  })

  it('reads points, lines and polygons in either byte order', () => {
    expect(readWkb(wkb(true, 1, [1.5, -2]))).toEqual({ type: 'point', at: [1.5, -2] })
    expect(readWkb(wkb(false, 1, [1.5, -2]))).toEqual({ type: 'point', at: [1.5, -2] })
    expect(readWkb(wkb(true, 2, ['u32', 2, 0, 0, 3, 4]))).toEqual({
      type: 'line',
      points: [
        [0, 0],
        [3, 4],
      ],
    })
    expect(readWkb(wkb(false, 3, ['u32', 1, 'u32', 3, 0, 0, 1, 0, 0, 1]))).toEqual({
      type: 'polygon',
      rings: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      ],
    })
  })

  it('skips the SRID and the third and fourth dimensions (EWKB flags and ISO codes)', () => {
    // EWKB: SRID flag with a Z coordinate.
    expect(readWkb(wkb(true, 0x80000001 | 0x20000000, [1, 2, 99], { srid: 4326 }))).toEqual({
      type: 'point',
      at: [1, 2],
    })
    // ISO: 3002 is a LineString with Z and M.
    expect(readWkb(wkb(true, 3002, ['u32', 2, 1, 2, 7, 8, 3, 4, 7, 8]))).toEqual({
      type: 'line',
      points: [
        [1, 2],
        [3, 4],
      ],
    })
  })

  it('reads collections part by part, each with its own byte order', () => {
    const a = wkb(true, 1, [1, 1])
    const b = wkb(false, 1, [2, 2])
    const head = wkb(true, 4, ['u32', 2])
    const whole = new Uint8Array([...head, ...a, ...b])
    expect(readWkb(whole)).toEqual({
      type: 'collection',
      parts: [
        { type: 'point', at: [1, 1] },
        { type: 'point', at: [2, 2] },
      ],
    })
  })

  it('gives up on a damaged value instead of reading past it', () => {
    // A LineString claiming a billion points in a value that holds one.
    expect(() => readWkb(wkb(true, 2, ['u32', 1_000_000_000, 1, 2]))).toThrow()
    expect(parseShape('ewkb-hex', hex(wkb(true, 2, ['u32', 1_000_000_000, 1, 2])))).toBeNull()
    expect(parseShape('ewkb-hex', 'zz')).toBeNull()
    expect(parseShape('mysql-wkb', 'not binary')).toBeNull()
    // POINT EMPTY is written as NaN coordinates: nothing to draw.
    expect(parseShape('ewkb-hex', hex(wkb(true, 1, [Number.NaN, Number.NaN])))).toBeNull()
  })

  it('counts a value with a non-finite coordinate, or nothing to draw, as unreadable', () => {
    // One coordinate out of range makes a browser drop the whole path: such a value is not "drawn".
    expect(parseShape('ewkb-hex', hex(wkb(true, 1, [5, Number.NaN])))).toBeNull()
    expect(parseShape('ewkb-hex', hex(wkb(true, 1, [Number.POSITIVE_INFINITY, 5])))).toBeNull()
    expect(parseShape('ewkb-hex', hex(wkb(true, 2, ['u32', 2, 0, 0, 1, Number.NEGATIVE_INFINITY])))).toBeNull()
    const bad = wkb(true, 1, [Number.NaN, 1])
    expect(
      parseShape('ewkb-hex', hex(new Uint8Array([...wkb(true, 7, ['u32', 2]), ...wkb(true, 1, [1, 1]), ...bad])))
    ).toBeNull()
    // GEOMETRYCOLLECTION EMPTY, an empty line, a circle with a negative radius.
    expect(parseShape('ewkb-hex', hex(wkb(true, 7, ['u32', 0])))).toBeNull()
    expect(parseShape('ewkb-hex', hex(wkb(true, 2, ['u32', 0])))).toBeNull()
    expect(parseShape('pg-circle', '<(1,2),-3>')).toBeNull()
  })

  it('reads MySQL values past their SRID prefix', () => {
    const value = new Uint8Array([0xe6, 0x10, 0, 0, ...wkb(true, 1, [135, 35])])
    expect(parseShape('mysql-wkb', { $bin: b64(value) })).toEqual({ type: 'point', at: [135, 35] })
  })

  it('reads PostgreSQL built-in geometric types from their text', () => {
    expect(parseShape('pg-point', '(1.5,-2)')).toEqual({ type: 'point', at: [1.5, -2] })
    expect(parseShape('pg-lseg', '[(0,0),(1,1)]')).toEqual({
      type: 'line',
      points: [
        [0, 0],
        [1, 1],
      ],
    })
    expect(parseShape('pg-box', '(2,2),(0,0)')).toMatchObject({ type: 'polygon' })
    expect(parseShape('pg-path', '[(0,0),(1,1)]')).toMatchObject({ type: 'line' })
    expect(parseShape('pg-path', '((0,0),(1,1),(1,0))')).toMatchObject({ type: 'polygon' })
    expect(parseShape('pg-polygon', '((0,0),(1e2,0),(0,1))')).toEqual({
      type: 'polygon',
      rings: [
        [
          [0, 0],
          [100, 0],
          [0, 1],
        ],
      ],
    })
    expect(parseShape('pg-circle', '<(1,2),3>')).toEqual({ type: 'circle', at: [1, 2], r: 3 })
    expect(parseShape('pg-point', null)).toBeNull()
  })

  it('bounds every shape, circles by their radius', () => {
    expect(
      bounds([
        { type: 'point', at: [1, 1] },
        { type: 'circle', at: [5, 5], r: 2 },
        { type: 'collection', parts: [{ type: 'line', points: [[-1, 0]] }] },
      ])
    ).toEqual({ minX: -1, minY: 0, maxX: 7, maxY: 7 })
    expect(bounds([])).toBeNull()
  })
})

describe('values cut at the browse limit', () => {
  const bytes = (n: number) => btoa('a'.repeat(n))

  it('tells a value that reached the 64 KB limit from one that fits, and text cut for display', () => {
    expect(isCutCell({ $bin: bytes(65535) })).toBe(false)
    expect(isCutCell({ $bin: bytes(65536) })).toBe(true)
    expect(isCutCell({ $bin: bytes(70000) })).toBe(true)
    expect(isCutCell({ $text: 'abc', length: 900000 })).toBe(true)
    expect(isCutCell('POLYGON')).toBe(false)
    expect(isCutCell(null)).toBe(false)
  })

  it('reads a whole value fetched on its own, in the form each dialect keeps', () => {
    const point = wkb(true, 1, [3, 4])
    const withSrid = new Uint8Array([0, 0, 0, 0, ...point])
    expect(parseWholeValue('mysql-wkb', withSrid)).toEqual({ type: 'point', at: [3, 4] })
    expect(parseWholeValue('ewkb-hex', hex(point))).toEqual({ type: 'point', at: [3, 4] })
    expect(parseWholeValue('pg-polygon', '((0,0),(1,0),(1,1))')).toMatchObject({ type: 'polygon' })
    expect(parseWholeValue('mysql-wkb', 'text')).toBeNull()
    expect(parseWholeValue('mysql-wkb', new Uint8Array([0, 0, 0, 0, 1]))).toBeNull()
  })
})
