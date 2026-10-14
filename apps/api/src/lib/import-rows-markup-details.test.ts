import { describe, expect, it } from 'vitest'
import { readWikiTables, readXmlTables } from './import-rows.ts'

/** Rows read from an XML export or MediaWiki markup: each value and each limit. */

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
