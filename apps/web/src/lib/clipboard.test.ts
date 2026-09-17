import { describe, expect, it } from 'vitest'
import { toTsv } from './clipboard.ts'

describe('toTsv', () => {
  it('writes a header and one line per row, quoting only what would break the grid', () => {
    expect(
      toTsv(
        ['name', 'note'],
        [
          ['Alice', null],
          ['tab\there', 'line\nbreak'],
          ['say "hi"', 42],
          [{ $bin: 'AQI=' }, true],
        ]
      )
    ).toBe('name\tnote\nAlice\tNULL\n"tab\there"\t"line\nbreak"\n"say ""hi"""\t42\nAQI=\ttrue')
  })

  it('refuses a cut value rather than copying it as if it were whole', () => {
    expect(() => toTsv(['a'], [[{ $text: 'abc', length: 10 }]])).toThrow()
  })
})
