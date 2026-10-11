import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from './api.ts'
import { enumChoices } from './enum-values.ts'
import {
  columnsField,
  csvCharsValid,
  DEFAULT_IMPORT_OPTIONS,
  detectFormat,
  type ImportOptions,
  importFields,
  isRowsFormat,
} from './import-options.ts'
import { ndjsonEvents, streamError } from './ndjson.ts'

/** The lines of a stream read back, an enum's values, and the form fields an import sends (found by mutation testing). */

const encoder = new TextEncoder()
/** The chunks as a body; with `cancel` the stream is left open, so that closing it early reaches the source. */
const body = (chunks: string[], cancel?: () => void) =>
  new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      if (!cancel) controller.close()
    },
    ...(cancel ? { cancel } : {}),
  })
const events = async (chunks: string[]) => {
  const out: unknown[] = []
  for await (const e of ndjsonEvents(body(chunks), z.object({ n: z.number() }))) out.push(e)
  return out
}

describe('streamError', () => {
  it('reads the JSON error a route answered with, and the bare status when there is none', async () => {
    const e = await streamError(new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'gone' }), { status: 404 }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'gone' })
    const plain = await streamError(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(plain).toMatchObject({ status: 502, code: 'INTERNAL', message: 'HTTP 502' })
    const odd = await streamError(new Response(JSON.stringify({ unexpected: true }), { status: 500 }))
    expect(odd).toMatchObject({ status: 500, code: 'INTERNAL', message: 'HTTP 500' })
    expect(await streamError(new Response(null, { status: 503 }))).toMatchObject({
      code: 'INTERNAL',
      message: 'HTTP 503',
    })
  })
})

describe('ndjsonEvents', () => {
  it('yields each line as an event, a line split between chunks being put back together', async () => {
    expect(await events(['{"n":1}\n{"n":2}\n'])).toEqual([{ n: 1 }, { n: 2 }])
    expect(await events(['{"n"', ':1}\n{"n":', '2}\n'])).toEqual([{ n: 1 }, { n: 2 }])
    expect(await events(['{"n":1}\n{"n":2}\n{"n":3}\n'])).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('skips the blank lines the server sends as heartbeats, and trims a line', async () => {
    expect(await events(['\n\n{"n":1}\n  \n\r\n  {"n":2}  \r\n\n'])).toEqual([{ n: 1 }, { n: 2 }])
    expect(await events([])).toEqual([])
    expect(await events(['\n\n'])).toEqual([])
  })

  it('yields a last line that arrives without its newline, and not a blank one', async () => {
    expect(await events(['{"n":1}\n{"n":2}'])).toEqual([{ n: 1 }, { n: 2 }])
    expect(await events(['{"n":1}\n   '])).toEqual([{ n: 1 }])
    expect(await events(['{"n":7}'])).toEqual([{ n: 7 }])
  })

  it('stops with the error of a line that is not an event, and closes the body first', async () => {
    const cancel = vi.fn()
    const seen: unknown[] = []
    await expect(
      (async () => {
        for await (const e of ndjsonEvents(body(['{"n":1}\nnot json\n{"n":3}\n'], cancel), z.object({ n: z.number() })))
          seen.push(e)
      })()
    ).rejects.toThrow(SyntaxError)
    expect(seen).toEqual([{ n: 1 }])
    expect(cancel).toHaveBeenCalled()
    await expect(events(['{"n":"one"}\n'])).rejects.toThrow(z.ZodError)
    await expect(events(['{"n":1}\n{"x":1}'])).rejects.toThrow(z.ZodError)
  })
})

describe('enumChoices', () => {
  it('reads the values of an enum or a set, in any case, with or without space before the parenthesis', () => {
    expect(enumChoices("enum('a','b')")).toEqual(['a', 'b'])
    expect(enumChoices("ENUM('a', 'b' ,'c')")).toEqual(['a', 'b', 'c'])
    expect(enumChoices("set('x','y')")).toEqual(['x', 'y'])
    expect(enumChoices("SET ('x')")).toEqual(['x'])
    expect(enumChoices("  enum('a')  ")).toEqual(['a'])
    expect(enumChoices("enum('a,b','c')")).toEqual(['a,b', 'c'])
    expect(enumChoices("enum('a)b')")).toEqual(['a)b'])
    expect(enumChoices("enum('日本','語')")).toEqual(['日本', '語'])
    expect(enumChoices("enum('')")).toEqual([''])
  })

  it('undoes a doubled quote and a backslash escape inside a value', () => {
    expect(enumChoices("enum('it''s')")).toEqual(["it's"])
    expect(enumChoices("enum('it\\'s')")).toEqual(["it's"])
    expect(enumChoices("enum('back\\\\slash')")).toEqual(['back\\slash'])
    expect(enumChoices("enum('a''','''b')")).toEqual(["a'", "'b"])
  })

  it('gives null for another type, no values, or a list it cannot read', () => {
    for (const none of [
      'varchar(5)',
      'int',
      'enumx',
      "xenum('a')",
      "enum('a'",
      "enum('a",
      'enum()',
      'enum( )',
      'enum(a)',
      "enum('a'b)",
      '',
      "enum('a\\",
    ])
      expect(enumChoices(none), none).toBeNull()
  })
})

describe('import form fields', () => {
  const opts = (extra: Partial<ImportOptions> = {}): ImportOptions => ({ ...DEFAULT_IMPORT_OPTIONS, ...extra })

  it('turns the columns the user typed into the list the server reads, a blank one staying, none when empty', () => {
    expect(columnsField('')).toBeUndefined()
    expect(columnsField('   ')).toBeUndefined()
    expect(columnsField('a')).toBe('["a"]')
    expect(columnsField(' a , b ,c')).toBe('["a","b","c"]')
    expect(columnsField('a,,c')).toBe('["a","","c"]')
  })

  it('suggests the format from the file name, reading a .gz as what is inside it', () => {
    const cases: [string, string | null][] = [
      ['dump.sql', 'sql'],
      ['DUMP.SQL', 'sql'],
      ['dump.sql.gz', 'sql'],
      ['data.csv', 'csv'],
      ['data.CSV.GZ', 'csv'],
      ['sheet.ods', 'ods'],
      ['data.xml', 'xml'],
      ['page.wiki', 'mediawiki'],
      ['page.mediawiki', 'mediawiki'],
      ['a.gz', null],
      ['x.tar.gz', null],
      ['noextension', null],
      ['data.txt', null],
      ['.sql', 'sql'],
      ['', null],
    ]
    for (const [name, format] of cases) expect(detectFormat(name), name).toBe(format)
  })

  it('shares the row choices among all formats but SQL', () => {
    expect(isRowsFormat('sql')).toBe(false)
    for (const f of ['csv', 'ods', 'xml', 'mediawiki'] as const) expect(isRowsFormat(f), f).toBe(true)
  })

  it("sends a SQL file's four switches as 1 or 0, with its character set and the lines to skip when there are some", () => {
    expect(importFields('sql', opts())).toEqual({
      charset: 'utf-8',
      stopOnError: '1',
      ignoreForeignKeys: '0',
      singleTransaction: '0',
      noAutoValueOnZero: '0',
    })
    expect(
      importFields(
        'sql',
        opts({ skip: 3, stopOnError: false, ignoreForeignKeys: true, singleTransaction: true, noAutoValueOnZero: true })
      )
    ).toEqual({
      charset: 'utf-8',
      skip: '3',
      stopOnError: '0',
      ignoreForeignKeys: '1',
      singleTransaction: '1',
      noAutoValueOnZero: '1',
    })
  })

  it('sends the row choices of the other formats, the column mapping only when the table is not being created', () => {
    const rows = importFields(
      'xml',
      opts({ onDuplicate: 'replace', skipBlank: false, createTable: false, columns: ' a , b ' })
    )
    expect(rows).toEqual({
      charset: 'utf-8',
      onDuplicate: 'replace',
      createTable: '0',
      skipBlank: '0',
      columns: '["a","b"]',
    })
    expect(importFields('xml', opts({ createTable: true, columns: 'a,b' }))).toEqual({
      charset: 'utf-8',
      onDuplicate: 'error',
      createTable: '1',
      skipBlank: '1',
    })
    expect(importFields('xml', opts({ skip: 2 }))).toMatchObject({ skip: '2' })
    expect(importFields('xml', opts({ skip: 0 }))).not.toHaveProperty('skip')
    expect(importFields('mediawiki', opts({ sheet: '  Sheet1 ' }))).toMatchObject({ sheet: 'Sheet1' })
    expect(importFields('mediawiki', opts({ sheet: '   ' }))).not.toHaveProperty('sheet')
    expect(importFields('xml', opts())).not.toHaveProperty('header')
    expect(importFields('xml', opts())).not.toHaveProperty('odsPercent')
  })

  it('adds the spreadsheet choices for ODS and the separators for CSV, and each only for its own', () => {
    expect(importFields('ods', opts({ odsPercent: 'text', odsCurrency: 'text', odsDate: 'text' }))).toMatchObject({
      odsPercent: 'text',
      odsCurrency: 'text',
      odsDate: 'text',
    })
    expect(importFields('ods', opts())).not.toHaveProperty('delimiter')
    expect(importFields('csv', opts())).toEqual({
      charset: 'utf-8',
      onDuplicate: 'error',
      createTable: '0',
      skipBlank: '1',
      lineEnd: 'auto',
      header: '1',
      nullMarker: '\\N',
      delimiter: ',',
      enclosure: '"',
      escape: '"',
    })
    expect(
      importFields(
        'csv',
        opts({ header: false, delimiter: ';', enclosure: "'", escape: '\\', nullMarker: 'NULL', lineEnd: 'lf' })
      )
    ).toMatchObject({
      header: '0',
      delimiter: ';',
      enclosure: "'",
      escape: '\\',
      nullMarker: 'NULL',
      lineEnd: 'lf',
    })
    expect(importFields('csv', opts())).not.toHaveProperty('odsPercent')
  })

  it('accepts a CSV whose separator and quoting are one character each, the delimiter being no quote or line break', () => {
    expect(csvCharsValid(opts())).toBe(true)
    expect(csvCharsValid(opts({ delimiter: '\t' }))).toBe(true)
    expect(csvCharsValid(opts({ delimiter: ';', enclosure: "'", escape: '\\' }))).toBe(true)
    for (const bad of [
      { delimiter: '' },
      { delimiter: ',,' },
      { delimiter: '"' },
      { delimiter: '\n' },
      { delimiter: '\r' },
      { enclosure: '' },
      { enclosure: '""' },
      { escape: '' },
      { escape: '\\\\' },
    ]) {
      expect(csvCharsValid(opts(bad)), JSON.stringify(bad)).toBe(false)
    }
  })
})
