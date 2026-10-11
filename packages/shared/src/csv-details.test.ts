import { describe, expect, it } from 'vitest'
import {
  CsvParseError,
  csvField,
  neutraliseFormula,
  parseCsv,
  parseCsvDocument,
  parseCsvRecords,
  toCsv,
} from './csv.ts'
import { CSV_NULL } from './schemas/export.ts'

/**
 * The edges of the CSV that exports are written in and imports are read from: what is quoted, what a spreadsheet may
 * not run, where a line ends and what a quote means (found as surviving mutants; see `bun run mutation`).
 */

describe('csvField: what is written', () => {
  it('writes NULL as the bare marker, numbers and booleans as their text, and bytes as base64', () => {
    expect(csvField(null)).toBe(CSV_NULL)
    expect(csvField(5)).toBe('5')
    expect(csvField(-1.5)).toBe('-1.5')
    expect(csvField(true)).toBe('true')
    expect(csvField(false)).toBe('false')
    expect(csvField({ $bin: 'AQID' })).toBe('AQID')
    expect(csvField('plain text')).toBe('plain text')
  })

  it('refuses a cut value, which must never land in a file that looks complete', () => {
    expect(() => csvField({ $text: 'abc', length: 9 })).toThrow('truncated text cannot be written to CSV')
  })

  it('quotes a value that holds a quote, a line break or the delimiter, and doubles the quotes in it', () => {
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('a\rb')).toBe('"a\rb"')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('a;b')).toBe('a;b')
    expect(csvField('a;b', false, ';')).toBe('"a;b"')
    expect(csvField('a,b', false, ';')).toBe('a,b')
    expect(csvField('a\tb', false, '\t')).toBe('"a\tb"')
    expect(csvField('"')).toBe('""""')
  })

  it('quotes the empty string and the text of the NULL marker, so they cannot be taken for a blank line or NULL', () => {
    expect(csvField('')).toBe('""')
    expect(csvField(CSV_NULL)).toBe(`"${CSV_NULL}"`)
    expect(csvField(`${CSV_NULL}x`)).toBe(`${CSV_NULL}x`)
    expect(csvField(` ${CSV_NULL}`)).toBe(` ${CSV_NULL}`)
  })

  it('quotes everything but NULL when asked', () => {
    expect(csvField('a', false, ',', { quoteAll: true })).toBe('"a"')
    expect(csvField(5, false, ',', { quoteAll: true })).toBe('"5"')
    expect(csvField(null, false, ',', { quoteAll: true })).toBe(CSV_NULL)
    expect(csvField('a', false, ',', { quoteAll: false })).toBe('a')
    expect(csvField('a', false, ',', {})).toBe('a')
  })

  it('reads a line break as a space, one for each, when asked, and then needs no quotes for it', () => {
    const strip = (v: string) => csvField(v, false, ',', { stripEol: true })
    expect(strip('a\r\nb')).toBe('a b')
    expect(strip('a\rb')).toBe('a b')
    expect(strip('a\nb')).toBe('a b')
    expect(strip('a\n\nb')).toBe('a  b')
    expect(strip('a\r\n\r\nb')).toBe('a  b')
    expect(strip('\n')).toBe(' ')
    expect(csvField('a\nb', false, ',', { stripEol: false })).toBe('"a\nb"')
  })
})

describe('neutralising a formula', () => {
  it('puts an apostrophe before a value a spreadsheet would run, and before no other', () => {
    for (const start of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])
      expect(neutraliseFormula(start), JSON.stringify(start)).toBe(`'${start}`)
    for (const safe of ['text', '1', '', ' =1', 'a=1', "'=1", '#x', '.5'])
      expect(neutraliseFormula(safe), safe).toBe(safe)
  })

  it('does it in a field only when asked, and before the value is quoted', () => {
    expect(csvField('=1+1')).toBe('=1+1')
    expect(csvField('=1+1', true)).toBe("'=1+1")
    expect(csvField('-5', true)).toBe("'-5")
    expect(csvField(-5, true)).toBe("'-5")
    expect(csvField('=a,b', true)).toBe('"\'=a,b"')
    expect(csvField('\tx', true)).toBe("'\tx")
    expect(csvField('\rx', true)).toBe('"\'\rx"')
    expect(csvField(null, true)).toBe(CSV_NULL)
  })
})

describe('toCsv', () => {
  it('writes the header and the rows, each line ended by CRLF, the last one too', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, 'x'],
          [null, 'y,z'],
        ]
      )
    ).toBe(`a,b\r\n1,x\r\n${CSV_NULL},"y,z"\r\n`)
    expect(toCsv(['a'], [])).toBe('a\r\n')
    expect(toCsv([], [])).toBe('\r\n')
  })

  it('neutralises the header and the rows alike when asked', () => {
    expect(toCsv(['=a'], [['=b']], true)).toBe("'=a\r\n'=b\r\n")
    expect(toCsv(['=a'], [['=b']])).toBe('=a\r\n=b\r\n')
  })
})

describe('parseCsv: records and lines', () => {
  it('ends a record at LF, CRLF or CR, and skips the empty line at the end but not one in the middle', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']])
    expect(parseCsv('a\r\nb')).toEqual([['a'], ['b']])
    expect(parseCsv('a\rb')).toEqual([['a'], ['b']])
    expect(parseCsv('a\r\rb')).toEqual([['a'], [''], ['b']])
    expect(parseCsv('a\n\nb')).toEqual([['a'], [''], ['b']])
    expect(parseCsv('a\n')).toEqual([['a']])
    expect(parseCsv('a\r\n')).toEqual([['a']])
    expect(parseCsv('a\n\n')).toEqual([['a']])
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n')).toEqual([])
  })

  it('keeps an empty field, a quoted empty one and a lone delimiter as the fields they are', () => {
    expect(parseCsv(',')).toEqual([['', '']])
    expect(parseCsv('a,,b')).toEqual([['a', '', 'b']])
    expect(parseCsv('""')).toEqual([['']])
    expect(parseCsv('""\n')).toEqual([['']])
    expect(parseCsv('a,')).toEqual([['a', '']])
    expect(parseCsv('a,\nb')).toEqual([['a', ''], ['b']])
  })

  it('drops a byte order mark at the start and only there', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']])
    expect(parseCsv('a﻿')).toEqual([['a﻿']])
    expect(parseCsv('﻿')).toEqual([])
  })

  it('splits on another delimiter and leaves the usual one in the value', () => {
    expect(parseCsv('a;b,c', { delimiter: ';' })).toEqual([['a', 'b,c']])
    expect(parseCsv('a\tb', { delimiter: '\t' })).toEqual([['a', 'b']])
    expect(parseCsv('"a;b";c', { delimiter: ';' })).toEqual([['a;b', 'c']])
  })

  it('numbers the lines from one, a quoted line break counting, CRLF counting once', () => {
    const lines = (text: string, options = {}) => [...parseCsvRecords(text, options)].map((r) => r.line)
    expect(lines('a\nb\nc')).toEqual([1, 2, 3])
    expect(lines('a\r\nb\r\nc')).toEqual([1, 2, 3])
    expect(lines('a\rb\rc')).toEqual([1, 2, 3])
    expect(lines('"x\ny"\nb')).toEqual([1, 3])
    expect(lines('"x\r\ny"\nb')).toEqual([1, 3])
    expect(lines('a\n\nb')).toEqual([1, 2, 3])
  })
})

describe('parseCsv: quotes', () => {
  it('opens a quote only at the start of a field, and reads one inside a field as a character', () => {
    expect(parseCsv('a"b,c')).toEqual([['a"b', 'c']])
    expect(parseCsv('"a""b"')).toEqual([['a"b']])
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
    expect(parseCsv('"a\nb"')).toEqual([['a\nb']])
    expect(parseCsv('"a"b')).toEqual([['ab']])
  })

  it('reports which fields were in quotes, so a quoted NULL marker is the text and a bare one is NULL', () => {
    const doc = parseCsvDocument(`a,"b",${CSV_NULL},"${CSV_NULL}"\n"c",d`)
    expect(doc.rows).toEqual([
      ['a', 'b', CSV_NULL, CSV_NULL],
      ['c', 'd'],
    ])
    expect(doc.quoted).toEqual([
      [false, true, false, true],
      [true, false],
    ])
    expect(parseCsvDocument('""').quoted).toEqual([[true]])
  })

  it('encloses with another character, and escapes the next with another still', () => {
    expect(parseCsv("'a,b','c'", { quote: "'" })).toEqual([['a,b', 'c']])
    expect(parseCsv("'it''s'", { quote: "'" })).toEqual([["it's"]])
    expect(parseCsv('"a\\"b"', { escape: '\\' })).toEqual([['a"b']])
    expect(parseCsv('"a\\\\b"', { escape: '\\' })).toEqual([['a\\b']])
    expect(parseCsv('"a\\nb"', { escape: '\\' })).toEqual([['anb']])
    expect(parseCsv('"a\\\nb"', { escape: '\\' })).toEqual([['a\nb']])
    // With a separate escape, a doubled quote is not one quote: the first closes the field and what follows, a quote
    // in a field that already has text, is an ordinary character.
    expect(parseCsv('"a""b"', { escape: '\\' })).toEqual([['a"b"']])
    // Outside quotes the escape character is an ordinary one.
    expect(parseCsv('a\\b', { escape: '\\' })).toEqual([['a\\b']])
  })

  it('refuses a quote that is never closed, naming the line it opened on, after the records before it', () => {
    const records: string[][] = []
    let caught: unknown
    try {
      for (const r of parseCsvRecords('a\nb\n"c\nd')) records.push(r.fields)
    } catch (e) {
      caught = e
    }
    expect(records).toEqual([['a'], ['b']])
    expect(caught).toBeInstanceOf(CsvParseError)
    expect((caught as CsvParseError).line).toBe(3)
    expect((caught as CsvParseError).name).toBe('CsvParseError')
    expect((caught as CsvParseError).message).toBe('Unterminated quoted field starting on line 3')
    expect(() => parseCsv('"abc')).toThrow('Unterminated quoted field starting on line 1')
    expect(() => parseCsv('a,"b\\', { escape: '\\' })).toThrow(CsvParseError)
    expect(() => parseCsv('"x\ny"\n"z')).toThrow('line 3')
  })
})

describe('parseCsv: the line end of a file', () => {
  it('ends a record only at the one line break named, the others being part of the value', () => {
    expect(parseCsv('a\r\nb\nc', { lineEnd: 'lf' })).toEqual([['a\r'], ['b'], ['c']])
    expect(parseCsv('a\nb\r\nc', { lineEnd: 'crlf' })).toEqual([['a\nb'], ['c']])
    expect(parseCsv('a\nb\rc\r', { lineEnd: 'cr' })).toEqual([['a\nb'], ['c']])
    expect(parseCsv('a\rb\r\nc', { lineEnd: 'lf' })).toEqual([['a\rb\r'], ['c']])
    expect(parseCsv('a\r\nb', { lineEnd: 'auto' })).toEqual([['a'], ['b']])
  })

  it('counts the lines of a value that holds a line break the file does not end records with', () => {
    const lines = [...parseCsvRecords('a\nb\r\nc', { lineEnd: 'crlf' })].map((r) => r.line)
    expect(lines).toEqual([1, 3])
  })
})
