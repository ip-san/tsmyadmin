import { describe, expect, it } from 'vitest'
import { caught } from '../test/caught.ts'
import { decodeEntities, pickSheet, RowsParseError, readOds, readWikiTables, readXmlTables } from './import-rows.ts'
import { zipStream } from './zip.ts'

/** Rows read from an OpenDocument spreadsheet, an XML export or MediaWiki markup: each value and each limit. */

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

describe('readXmlTables', () => {
  it('reads this tool’s export: a header from the column names, values as text, NULL, and bytes as base64', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<export database="d">
  <table name="t">
    <row><column name="id">1</column><column name="n">a &amp; b</column><column name="x" null="true"/><column name="b" encoding="base64"> AQID </column></row>
    <row><column name="id">2</column><column name="n"></column><column name="x">z</column><column name="b" null="true" encoding="base64">AQ==</column></row>
  </table>
</export>`
    expect(readXmlTables(xml)).toEqual([
      {
        name: 't',
        header: ['id', 'n', 'x', 'b'],
        rows: [
          { line: 1, cells: ['1', 'a & b', null, { base64: 'AQID' }] },
          { line: 2, cells: ['2', '', 'z', null] },
        ],
      },
    ])
  })

  it('reads phpMyAdmin’s form: one table element for each row', () => {
    const xml = `<pma_xml_export><database name="d">
<table name="t"><column name="id">1</column><column name="n">a</column></table>
<table name="t"><column name="id">2</column><column name="n">b</column></table>
<table name="u"><column name="k">z</column></table>
</database></pma_xml_export>`
    expect(readXmlTables(xml)).toEqual([
      {
        name: 't',
        header: ['id', 'n'],
        rows: [
          { line: 1, cells: ['1', 'a'] },
          { line: 2, cells: ['2', 'b'] },
        ],
      },
      { name: 'u', header: ['k'], rows: [{ line: 3, cells: ['z'] }] },
    ])
  })

  it('leaves the structure out: its columns are not rows', () => {
    const xml = `<export><table name="t"><structure><column name="id" type="int"/><column name="n" type="text"/></structure>
<row><column name="id">1</column></row></table></export>`
    expect(readXmlTables(xml)).toEqual([{ name: 't', header: ['id'], rows: [{ line: 1, cells: ['1'] }] }])
    // After the structure closes, columns count again.
    const after = `<export><table name="t"><structure><column name="id"/></structure><column name="a">1</column></table></export>`
    expect(readXmlTables(after)).toEqual([{ name: 't', header: ['a'], rows: [{ line: 1, cells: ['1'] }] }])
  })

  it('completes the header from all rows: a row without a column has NULL there', () => {
    const xml = `<export><table name="t">
<row><column name="a">1</column></row>
<row><column name="a">2</column><column name="b">3</column></row>
<row><column name="b">4</column></row>
</table></export>`
    expect(readXmlTables(xml)[0]).toEqual({
      name: 't',
      header: ['a', 'b'],
      rows: [
        { line: 1, cells: ['1', null] },
        { line: 2, cells: ['2', '3'] },
        { line: 3, cells: [null, '4'] },
      ],
    })
  })

  it('counts lines across the tables of a file', () => {
    const xml = `<export><table name="a"><row><column name="x">1</column></row><row><column name="x">2</column></row></table>
<table name="b"><row><column name="y">3</column></row></table></export>`
    expect(readXmlTables(xml).map((t) => t.rows.map((r) => r.line))).toEqual([[1, 2], [3]])
  })

  it('names a table without a name by its place', () => {
    const xml = `<export><table><row><column name="x">1</column></row></table></export>`
    expect(readXmlTables(xml)[0]?.name).toBe('table1')
    const two = `<export><table name="a"><row><column name="x">1</column></row></table><table><row><column name="x">1</column></row></table></export>`
    expect(readXmlTables(two).map((t) => t.name)).toEqual(['a', 'table2'])
  })

  it('skips an empty row, or keeps it when asked (every column NULL)', () => {
    const xml = `<export><table name="t"><row><column name="a">1</column></row><row></row><row/><table-end/></table></export>`
    expect(readXmlTables(xml)[0]?.rows).toEqual([{ line: 1, cells: ['1'] }])
    expect(readXmlTables(xml, { skipBlank: true })[0]?.rows).toEqual([{ line: 1, cells: ['1'] }])
    expect(readXmlTables(xml, { skipBlank: false })[0]?.rows).toEqual([
      { line: 1, cells: ['1'] },
      { line: 2, cells: [null] },
      { line: 3, cells: [null] },
    ])
    const onlyBlank = `<export><table name="t"><row/></table></export>`
    expect(readXmlTables(onlyBlank)).toEqual([])
    expect(readXmlTables(onlyBlank, { skipBlank: false })).toEqual([
      { name: 't', header: [], rows: [{ line: 1, cells: [] }] },
    ])
  })

  it('writes nothing for a table element without columns or rows', () => {
    expect(readXmlTables('<export><table name="t"></table></export>')).toEqual([])
    expect(readXmlTables('')).toEqual([])
  })

  it('reads CDATA as it is, entities in text and in attribute values, and ignores comments', () => {
    const xml = `<export><table name="a&amp;b"><!-- <row> --><row><column name="c&lt;d"><![CDATA[<x> & y]]></column><column name="e">1 &lt; 2<!-- c --> &#65;</column></row></table></export>`
    expect(readXmlTables(xml)).toEqual([
      { name: 'a&b', header: ['c<d', 'e'], rows: [{ line: 1, cells: ['<x> & y', '1 < 2 A'] }] },
    ])
  })

  it('skips comments and processing instructions whole, even when a ">" is inside them', () => {
    const xml = `<export><table name="t"><row><column name="a">x<!-- a > b -->y<?pi a > b ?>z<!DOCTYPE q>w</column></row></table></export>`
    expect(readXmlTables(xml)[0]?.rows[0]?.cells).toEqual(['xyzw'])
    // An unterminated one swallows the rest of the file, and no more.
    expect(readXmlTables('<export><table name="t"><row><column name="a">x</column></row></table><!-- open')).toEqual([
      { name: 't', header: ['a'], rows: [{ line: 1, cells: ['x'] }] },
    ])
  })

  it('ignores a column without a name, and accepts single-quoted attributes', () => {
    const xml = `<export><table name='t'><row><column>skipped</column><column name='a' null='true'/><column name="b">1</column></row></table></export>`
    expect(readXmlTables(xml)).toEqual([{ name: 't', header: ['a', 'b'], rows: [{ line: 1, cells: [null, '1'] }] }])
  })

  it('treats null="true" only, and base64 only when the encoding says so', () => {
    const xml = `<export><table name="t"><row><column name="a" null="false">x</column><column name="b" null="1">y</column><column name="c" encoding="hex">zz</column></row></table></export>`
    expect(readXmlTables(xml)[0]?.rows[0]?.cells).toEqual(['x', 'y', 'zz'])
  })
})

describe('readWikiTables', () => {
  it('reads this tool’s tables: the caption, the header, the rows, NULL, and the line of each row', () => {
    const wiki = [
      '{| class="wikitable"',
      '|+ users',
      '|-',
      '! id',
      '! name',
      '|-',
      '| 1',
      '| a',
      '|-',
      '| 2',
      "| ''NULL''",
      '|}',
    ].join('\n')
    expect(readWikiTables(wiki)).toEqual([
      {
        name: 'users',
        header: ['id', 'name'],
        rows: [
          { line: 7, cells: ['1', 'a'] },
          { line: 10, cells: ['2', null] },
        ],
      },
    ])
  })

  it('reads several cells on one line, header cells joined by !!, and the style before a cell', () => {
    const wiki = [
      '{|',
      '|-',
      '! style="x" | id !! name !! class=c | third',
      '|-',
      '| 1 || style="color:red" | two || a | b',
      '|-',
      '| x=y | z',
      '|}',
    ].join('\n')
    const [t] = readWikiTables(wiki)
    expect(t?.header).toEqual(['id', 'name', 'third'])
    expect(t?.rows).toEqual([
      { line: 5, cells: ['1', 'two', 'a | b'] },
      { line: 7, cells: ['z'] },
    ])
  })

  it('names tables by place when there is no caption, and keeps the name when the caption is NULL', () => {
    const wiki = [
      '{|',
      '|-',
      '| 1',
      '|}',
      '{|',
      "|+ ''NULL''",
      '|-',
      '| 2',
      '|}',
      '{|',
      '|+ A &amp; B',
      '|-',
      '| 3',
      '|}',
    ].join('\n')
    expect(readWikiTables(wiki).map((t) => t.name)).toEqual(['table1', 'table2', 'A & B'])
  })

  it('has no header when the table has no header cells', () => {
    const [t] = readWikiTables(['{|', '|-', '| 1', '|}'].join('\n'))
    expect(t?.header).toBeNull()
    expect(t?.rows).toEqual([{ line: 3, cells: ['1'] }])
  })

  it('takes the first header row as the header; a later one is a row of its own', () => {
    const wiki = ['{|', '|-', '! a', '|-', '! b', '|-', '| 1', '|}'].join('\n')
    const [t] = readWikiTables(wiki)
    expect(t?.header).toEqual(['a'])
    expect(t?.rows).toEqual([{ line: 7, cells: ['1'] }])
  })

  it('reads line breaks, entities, and the lines a cell goes on over', () => {
    const wiki = [
      '{|',
      '|-',
      '| a<br />b<BR>c<br/>d &lt;e&gt; &amp;',
      'second',
      'third',
      "| ''NULL''",
      'now text',
      '|}',
    ].join('\n')
    const [t] = readWikiTables(wiki)
    expect(t?.rows[0]?.cells).toEqual(['a\nb\nc\nd <e> &\nsecond\nthird', 'now text'])
  })

  it('ignores blank lines in a cell, text outside tables, and the end of the lines of either kind', () => {
    const wiki = 'before\r\n{|\r\n|-\r\n| a  \r\n\r\n| b\r\n|}\r\nafter | not a cell\r\n'
    expect(readWikiTables(wiki)).toEqual([{ name: 'table1', header: null, rows: [{ line: 4, cells: ['a', 'b'] }] }])
    expect(readWikiTables('{|\r|-\r| a\r|}')[0]?.rows).toEqual([{ line: 3, cells: ['a'] }])
  })

  it('skips an empty row, or keeps it when asked', () => {
    const wiki = ['{|', '|-', '|-', '| 1', '|-', '|}'].join('\n')
    expect(readWikiTables(wiki)[0]?.rows).toEqual([{ line: 4, cells: ['1'] }])
    expect(readWikiTables(wiki, { skipBlank: false })[0]?.rows).toEqual([
      { line: 2, cells: [] },
      { line: 4, cells: ['1'] },
      { line: 5, cells: [] },
    ])
  })

  it('finishes a row at the end of the table, and leaves a table that never closes as read so far', () => {
    expect(readWikiTables(['{|', '|-', '| 1', '|}'].join('\n'))[0]?.rows).toEqual([{ line: 3, cells: ['1'] }])
    const open = readWikiTables(['{|', '|+ cap', '|-', '| 1', '|-'].join('\n'))
    expect(open[0]?.name).toBe('cap')
    expect(open[0]?.rows).toEqual([{ line: 4, cells: ['1'] }])
  })

  it('reads a header line that comes before any |-, and cells before any row line', () => {
    const [t] = readWikiTables(['{|', '! h', '| 1', '|-', '| 2', '|}'].join('\n'))
    expect(t?.header).toEqual(['h'])
    expect(t?.rows).toEqual([{ line: 5, cells: ['2'] }])
  })

  it('gives no table for text without {|', () => {
    expect(readWikiTables('| a\n|-\n| b')).toEqual([])
    expect(readWikiTables('|+ caption\n! h\n|-\n| a\n|}\nfree text')).toEqual([])
  })

  it('takes a line that starts with a space as the continuation of a cell, and one that ends in |} or |- as a cell', () => {
    const [t] = readWikiTables(['{|', '|-', '| a', ' | b', '| c |}', '| d |-', '|}'].join('\n'))
    expect(t?.rows).toEqual([{ line: 3, cells: ['a\n| b', 'c |}', 'd |-'] }])
  })

  it('ignores text before the first cell of a row', () => {
    const wiki = ['{|', 'stray', '|-', 'also stray', '| 1', '|}'].join('\n')
    expect(readWikiTables(wiki)).toEqual([{ name: 'table1', header: null, rows: [{ line: 5, cells: ['1'] }] }])
    expect(readWikiTables(['{|', '|-', 'stray', '|}'].join('\n'), { skipBlank: false })[0]?.rows).toEqual([
      { line: 2, cells: [] },
    ])
  })
})
