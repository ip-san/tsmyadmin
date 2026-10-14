import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { collect } from './export.ts'
import { markdownBody, xmlBody, yamlBody } from './export-formats.ts'

/** XML, YAML and Markdown exports: the exact text each writes, and what each refuses or escapes. */

const ns = { database: 'shop' }
const both = { structure: true, data: true }
const none = { structure: false, data: false }
const withRows = (rows: Record<string, unknown>[], columns = ['id', 'name']) =>
  new FakeAdapter({ databases: { shop: { tables: { t: fakeTable('t', columns, rows as never) } } } })

describe('xmlBody', () => {
  it('names the database, and the schema only when there is one, escaping both', async () => {
    const a = new FakeAdapter()
    expect(await collect(xmlBody(a, { database: 'a&b"' }, []))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<export database="a&amp;b&quot;">\n</export>\n'
    )
    expect(await collect(xmlBody(a, { database: 'd', schema: 'p<q' }, []))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<export database="d" schema="p&lt;q">\n</export>\n'
    )
  })

  it('writes each row with every value told apart: NULL, binary, text, numbers', async () => {
    const a = withRows([
      { id: 1, name: 'x & <y> "z"' },
      { id: 2, name: null },
      { id: true, name: { $bin: 'AQID' } },
    ])
    expect(await collect(xmlBody(a, ns, ['t']))).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<export database="shop">',
        '  <table name="t">',
        '    <row>',
        '      <column name="id">1</column>',
        '      <column name="name">x &amp; &lt;y&gt; &quot;z&quot;</column>',
        '    </row>',
        '    <row>',
        '      <column name="id">2</column>',
        '      <column name="name" null="true"/>',
        '    </row>',
        '    <row>',
        '      <column name="id">true</column>',
        '      <column name="name" encoding="base64">AQID</column>',
        '    </row>',
        '  </table>',
        '</export>',
        '',
      ].join('\n')
    )
  })

  it('keeps the empty string, tab and line breaks as they are, and escapes names', async () => {
    const a = new FakeAdapter({
      databases: { shop: { tables: { 'a&b': fakeTable('a&b', ['x<y'], [{ 'x<y': '' }, { 'x<y': 'a\tb\r\nc' }]) } } },
    })
    const xml = await collect(xmlBody(a, ns, ['a&b']))
    expect(xml).toContain('<table name="a&amp;b">')
    expect(xml).toContain('<column name="x&lt;y"></column>')
    expect(xml).toContain('<column name="x&lt;y">a\tb\r\nc</column>')
  })

  it('carries text XML cannot hold as base64 of its UTF-8 bytes', async () => {
    for (const bad of ['a\u0000b', 'a\u0001b', 'a\u001fb', 'a￾b', 'a￿b']) {
      const xml = await collect(xmlBody(withRows([{ id: 1, name: bad }]), ns, ['t']))
      expect(xml).toContain(
        `<column name="name" encoding="base64">${Buffer.from(bad, 'utf8').toString('base64')}</column>`
      )
    }
    // The characters at the edges of the forbidden range are fine as text.
    const ok = await collect(xmlBody(withRows([{ id: 1, name: ' \u0009\u000a\u000d�￼' }]), ns, ['t']))
    expect(ok).not.toContain('base64')
  })

  it('refuses a cut text', async () => {
    const a = withRows([{ id: 1, name: { $text: 'ab', length: 9 } }])
    await expect(collect(xmlBody(a, ns, ['t']))).rejects.toThrow('truncated text')
  })

  it('writes the structure as attributes, leaving out a default that is NULL and what is empty', async () => {
    const tbl = fakeTable('t', ['id', 'name', 'plain'], [])
    const [id, name] = tbl.schema.columns
    Object.assign(name as object, { nullable: true, default: "it's", extra: 'auto_increment', comment: 'a\nb' })
    Object.assign(id as object, { default: '' })
    tbl.schema.indexes.push({
      name: 'u',
      unique: true,
      primary: false,
      columns: ['name'],
      type: null,
      predicate: null,
      definition: null,
      lengths: {},
    })
    const a = new FakeAdapter({ databases: { shop: { tables: { t: tbl } } } })
    expect(await collect(xmlBody(a, ns, ['t'], { structure: true, data: false }))).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<export database="shop">',
        '  <table name="t">',
        '    <structure>',
        '      <column name="id" type="int" nullable="false" default="" key="PRI"/>',
        '      <column name="name" type="varchar" nullable="true" default="it\'s" key="UNI" extra="auto_increment" comment="a&#10;b"/>',
        '      <column name="plain" type="varchar" nullable="false"/>',
        '    </structure>',
        '  </table>',
        '</export>',
        '',
      ].join('\n')
    )
  })

  it('escapes attribute values: quotes, line breaks, tabs, and what XML cannot carry', async () => {
    const tbl = fakeTable('t', ['id'], [])
    Object.assign(tbl.schema.columns[0] as object, { comment: 'a"b&c<d>\r\n\te\u0001f' })
    const a = new FakeAdapter({ databases: { shop: { tables: { t: tbl } } } })
    const xml = await collect(xmlBody(a, ns, ['t'], { structure: true, data: false }))
    expect(xml).toContain('comment="a&quot;b&amp;c&lt;d&gt;&#13;&#10;&#9;e�f"')
  })

  it('writes the structure and the data of a table in that order, and skips what is not asked', async () => {
    const a = withRows([{ id: 1, name: 'a' }])
    const xml = await collect(xmlBody(a, ns, ['t'], both))
    expect(xml.indexOf('<structure>')).toBeGreaterThan(xml.indexOf('<table name="t">'))
    expect(xml.indexOf('<row>')).toBeGreaterThan(xml.indexOf('</structure>'))
    const b = withRows([{ id: 1, name: 'a' }])
    expect(await collect(xmlBody(b, ns, ['t'], none))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<export database="shop">\n  <table name="t">\n  </table>\n</export>\n'
    )
    expect(b.calls.some((c) => c.method === 'iterateRows')).toBe(false)
  })

  it('writes an empty table as a table without rows', async () => {
    const xml = await collect(xmlBody(withRows([]), ns, ['t']))
    expect(xml).not.toContain('<row>')
    expect(xml).toContain('  <table name="t">\n  </table>\n')
  })

  describe('objects', () => {
    class Stub extends FakeAdapter {
      override async listTriggers() {
        return [
          { name: 'g1', table: 't', timing: 'BEFORE', events: 'INSERT', orientation: 'ROW', definition: 'CREATE <T>' },
          { name: 'g2', table: 'other', timing: 'AFTER', events: 'UPDATE', orientation: 'ROW', definition: 'x' },
          { name: 'g3', table: 't', timing: 'AFTER', events: 'DELETE', orientation: 'ROW', definition: null },
          { name: 'g4', table: 't', timing: 'AFTER', events: 'DELETE', orientation: 'ROW', definition: 'a\u0001' },
        ] as never
      }
    }
    const view = (name: string, definition: string) => {
      const t = fakeTable(name, ['id'], [])
      return { ...t, schema: { ...t.schema, kind: 'view' as const }, definition }
    }
    const stub = () =>
      new Stub({
        databases: {
          shop: {
            tables: {
              t: fakeTable('t', ['id'], []),
              v: view('v', 'SELECT 1 & 2'),
              w: view('w', 'a\u0002b'),
            },
          },
        },
        routines: { calc: 'CREATE FUNCTION calc() <>' },
      })
    const noObjects = { views: false, routines: false, triggers: false }

    it('writes none of them unless asked', async () => {
      const xml = await collect(xmlBody(stub(), ns, ['t'], none, noObjects))
      expect(xml).not.toContain('<views>')
      expect(xml).not.toContain('<routines>')
      expect(xml).not.toContain('<triggers>')
    })

    it('writes views with their definitions, base64 when XML cannot carry them, after the tables', async () => {
      const xml = await collect(xmlBody(stub(), ns, ['t'], none, { ...noObjects, views: true }))
      expect(xml).toContain(
        `  </table>\n  <views>\n    <view name="v">\n      <definition>SELECT 1 &amp; 2</definition>\n    </view>\n    <view name="w">\n      <definition encoding="base64">${Buffer.from('a\u0002b').toString('base64')}</definition>\n    </view>\n  </views>\n</export>\n`
      )
      expect(xml).not.toContain('<routines>')
      expect(xml).not.toContain('<triggers>')
    })

    it('names a view without a definition when the account may not read it', async () => {
      class Denied extends Stub {
        override async showCreateTable(): Promise<string[]> {
          throw new Error('denied')
        }
      }
      const a = new Denied({ databases: { shop: { tables: { t: fakeTable('t', ['id'], []), v: view('v', 'x') } } } })
      const xml = await collect(xmlBody(a, ns, [], none, { ...noObjects, views: true }))
      expect(xml).toContain('<view name="v">\n      <unreadable/>\n    </view>\n')
    })

    it('writes no <views> element when there is no view', async () => {
      const a = new FakeAdapter({ databases: { shop: { tables: { t: fakeTable('t', ['id'], []) } } } })
      const xml = await collect(xmlBody(a, ns, ['t'], none, { ...noObjects, views: true }))
      expect(xml).not.toContain('<views>')
      expect(xml).not.toContain('</views>')
    })

    it('writes materialized views as views too, and joins the statements of a definition', async () => {
      class Multi extends Stub {
        override async showCreateTable(): Promise<string[]> {
          return ['CREATE A', 'CREATE B']
        }
      }
      const m = view('m', 'x')
      ;(m.schema as { kind: string }).kind = 'materialized_view'
      const a = new Multi({ databases: { shop: { tables: { t: fakeTable('t', ['id'], []), m } } } })
      const xml = await collect(xmlBody(a, ns, [], none, { ...noObjects, views: true }))
      expect(xml).toContain('<view name="m">\n      <definition>CREATE A;\nCREATE B</definition>\n    </view>\n')
      expect(xml).not.toContain('<view name="t">')
    })

    it('writes routines once each by kind and name, with their definitions', async () => {
      class Twice extends Stub {
        override async listRoutines() {
          const r = { language: 'sql', returns: '', parameters: '', comment: null, sqlMode: null }
          return [
            { name: 'a"', kind: 'function', ...r },
            { name: 'a"', kind: 'function', ...r },
            { name: 'a"', kind: 'procedure', ...r },
            { name: 'b', kind: 'procedure', ...r },
          ] as never
        }
        override async routineDefinition(_ns: unknown, name: string): Promise<string | null> {
          return name === 'b' ? null : 'D & D'
        }
      }
      const a = new Twice({ databases: { shop: { tables: {} } } })
      const xml = await collect(xmlBody(a, ns, [], none, { ...noObjects, routines: true }))
      expect(xml).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<export database="shop">',
          '  <routines>',
          '    <routine name="a&quot;" kind="function">',
          '      <definition>D &amp; D</definition>',
          '    </routine>',
          '    <routine name="a&quot;" kind="procedure">',
          '      <definition>D &amp; D</definition>',
          '    </routine>',
          '    <routine name="b" kind="procedure">',
          '      <unreadable/>',
          '    </routine>',
          '  </routines>',
          '</export>',
          '',
        ].join('\n')
      )
    })

    it('names a routine without a definition when reading it fails', async () => {
      class Fails extends Stub {
        override async routineDefinition(): Promise<string | null> {
          throw new Error('denied')
        }
      }
      const a = new Fails({ databases: { shop: { tables: {} } }, routines: { r: 'x' } })
      const xml = await collect(xmlBody(a, ns, [], none, { ...noObjects, routines: true }))
      expect(xml).toContain('<routine name="r" kind="function">\n      <unreadable/>\n    </routine>\n')
    })

    it('writes no <routines> element when there is no routine', async () => {
      const a = new FakeAdapter({ databases: { shop: { tables: {} } } })
      const xml = await collect(xmlBody(a, ns, [], none, { ...noObjects, routines: true }))
      expect(xml).not.toContain('<routines>')
      expect(xml).not.toContain('</routines>')
    })

    it('writes the triggers of the exported tables only, with their attributes', async () => {
      const xml = await collect(xmlBody(stub(), ns, ['t'], none, { ...noObjects, triggers: true }))
      expect(xml).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<export database="shop">',
          '  <table name="t">',
          '  </table>',
          '  <triggers>',
          '    <trigger name="g1" table="t" timing="BEFORE" events="INSERT">',
          '      <definition>CREATE &lt;T&gt;</definition>',
          '    </trigger>',
          '    <trigger name="g3" table="t" timing="AFTER" events="DELETE">',
          '      <unreadable/>',
          '    </trigger>',
          '    <trigger name="g4" table="t" timing="AFTER" events="DELETE">',
          `      <definition encoding="base64">${Buffer.from('a\u0001').toString('base64')}</definition>`,
          '    </trigger>',
          '  </triggers>',
          '</export>',
          '',
        ].join('\n')
      )
    })

    it('writes no <triggers> element when none belongs to the exported tables', async () => {
      const xml = await collect(xmlBody(stub(), ns, ['zzz'], none, { ...noObjects, triggers: true }))
      expect(xml).not.toContain('<triggers>')
      expect(xml).not.toContain('</triggers>')
    })
  })
})

describe('yamlBody', () => {
  it('writes each table as a list of rows, with every value in a form that tells its kind', async () => {
    const a = withRows([
      { id: 1, name: 'say "hi"\nnow' },
      { id: 2, name: null },
      { id: true, name: { $bin: 'AQID' } },
    ])
    expect(await collect(yamlBody(a, ns, ['t']))).toBe(
      [
        '"t":',
        '  - "id": 1',
        '    "name": "say \\"hi\\"\\nnow"',
        '  - "id": 2',
        '    "name": null',
        '  - "id": true',
        '    "name": !!binary AQID',
        '',
      ].join('\n')
    )
  })

  it('writes an empty list for a table without rows, and quotes the title and the column names', async () => {
    const a = new FakeAdapter({
      databases: {
        shop: { tables: { 'a: b': fakeTable('a: b', ['x'], []), c: fakeTable('c', ['k: 1'], [{ 'k: 1': 5 }]) } },
      },
    })
    expect(await collect(yamlBody(a, ns, ['a: b', 'c']))).toBe('"a: b": []\n"c":\n  - "k: 1": 5\n')
  })

  it('writes the structure and the data as two lists with their titles', async () => {
    const a = withRows([{ id: 1, name: 'a' }])
    expect(await collect(yamlBody(a, ns, ['t'], both))).toBe(
      [
        '"t (structure)":',
        '  - "Column": "id"',
        '    "Type": "int"',
        '    "Null": "NO"',
        '    "Default": null',
        '    "Key": "PRI"',
        '    "Extra": ""',
        '    "Comment": ""',
        '  - "Column": "name"',
        '    "Type": "varchar"',
        '    "Null": "NO"',
        '    "Default": null',
        '    "Key": ""',
        '    "Extra": ""',
        '    "Comment": ""',
        '"t (data)":',
        '  - "id": 1',
        '    "name": "a"',
        '',
      ].join('\n')
    )
  })

  it('writes the title once for a table that comes in several batches', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, name: 'x' }))
    const yaml = await collect(yamlBody(withRows(rows), ns, ['t']))
    expect(yaml.match(/^"t":$/gm)).toHaveLength(1)
    expect(yaml.match(/^ {2}- "id": /gm)).toHaveLength(501)
  })

  it('writes nothing for a table of which neither part is asked', async () => {
    expect(await collect(yamlBody(withRows([]), ns, ['t'], none))).toBe('')
  })

  it('refuses a cut text', async () => {
    const a = withRows([{ id: 1, name: { $text: 'ab', length: 9 } }])
    await expect(collect(yamlBody(a, ns, ['t']))).rejects.toThrow('truncated text')
  })
})

describe('markdownBody', () => {
  it('writes a heading and a table per table, apart by a blank line', async () => {
    const a = new FakeAdapter({
      databases: {
        shop: { tables: { t: fakeTable('t', ['id', 'name'], [{ id: 1, name: 'a' }]), u: fakeTable('u', ['k'], []) } },
      },
    })
    expect(await collect(markdownBody(a, ns, ['t', 'u']))).toBe(
      ['## t', '', '| id | name |', '| --- | --- |', '| 1 | a |', '', '## u', '', '| k |', '| --- |', ''].join('\n')
    )
  })

  it('shows NULL, binary values by size, and keeps each row on one line with its pipes escaped', async () => {
    const a = withRows([
      { id: 1, name: null },
      { id: 2, name: { $bin: 'AQID' } },
      { id: 3, name: { $bin: '' } },
      { id: true, name: 'a|b\\c\r\nd\re\nf' },
    ])
    const md = await collect(markdownBody(a, ns, ['t']))
    expect(md).toContain('| 1 | *NULL* |\n')
    expect(md).toContain('| 2 | *(binary, 3 bytes)* |\n')
    expect(md).toContain('| 3 | *(binary, 0 bytes)* |\n')
    expect(md).toContain('| true | a\\|b\\\\c<br>d<br>e<br>f |\n')
  })

  it('writes the header once for a table that comes in several batches', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, name: 'x' }))
    const md = await collect(markdownBody(withRows(rows), ns, ['t']))
    expect(md.match(/^\| id \| name \|$/gm)).toHaveLength(1)
    expect(md.match(/^\| --- \| --- \|$/gm)).toHaveLength(1)
    expect(md.split('\n').filter((l) => l.endsWith(' | x |'))).toHaveLength(501)
  })

  it('escapes the column names too', async () => {
    const a = withRows([{ 'a|b': 1 }], ['a|b'])
    expect(await collect(markdownBody(a, ns, ['t']))).toContain('| a\\|b |\n| --- |\n| 1 |\n')
  })

  it('writes the structure and the data as two tables with their titles', async () => {
    const md = await collect(markdownBody(withRows([{ id: 1, name: 'a' }]), ns, ['t'], both))
    expect(md.startsWith('## t (structure)\n\n| Column | Type | Null | Default | Key | Extra | Comment |\n')).toBe(true)
    expect(md).toContain('| id | int | NO | *NULL* | PRI |  |  |\n')
    expect(md).toContain('\n\n## t (data)\n\n| id | name |\n| --- | --- |\n| 1 | a |\n')
  })

  it('refuses a cut text', async () => {
    const a = withRows([{ id: 1, name: { $text: 'ab', length: 9 } }])
    await expect(collect(markdownBody(a, ns, ['t']))).rejects.toThrow('truncated text')
  })
})
