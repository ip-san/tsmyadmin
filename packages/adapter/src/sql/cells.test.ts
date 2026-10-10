import { describe, expect, it } from 'vitest'
import { refuses } from '../test/ddl-helpers.ts'
import { bufferToCell, DISPLAY, driverValueToCell, toDbValue, UNCAPPED } from './cells.ts'

describe('toDbValue', () => {
  it('turns a binary cell back into bytes and passes the other values through as they are', () => {
    expect(toDbValue({ $bin: 'AQID' })).toEqual(Buffer.from([1, 2, 3]))
    expect(toDbValue('text')).toBe('text')
    expect(toDbValue(7)).toBe(7)
    expect(toDbValue(false)).toBe(false)
    expect(toDbValue(null)).toBeNull()
  })

  it('refuses a truncated text value, which holds only the head of what it stood for', () => {
    refuses(() => toDbValue({ $text: 'abc', length: 9 }), 'VALIDATION', /truncated text value cannot be written back/)
  })
})

describe('bufferToCell', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(1)
  const length = (cell: unknown) => Buffer.from((cell as { $bin: string }).$bin, 'base64').length

  it('keeps a value whole up to the limit and cuts it beyond, 64 KiB by default', () => {
    expect(length(bufferToCell(bytes(10), 10))).toBe(10)
    expect(length(bufferToCell(bytes(11), 10))).toBe(10)
    expect(length(bufferToCell(bytes(65_536)))).toBe(65_536)
    expect(length(bufferToCell(bytes(65_537)))).toBe(65_536)
    expect(length(bufferToCell(bytes(0), 10))).toBe(0)
  })

  it('keeps everything when the limit is infinite, as an export does', () => {
    expect(length(bufferToCell(bytes(70_000), Number.POSITIVE_INFINITY))).toBe(70_000)
  })
})

describe('driverValueToCell', () => {
  it('reads nothing as null, and numbers and booleans as themselves', () => {
    expect(driverValueToCell(null)).toBeNull()
    expect(driverValueToCell(undefined)).toBeNull()
    expect(driverValueToCell(0)).toBe(0)
    expect(driverValueToCell(1.5)).toBe(1.5)
    expect(driverValueToCell(true)).toBe(true)
    expect(driverValueToCell(false)).toBe(false)
  })

  it('writes a bigint as digits and any other object as JSON', () => {
    expect(driverValueToCell(123_456_789_012_345_678n)).toBe('123456789012345678')
    expect(driverValueToCell({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}')
    expect(driverValueToCell([1, 2])).toBe('[1,2]')
  })

  it('writes bytes as a binary cell, cut at the binary limit', () => {
    expect(driverValueToCell(Buffer.from([1, 2, 3]))).toEqual({ $bin: 'AQID' })
    expect(driverValueToCell(new Uint8Array([1, 2, 3]))).toEqual({ $bin: 'AQID' })
    expect(driverValueToCell(Buffer.from([1, 2, 3]), { binaryLimit: 2 })).toEqual({ $bin: 'AQI=' })
    expect(driverValueToCell(Buffer.from([1, 2, 3]), UNCAPPED)).toEqual({ $bin: 'AQID' })
  })

  it('keeps a string whole by default, and up to the limit when one is set', () => {
    expect(driverValueToCell('x'.repeat(100_000))).toBe('x'.repeat(100_000))
    expect(driverValueToCell('abc', { textLimit: 3 })).toBe('abc')
    expect(driverValueToCell('', { textLimit: 0 })).toBe('')
  })

  it('cuts a longer string to its head and says how long it was', () => {
    expect(driverValueToCell('abcdef', { textLimit: 3 })).toEqual({ $text: 'abc', length: 6 })
    expect(driverValueToCell('x'.repeat(65_537), DISPLAY)).toEqual({ $text: 'x'.repeat(65_536), length: 65_537 })
    expect(driverValueToCell('x'.repeat(65_537), UNCAPPED)).toBe('x'.repeat(65_537))
  })

  it('never cuts between the two halves of a character', () => {
    const emoji = '\u{1F600}' // two UTF-16 units: a high surrogate then a low one
    expect(driverValueToCell(`ab${emoji}`, { textLimit: 3 })).toEqual({ $text: 'ab', length: 4 })
    expect(driverValueToCell(`a${emoji}z`, { textLimit: 2 })).toEqual({ $text: 'a', length: 4 })
    expect(driverValueToCell(`${emoji}${emoji}`, { textLimit: 2 })).toEqual({ $text: emoji, length: 4 })
    expect(driverValueToCell(`${emoji}z`, { textLimit: 1 })).toEqual({ $text: '', length: 3 })
    // The edges of the high-surrogate range count, the units either side of it do not.
    expect(driverValueToCell('a\ud800z', { textLimit: 2 })).toEqual({ $text: 'a', length: 3 })
    expect(driverValueToCell('a\udbffz', { textLimit: 2 })).toEqual({ $text: 'a', length: 3 })
    expect(driverValueToCell('a퟿z', { textLimit: 2 })).toEqual({ $text: 'a퟿', length: 3 })
    expect(driverValueToCell('a\udc00z', { textLimit: 2 })).toEqual({ $text: 'a\udc00', length: 3 })
  })
})
