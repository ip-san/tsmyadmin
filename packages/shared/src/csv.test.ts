import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.ts'

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
})
