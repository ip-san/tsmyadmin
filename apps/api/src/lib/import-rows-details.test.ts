import { describe, expect, it } from 'vitest'
import { caught } from '../test/caught.ts'
import { decodeEntities, pickSheet, RowsParseError, readOds } from './import-rows.ts'
import { zipStream } from './zip.ts'

/**
 * Rows read from an OpenDocument spreadsheet: each value and each limit (an XML export and MediaWiki markup are in
 * import-rows-markup-details.test.ts).
 */

describe('decodeEntities', () => {
  it('decodes the five named entities, in any place of the text', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
    expect(decodeEntities('x &amp; y &amp; z')).toBe('x & y & z')
  })

  it('decodes decimal and hexadecimal references, either case of the x', () => {
    expect(decodeEntities('&#65;&#x42;&#X43;&#x4a;&#X4A;')).toBe('ABCJJ')
    expect(decodeEntities('&#1;')).toBe('\u0001')
    expect(decodeEntities('&#128512;')).toBe('\u{1f600}')
    expect(decodeEntities('&#x10ffff;')).toBe('\u{10ffff}')
  })

  it('leaves what is not a valid reference as written: zero, past the last code point, unknown names, other case', () => {
    expect(decodeEntities('&#0;')).toBe('&#0;')
    expect(decodeEntities('&#x0;')).toBe('&#x0;')
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;')
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeEntities('&nbsp; &AMP; &Lt;')).toBe('&nbsp; &AMP; &Lt;')
    expect(decodeEntities('& amp; &amp')).toBe('& amp; &amp')
  })

  it('decodes once: an entity produced by decoding is not decoded again', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('&#38;#65;')).toBe('&#65;')
  })
})

describe('pickSheet', () => {
  const sheets = [{ name: 'a' }, { name: 'b' }, { name: '2' }]

  it('refuses a file without a table, naming what was asked for', async () => {
    const err = await caught<RowsParseError>(() => pickSheet([], 'x'))
    expect(err).toBeInstanceOf(RowsParseError)
    expect(err).toMatchObject({ kind: 'NO_SHEET', message: 'The file holds no table', params: { sheet: 'x' } })
    const unnamed = await caught<RowsParseError>(() => pickSheet([], undefined))
    expect(unnamed).toMatchObject({ message: 'The file holds no table', params: { sheet: '' } })
  })

  it('knows the error by its name', () => {
    expect(new RowsParseError('PARSE', 'm').name).toBe('RowsParseError')
    expect(new RowsParseError('PARSE', 'm').params).toEqual({})
  })

  it('takes a number of more than one digit as a number', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `s${i + 1}` }))
    expect(pickSheet(many, '10')).toBe(many[9])
    expect(pickSheet(many, '12')).toBe(many[11])
  })

  it('takes the first when nothing is asked, or only blanks', () => {
    expect(pickSheet(sheets, undefined)).toBe(sheets[0])
    expect(pickSheet(sheets, '')).toBe(sheets[0])
    expect(pickSheet(sheets, '  \t')).toBe(sheets[0])
  })

  it('takes one by name, and a name before a number', () => {
    expect(pickSheet(sheets, 'b')).toBe(sheets[1])
    expect(pickSheet(sheets, '2')).toBe(sheets[2])
  })

  it('takes one by its 1-based number, spaces around it allowed', () => {
    const plain = [{ name: 'a' }, { name: 'b' }]
    expect(pickSheet(plain, '1')).toBe(plain[0])
    expect(pickSheet(plain, '2')).toBe(plain[1])
    expect(pickSheet(plain, ' 2 ')).toBe(plain[1])
  })

  it('refuses a name or number that is not there, with the message and the name', () => {
    const plain = [{ name: 'a' }, { name: 'b' }]
    for (const wanted of ['zz', '0', '3', '-1', '1.5', 'a ']) {
      let caught: RowsParseError | undefined
      try {
        pickSheet(plain, wanted)
      } catch (e) {
        caught = e as RowsParseError
      }
      expect(caught?.kind, wanted).toBe('NO_SHEET')
      expect(caught?.message, wanted).toBe(`No sheet or table named ${wanted}`)
      expect(caught?.params, wanted).toEqual({ sheet: wanted })
    }
  })
})

const ods = async (body: string) =>
  new Uint8Array(
    Buffer.concat(
      await Array.fromAsync(
        zipStream([
          {
            name: 'content.xml',
            data: `<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x">${body}</office:document-content>`,
          },
        ])
      )
    )
  )
const cell = (attrs: string, inner = '') => `<table:table-cell ${attrs}>${inner}</table:table-cell>`
const row = (...cells: string[]) => `<table:table-row>${cells.join('')}</table:table-row>`
const sheet = (name: string | null, ...rows: string[]) =>
  `<table:table${name === null ? '' : ` table:name="${name}"`}>${rows.join('')}</table:table>`
const cellsOf = async (body: string, options?: Parameters<typeof readOds>[1]) =>
  readOds(await ods(body), options).map((s) => s.rows.map((r) => r.cells))

describe('readOds', () => {
  it('reads each kind of value from the attribute that holds it', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value-type="float" office:value="1.50"'),
          cell('office:value-type="percentage" office:value="0.25"'),
          cell('office:value-type="currency" office:value="9.99" office:currency="USD"'),
          cell('office:value-type="date" office:date-value="2024-02-29"'),
          cell('office:value-type="time" office:time-value="PT01H02M03S"'),
          cell('office:value-type="boolean" office:boolean-value="true"'),
          cell('office:value-type="string" office:string-value="from attr"', '<text:p>ignored</text:p>')
        )
      )
    )
    expect(rows).toEqual([['1.50', '0.25', '9.99', '2024-02-29', 'PT01H02M03S', 'true', 'from attr']])
  })

  it('reads a string from its paragraphs, joined by line breaks, and an empty one as NULL', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value-type="string"', '<text:p>a</text:p><text:p>b</text:p><text:h>c</text:h>'),
          cell('office:value-type="string"', '<text:p></text:p>'),
          cell('office:value-type="string"'),
          cell('office:value-type="string" office:string-value=""', '<text:p>x</text:p>'),
          cell('office:value-type="string"', '<text:p>end</text:p>')
        )
      )
    )
    // An empty string value attribute is NULL too, and does not fall back to the paragraphs.
    expect(rows).toEqual([['a\nb\nc', null, null, null, 'end']])
  })

  it('takes a cell with no type, an unknown type, or a type without its value as NULL', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value="5"', '<text:p>5</text:p>'),
          cell('office:value-type="void"', '<text:p>x</text:p>'),
          cell('office:value-type="float"'),
          cell('office:value-type="date"'),
          cell('office:value-type="time"'),
          cell('office:value-type="boolean"'),
          cell('office:value-type="float" office:value="7"')
        )
      )
    )
    expect(rows).toEqual([[null, null, null, null, null, null, '7']])
  })

  it('reads a percentage, an amount or a date as it is shown, only for the kinds asked', async () => {
    const body = sheet(
      'S',
      row(
        cell('office:value-type="percentage" office:value="0.5"', '<text:p>50%</text:p>'),
        cell('office:value-type="currency" office:value="9.5"', '<text:p>$9.50</text:p>'),
        cell('office:value-type="date" office:date-value="2024-01-02"', '<text:p>1/2/24</text:p>'),
        cell('office:value-type="float" office:value="3"', '<text:p>three</text:p>')
      )
    )
    expect((await cellsOf(body))[0]).toEqual([['0.5', '9.5', '2024-01-02', '3']])
    expect((await cellsOf(body, { odsText: { percentage: true } }))[0]).toEqual([['50%', '9.5', '2024-01-02', '3']])
    expect((await cellsOf(body, { odsText: { currency: true } }))[0]).toEqual([['0.5', '$9.50', '2024-01-02', '3']])
    expect((await cellsOf(body, { odsText: { date: true } }))[0]).toEqual([['0.5', '9.5', '1/2/24', '3']])
    expect((await cellsOf(body, { odsText: { percentage: false, currency: false, date: false } }))[0]).toEqual([
      ['0.5', '9.5', '2024-01-02', '3'],
    ])
    expect((await cellsOf(body, { odsText: { percentage: true, currency: true, date: true } }))[0]).toEqual([
      ['50%', '$9.50', '1/2/24', '3'],
    ])
  })

  it('keeps spaces, tabs and line breaks of a paragraph, and decodes its entities', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell(
            'office:value-type="string"',
            '<text:p>a<text:s text:c="3"/>b<text:s/>c<text:tab/>d<text:line-break/>e</text:p>'
          ),
          cell('office:value-type="string"', '<text:p>1 &lt; 2 &amp; &#65;</text:p>'),
          cell('office:value-type="string"', '<text:p>x<text:s text:c="abc"/>y</text:p>'),
          cell('office:value-type="string"', '<text:p>x<text:s text:c="2000"/>y</text:p>')
        )
      )
    )
    expect(rows).toEqual([[`a   b c\td\ne`, '1 < 2 & A', 'x y', `x${' '.repeat(1000)}y`]])
  })

  it('ignores text outside a paragraph, and a space or tab outside one', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(cell('office:value-type="string"', 'loose<text:s text:c="4"/><text:tab/><text:p>in</text:p>after'))
      )
    )
    expect(rows).toEqual([['in']])
  })

  it('repeats a cell by its count, a missing, zero or unreadable count being one, and caps a row at 5000 cells', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value-type="float" office:value="1" table:number-columns-repeated="3"'),
          cell('office:value-type="float" office:value="2" table:number-columns-repeated="0"'),
          cell('office:value-type="float" office:value="3" table:number-columns-repeated="x"'),
          cell('office:value-type="float" office:value="4"')
        ),
        row(cell('office:value-type="float" office:value="9" table:number-columns-repeated="6000"')),
        row(
          cell('office:value-type="float" office:value="a" table:number-columns-repeated="4999"'),
          cell('office:value-type="float" office:value="b" table:number-columns-repeated="10"')
        )
      )
    )
    expect(rows?.[0]).toEqual(['1', '1', '1', '2', '3', '4'])
    expect(rows?.[1]?.length).toBe(5000)
    expect(rows?.[1]?.every((v) => v === '9')).toBe(true)
    expect(rows?.[2]?.length).toBe(5000)
    expect(rows?.[2]?.[4998]).toBe('a')
    expect(rows?.[2]?.[4999]).toBe('b')
  })

  it('numbers the lines from 1 and counts a repeated row for each of its copies', async () => {
    const sheets = readOds(
      await ods(
        sheet(
          'S',
          `<table:table-row table:number-rows-repeated="2">${cell('office:value-type="float" office:value="1"')}</table:table-row>`,
          `<table:table-row table:number-rows-repeated="3"/>`,
          row(cell('office:value-type="float" office:value="2"')),
          `<table:table-row table:number-rows-repeated="0">${cell('office:value-type="float" office:value="3"')}</table:table-row>`,
          `<table:table-row table:number-rows-repeated="x">${cell('office:value-type="float" office:value="4"')}</table:table-row>`
        )
      )
    )
    expect(sheets[0]?.rows).toEqual([
      { line: 1, cells: ['1'] },
      { line: 2, cells: ['1'] },
      { line: 6, cells: ['2'] },
      { line: 7, cells: ['3'] },
      { line: 8, cells: ['4'] },
    ])
  })

  it('caps a repeated row at 100000 copies but still counts the whole run in the lines after it', async () => {
    const sheets = readOds(
      await ods(
        sheet(
          'S',
          `<table:table-row table:number-rows-repeated="100001">${cell('office:value-type="float" office:value="1"')}</table:table-row>`,
          row(cell('office:value-type="float" office:value="2"'))
        )
      )
    )
    const rows = sheets[0]?.rows ?? []
    expect(rows).toHaveLength(100_001)
    expect(rows[99_999]).toEqual({ line: 100_000, cells: ['1'] })
    expect(rows[100_000]).toEqual({ line: 100_002, cells: ['2'] })
  })

  it('drops the empty cells at the end of a row, keeps the ones between values, and skips a row with none', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value-type="float" office:value="1"'),
          cell('table:number-columns-repeated="2"'),
          cell('office:value-type="float" office:value="2"'),
          cell('table:number-columns-repeated="5"')
        ),
        row(cell('table:number-columns-repeated="3"')),
        row()
      )
    )
    expect(rows).toEqual([['1', null, null, '2']])
  })

  it('keeps a blank row when asked, but not the padding after the last row that holds a value', async () => {
    const body = sheet(
      'S',
      row(),
      row(cell('office:value-type="float" office:value="1"')),
      `<table:table-row table:number-rows-repeated="2"/>`,
      row(cell('office:value-type="float" office:value="2"')),
      `<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="9"/></table:table-row>`
    )
    const sheets = readOds(await ods(body), { skipBlank: false })
    expect(sheets[0]?.rows).toEqual([
      { line: 1, cells: [] },
      { line: 2, cells: ['1'] },
      { line: 3, cells: [] },
      { line: 4, cells: [] },
      { line: 5, cells: ['2'] },
    ])
    expect(readOds(await ods(body), { skipBlank: true })[0]?.rows.map((r) => r.line)).toEqual([2, 5])
    expect(readOds(await ods(body))[0]?.rows.map((r) => r.line)).toEqual([2, 5])
  })

  it('reads a covered cell like a cell', async () => {
    const [rows] = await cellsOf(
      sheet(
        'S',
        row(
          cell('office:value-type="float" office:value="1"'),
          '<table:covered-table-cell office:value-type="float" office:value="2"/>'
        )
      )
    )
    expect(rows).toEqual([['1', '2']])
  })

  it('names the sheets, and a sheet without a name by its place; lines start over in each', async () => {
    const sheets = readOds(
      await ods(
        sheet('First', row(cell('office:value-type="float" office:value="1"'))) +
          sheet(null, row(cell('office:value-type="float" office:value="2"'))) +
          sheet('Third & more', row(cell('office:value-type="float" office:value="3"')))
      )
    )
    expect(sheets.map((s) => s.name)).toEqual(['First', 'Sheet2', 'Third & more'])
    expect(sheets.map((s) => s.rows[0]?.line)).toEqual([1, 1, 1])
  })

  it('answers an empty list for a document without tables, and ignores rows outside one', async () => {
    expect(readOds(await ods(''))).toEqual([])
    expect(readOds(await ods(row(cell('office:value-type="float" office:value="1"'))))).toEqual([])
  })

  it('refuses a zip without content.xml, naming what is missing', async () => {
    const archive = new Uint8Array(
      Buffer.concat(await Array.fromAsync(zipStream([{ name: 'other.xml', data: '<a/>' }])))
    )
    const e = await caught<RowsParseError>(() => readOds(archive))
    expect(e).toBeInstanceOf(RowsParseError)
    expect(e).toMatchObject({
      kind: 'PARSE',
      message: 'content.xml is missing',
      params: { message: 'content.xml is missing' },
    })
  })
})
