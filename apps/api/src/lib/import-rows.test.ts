import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { collect } from './export.ts'
import { mediawikiBody } from './export-documents.ts'
import { xmlBody } from './export-formats.ts'
import { officeBody } from './export-office.ts'
import { decodeEntities, pickSheet, RowsParseError, readOds, readWikiTables, readXmlTables } from './import-rows.ts'
import { zipStream } from './zip.ts'

const adapter = () =>
  new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'A & B <c>' },
              { id: 2, name: null },
              { id: 3, name: 'line\nbreak | pipe' },
            ]
          ),
          empty: fakeTable('empty', ['id'], []),
        },
      },
    },
  })
const ns = { database: 'shop' }

describe('entities', () => {
  it('decodes the named and numeric ones and leaves an unknown one as written', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &bogus; &#0;')).toBe('a & b <c> AB &bogus; &#0;')
  })
})

describe('ODS', () => {
  it('reads back what the export wrote: numbers, text, empty as NULL, a line break kept', async () => {
    const bytes = new Uint8Array(
      Buffer.concat(await Array.fromAsync(officeBody('ods', adapter(), ns, ['users', 'empty'])))
    )
    const sheets = readOds(bytes)
    expect(sheets.map((s) => s.name)).toEqual(['users', 'empty'])
    expect(sheets[0]?.rows.map((r) => r.cells)).toEqual([
      ['id', 'name'],
      ['1', 'A & B <c>'],
      ['2'],
      ['3', 'line\nbreak | pipe'],
    ])
    // A header-only sheet.
    expect(sheets[1]?.rows.map((r) => r.cells)).toEqual([['id']])
  })

  it('is refused when it is not a spreadsheet', () => {
    expect(() => readOds(new TextEncoder().encode('not a zip'))).toThrow(RowsParseError)
  })

  it('does not grow with a repeat count that claims a million rows', () => {
    // A row repeated a huge number of times is capped; a sheet of empty padding is skipped altogether.
    const content =
      '<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><table:table table:name="T">' +
      '<table:table-row table:number-rows-repeated="4000000000"><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
      '</table:table></office:document-content>'
    return import('./zip.ts').then(async ({ zipStream }) => {
      const archive = new Uint8Array(
        Buffer.concat(await Array.fromAsync(zipStream([{ name: 'content.xml', data: content }])))
      )
      const rows = readOds(archive)[0]?.rows ?? []
      expect(rows.length).toBeLessThanOrEqual(100_000)
      expect(rows[0]?.cells).toEqual(['x'])
    })
  })
})

describe('XML', () => {
  it('reads this tool’s export, with NULL, base64 and a column a row lacks', async () => {
    const xml = await collect(xmlBody(adapter(), ns, ['users']))
    const [users] = readXmlTables(xml)
    expect(users?.header).toEqual(['id', 'name'])
    expect(users?.rows.map((r) => r.cells)).toEqual([
      ['1', 'A & B <c>'],
      ['2', null],
      ['3', 'line\nbreak | pipe'],
    ])
    const custom = readXmlTables(
      '<export><table name="t"><row><column name="a">1</column></row><row><column name="b" encoding="base64">AAE=</column></row></table></export>'
    )
    expect(custom[0]?.header).toEqual(['a', 'b'])
    expect(custom[0]?.rows.map((r) => r.cells)).toEqual([
      ['1', null],
      [null, { base64: 'AAE=' }],
    ])
  })

  it('reads phpMyAdmin’s form, a table element per row, and does not follow an external entity', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE pma_xml_export [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<pma_xml_export><database name="db">
<table name="t"><column name="id">1</column><column name="v">&xxe; &amp; x</column></table>
<table name="t"><column name="id">2</column><column name="v" null="true"/></table>
</database></pma_xml_export>`
    const [t] = readXmlTables(xml)
    expect(t?.rows.map((r) => r.cells)).toEqual([
      ['1', '&xxe; & x'],
      ['2', null],
    ])
  })
})

describe('MediaWiki', () => {
  it('reads what the export wrote', async () => {
    const wiki = await collect(mediawikiBody(adapter(), ns, ['users']))
    const [t] = readWikiTables(wiki)
    expect(t?.name).toBe('users')
    expect(t?.header).toEqual(['id', 'name'])
    expect(t?.rows.map((r) => r.cells)).toEqual([
      ['1', 'A & B <c>'],
      ['2', null],
      ['3', 'line\nbreak | pipe'],
    ])
  })

  it('reads several cells to a line, cell attributes and a table without a header row', () => {
    const [t] = readWikiTables('{| class="wikitable"\n|-\n| 1 || style="color:red" | two\n|-\n| 3 || 4\n|}')
    expect(t?.header).toBeNull()
    expect(t?.rows.map((r) => r.cells)).toEqual([
      ['1', 'two'],
      ['3', '4'],
    ])
  })
})

describe('pickSheet', () => {
  const sheets = [{ name: 'a' }, { name: 'b' }]
  it('takes the first, or one by name or number, and says when there is none', () => {
    expect(pickSheet(sheets, undefined)).toBe(sheets[0])
    expect(pickSheet(sheets, 'b')).toBe(sheets[1])
    expect(pickSheet(sheets, '2')).toBe(sheets[1])
    expect(() => pickSheet(sheets, 'nope')).toThrow(RowsParseError)
    expect(() => pickSheet([], undefined)).toThrow(/no table/)
  })
})

describe('the XML scanner on hostile input', () => {
  it('takes linear time for many unterminated comments, tags and CDATA sections', () => {
    const started = performance.now()
    for (const piece of ['<!--', '<?x ', '<![CDATA[', '<a b="', '<']) readXmlTables(piece.repeat(50_000))
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('skips comments and processing instructions and reads CDATA as text', () => {
    const [t] = readXmlTables(
      '<?xml version="1.0"?><!-- c --><table name="t"><row><column name="a"><![CDATA[<x>]]></column></row></table>'
    )
    expect(t?.rows[0]?.cells).toEqual(['<x>'])
  })
})

describe('reading choices', () => {
  const bytes = async (kind: 'ods', o?: Parameters<typeof officeBody>[4]) =>
    new Uint8Array(Buffer.concat(await Array.fromAsync(officeBody(kind, adapter(), ns, ['users'], o))))

  /** A one-sheet spreadsheet written by hand: a percentage, a currency amount and a date, each with its shown text. */
  const sheet = async (rows: string) =>
    new Uint8Array(
      Buffer.concat(
        await Array.fromAsync(
          zipStream([
            {
              name: 'content.xml',
              data: `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet><table:table table:name="S">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`,
            },
          ])
        )
      )
    )

  it('reads a percentage, a currency amount and a date as the value or as shown', async () => {
    const row =
      '<table:table-row>' +
      '<table:table-cell office:value-type="percentage" office:value="0.25"><text:p>25%</text:p></table:table-cell>' +
      '<table:table-cell office:value-type="currency" office:value="5" office:currency="USD"><text:p>$5.00</text:p></table:table-cell>' +
      '<table:table-cell office:value-type="date" office:date-value="2024-01-02"><text:p>Jan 2, 2024</text:p></table:table-cell>' +
      '</table:table-row>'
    const file = await sheet(row)
    expect(readOds(file)[0]?.rows[0]?.cells).toEqual(['0.25', '5', '2024-01-02'])
    expect(readOds(file, { odsText: { percentage: true } })[0]?.rows[0]?.cells).toEqual(['25%', '5', '2024-01-02'])
    expect(readOds(file, { odsText: { currency: true, date: true } })[0]?.rows[0]?.cells).toEqual([
      '0.25',
      '$5.00',
      'Jan 2, 2024',
    ])
  })

  it('leaves empty rows out, or keeps those between the rows that have values', async () => {
    const full =
      '<table:table-row><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell></table:table-row>'
    const empty = '<table:table-row><table:table-cell/></table:table-row>'
    const file = await sheet(`${full}${empty}${full}${empty}${empty}`)
    expect(readOds(file)[0]?.rows.map((r) => r.cells)).toEqual([['a'], ['a']])
    expect(readOds(file, { skipBlank: false })[0]?.rows.map((r) => r.cells)).toEqual([['a'], [], ['a']])
  })

  it('reads XML and wiki rows with no values only when asked', () => {
    const xml = '<export><table name="t"><row><column name="a">1</column></row><row></row></table></export>'
    expect(readXmlTables(xml)[0]?.rows).toHaveLength(1)
    expect(readXmlTables(xml, { skipBlank: false })[0]?.rows).toHaveLength(2)
    const wiki = '{| class="wikitable"\n|-\n! a\n|-\n| 1\n|-\n|-\n| 2\n|}\n'
    expect(readWikiTables(wiki)[0]?.rows.map((r) => r.cells)).toEqual([['1'], ['2']])
    expect(readWikiTables(wiki, { skipBlank: false })[0]?.rows.map((r) => r.cells)).toEqual([['1'], [], ['2']])
  })

  it('does not read a table’s structure, in this tool’s XML, as rows of data', async () => {
    const xml = await collect(xmlBody(adapter(), ns, ['users'], { structure: true, data: true }))
    expect(xml).toContain('<structure>')
    const table = readXmlTables(xml)[0]
    expect(table?.header).toEqual(['id', 'name'])
    expect(table?.rows).toHaveLength(3)
    expect((await bytes('ods')).length).toBeGreaterThan(0)
  })
})
