import { describe, expect, it } from 'vitest'
import { csvField, parseCsv, parseCsvDocument, toCsv } from './csv.ts'

describe('parseCsv', () => {
  it('parses simple rows with CRLF and LF and strips a BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,2\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('handles quoted fields with delimiters, newlines and escaped quotes', () => {
    expect(parseCsv('x,"a,b","line\nbreak","say ""hi"""\n')).toEqual([['x', 'a,b', 'line\nbreak', 'say "hi"']])
  })

  it('keeps empty fields and supports other delimiters', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ])
    expect(parseCsv('a;b\n1;2', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n')).toEqual([])
  })

  it('reports which fields were quoted so a quoted NULL marker can be told from NULL', () => {
    const doc = parseCsvDocument('a,"\\N",\\N\n""\n')
    expect(doc.rows).toEqual([['a', '\\N', '\\N'], ['']])
    expect(doc.quoted).toEqual([[false, true, false], [true]])
  })
})

describe('csvField / toCsv', () => {
  it('quotes only when needed and encodes NULL and binary', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
    expect(csvField(null)).toBe('\\N')
    expect(csvField('\\N')).toBe('"\\N"')
    expect(csvField('')).toBe('""')
    expect(csvField({ $bin: 'AAEC' })).toBe('AAEC')
    expect(csvField(42)).toBe('42')
  })

  it('round-trips through parseCsv', () => {
    const csv = toCsv(
      ['id', 'name'],
      [
        [1, 'a,b'],
        [2, null],
      ]
    )
    expect(csv).toBe('id,name\r\n1,"a,b"\r\n2,\\N\r\n')
    expect(parseCsv(csv)).toEqual([
      ['id', 'name'],
      ['1', 'a,b'],
      ['2', '\\N'],
    ])
  })
})
