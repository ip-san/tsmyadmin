import { describe, expect, it } from 'vitest'
import { PG_TYPE_NAMES, pgTypes } from './values.ts'

const parse = (oid: number, value: string) => (pgTypes.getTypeParser(oid, 'text') as (v: string) => unknown)(value)

describe('the PostgreSQL type parsers: values stay lossless on the wire', () => {
  it('reads small integers, oid and floats as numbers', () => {
    for (const oid of [21, 23, 26, 700, 701]) expect(parse(oid, '42'), String(oid)).toBe(42)
    expect(parse(701, '1.5')).toBe(1.5)
    expect(parse(23, '-7')).toBe(-7)
  })

  it("keeps a float that is not a finite number as the server's text", () => {
    expect(parse(701, 'NaN')).toBe('NaN')
    expect(parse(701, 'Infinity')).toBe('Infinity')
    expect(parse(700, '-Infinity')).toBe('-Infinity')
  })

  it('reads an int8 as a number while it is exact, and as text beyond that', () => {
    expect(parse(20, '9007199254740991')).toBe(9_007_199_254_740_991)
    expect(parse(20, '9007199254740992')).toBe('9007199254740992')
    expect(parse(20, '-9007199254740993')).toBe('-9007199254740993')
    expect(parse(20, '0')).toBe(0)
  })

  it("leaves numeric, dates, json, uuid, arrays and everything else as the server's text", () => {
    expect(parse(1700, '12.50')).toBe('12.50')
    expect(parse(1082, '2030-01-01')).toBe('2030-01-01')
    expect(parse(3802, '{"a":1}')).toBe('{"a":1}')
    expect(parse(2950, 'abc')).toBe('abc')
    expect(parse(1007, '{1,2}')).toBe('{1,2}')
    expect(parse(25, '12')).toBe('12')
  })

  it("hands bytea and boolean to the driver's own text parsers, and binary values to its binary ones", () => {
    expect(parse(16, 't')).toBe(true)
    expect(parse(16, 'f')).toBe(false)
    expect(Buffer.isBuffer(parse(17, '\\x0102'))).toBe(true)
    expect(parse(17, '\\x0102')).toEqual(Buffer.from([1, 2]))
    const binary = pgTypes.getTypeParser(23, 'binary') as (v: Buffer) => unknown
    expect(binary(Buffer.from([0, 0, 0, 5]))).toBe(5)
  })
})

describe('PG_TYPE_NAMES', () => {
  it('names the types a result column shows', () => {
    expect(PG_TYPE_NAMES[23]).toBe('int4')
    expect(PG_TYPE_NAMES[1043]).toBe('varchar')
    expect(PG_TYPE_NAMES[1184]).toBe('timestamptz')
    expect(PG_TYPE_NAMES[3802]).toBe('jsonb')
    expect(PG_TYPE_NAMES[1009]).toBe('text[]')
    expect(PG_TYPE_NAMES[2951]).toBe('uuid[]')
    expect(PG_TYPE_NAMES[999_999]).toBeUndefined()
  })
})
