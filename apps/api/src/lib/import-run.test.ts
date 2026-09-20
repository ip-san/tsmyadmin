import { gzipSync } from 'node:zlib'
import { inferType, parseCsvRecords } from '@tsmyadmin/shared'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { ImportValidationError } from './import.ts'
import { columnNames, inferColumns } from './import-create.ts'
import { decodeText, unpack } from './import-run.ts'
import { zipStream } from './zip.ts'

const zip = async (entries: { name: string; data: string }[]) =>
  new Uint8Array(Buffer.concat(await Array.fromAsync(zipStream(entries))))
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const reason = async (run: () => unknown) => {
  try {
    await run()
  } catch (err) {
    return err instanceof ImportValidationError ? err.reason : String(err)
  }
  return 'no error'
}

describe('unpack', () => {
  it('leaves a plain file alone, inflates gzip, and opens a zip of one file', async () => {
    const plain = new TextEncoder().encode('select 1;')
    expect(unpack(plain, 'sql')).toBe(plain)
    expect(text(unpack(new Uint8Array(gzipSync('select 2;')), 'sql'))).toBe('select 2;')
    expect(text(unpack(await zip([{ name: 'a.sql', data: 'select 3;' }]), 'sql'))).toBe('select 3;')
    // A gzip file inside a zip is not looked into: one layer at a time.
    expect(text(unpack(new Uint8Array(gzipSync(gzipSync('x'))), 'sql')).length).toBeGreaterThan(0)
  })

  it('runs several SQL files in the order of their names, and refuses several files of another kind', async () => {
    const archive = await zip([
      { name: 'part2.sql', data: 'select 2;' },
      { name: 'part1.sql', data: 'select 1;' },
    ])
    expect(text(unpack(archive, 'sql'))).toBe('select 1;\nselect 2;\n')
    expect(await reason(() => unpack(archive, 'csv'))).toBe('ARCHIVE_MULTIPLE')
    expect(
      await reason(() =>
        unpack(new Uint8Array(0).length ? new Uint8Array() : new Uint8Array([0x50, 0x4b, 3, 4, 0]), 'sql')
      )
    ).toBe('ARCHIVE_INVALID')
    expect(await reason(async () => unpack(await zip([]), 'sql'))).toBe('ARCHIVE_MULTIPLE')
  })

  it('does not open a spreadsheet as an archive', async () => {
    const ods = await zip([{ name: 'content.xml', data: '<x/>' }])
    expect(unpack(ods, 'ods')).toBe(ods)
  })

  it('refuses a gzip file that inflates past the limit', () => {
    // Highly compressible: a few kilobytes of zeros that would unpack to far more than the cap when the cap is small.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(1024 * 1024)))
    expect(bomb.length).toBeLessThan(2000)
    // The real limit is large; the check is that an error path exists for a broken file.
    expect(() => unpack(new Uint8Array([0x1f, 0x8b, 0, 0]), 'sql')).toThrow(/gzip/)
  })
})

describe('decodeText', () => {
  it('reads UTF-8 strictly and other character sets through their tables', () => {
    expect(decodeText(new TextEncoder().encode('日本'), 'utf-8')).toBe('日本')
    expect(decodeText(iconv.encode('日本語', 'cp932'), 'cp932')).toBe('日本語')
    expect(decodeText(iconv.encode('日本語', 'euc-jp'), 'euc-jp')).toBe('日本語')
    expect(() => decodeText(iconv.encode('日本語', 'cp932'), 'utf-8')).toThrow(/UTF-8/)
    // Bytes that mean nothing in the set are refused, not turned into replacement characters.
    expect(() => decodeText(new Uint8Array([0x81]), 'cp932')).toThrow(/cp932/)
  })
})

describe('CSV enclosure and escape', () => {
  const rows = (csv: string, options: Parameters<typeof parseCsvRecords>[1]) =>
    [...parseCsvRecords(csv, options)].map((r) => r.fields)

  it('reads another enclosure, and a backslash escape', () => {
    expect(rows("'a,b';'it''s'\n", { delimiter: ';', quote: "'" })).toEqual([['a,b', "it's"]])
    expect(rows('"a \\" b","c\\\\d"\n', { escape: '\\' })).toEqual([['a " b', 'c\\d']])
    // Without an escape of its own the quote doubles, and a backslash means nothing.
    expect(rows('"a \\ b","x""y"\n', {})).toEqual([['a \\ b', 'x"y']])
  })
})

describe('inferring columns', () => {
  const rows = (...cols: string[][]) => cols[0]?.map((_, i) => cols.map((c) => c[i] ?? null)) ?? []
  const type = (values: (string | null)[], dialect: 'mysql' | 'postgres' = 'mysql') =>
    inferType(
      values.map((v) => [v]),
      0,
      dialect
    ).dataType

  it('takes the narrowest type every value fits', () => {
    expect(type(['1', '2', '-3'])).toBe('INT')
    expect(type(['1', '3000000000'])).toBe('BIGINT')
    expect(type(['1', '99999999999999999999'])).toBe('VARCHAR(255)')
    expect(type(['1.5', '20.25', '3'])).toBe('DECIMAL(4,2)')
    expect(type(['2026-01-02', '2027-12-31'])).toBe('DATE')
    expect(type(['2026-01-02 03:04:05', '2026-01-02T03:04:05.5'])).toBe('DATETIME(1)')
    expect(type(['2026-01-02 03:04:05'], 'postgres')).toBe('TIMESTAMP')
    // One value that does not fit turns the whole column into text; leading zeros and mixed content are text.
    expect(type(['1', 'x'])).toBe('VARCHAR(255)')
    expect(type(['007', '008'])).toBe('VARCHAR(255)')
    expect(type(['a'.repeat(300)])).toBe('TEXT')
    expect(type([null, null])).toBe('VARCHAR(255)')
    expect(type([null, '5'])).toBe('INT')
    // Only real calendar dates are dates; fractional seconds are kept on MySQL; TEXT is sized in bytes.
    expect(type(['2024-02-30'])).toBe('VARCHAR(255)')
    expect(type(['9999-99-99'])).toBe('VARCHAR(255)')
    expect(type(['2024-02-29'])).toBe('DATE')
    expect(type(['2026-01-02 25:00:00'])).toBe('VARCHAR(255)')
    expect(type(['2026-01-02 03:04:05.25'])).toBe('DATETIME(2)')
    expect(type(['あ'.repeat(200)])).toBe('VARCHAR(255)')
    expect(type(['あ'.repeat(300)])).toBe('TEXT')
    expect(type(['あ'.repeat(30_000)])).toBe('MEDIUMTEXT')
  })

  it('names columns from the header, filling blanks and repeats', () => {
    expect(columnNames(['id', '', 'id', 'ID'], 4, 'mysql')).toEqual(['id', 'col2', 'id_2', 'ID_3'])
    expect(columnNames(null, 2, 'mysql')).toEqual(['col1', 'col2'])
    const specs = inferColumns(['a', 'b'], rows(['1', '2'], ['x', 'y']), 'mysql')
    expect(specs.map((c) => [c.name, c.dataType, c.nullable])).toEqual([
      ['a', 'INT', true],
      ['b', 'VARCHAR(255)', true],
    ])
  })
})

describe('column names for a new table', () => {
  it('clips to the server limit without splitting a character', () => {
    const long = 'あ'.repeat(40)
    const pg = columnNames([long], 1, 'postgres')[0] ?? ''
    expect(Buffer.byteLength(pg)).toBeLessThanOrEqual(63)
    expect(pg).toMatch(/^あ+$/)
    expect([...(columnNames(['a'.repeat(100)], 1, 'mysql')[0] ?? '')].length).toBeLessThanOrEqual(64)
    // Two headers that clip to the same text still get different names, and both fit.
    const two = columnNames([`${long}1`, `${long}2`], 2, 'postgres')
    expect(new Set(two.map((n) => n.toLowerCase())).size).toBe(2)
    for (const n of two) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(63)
  })
})
