import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { collect } from './export.ts'
import {
  cellText,
  DATA_ONLY,
  docOptions,
  htmlBody,
  latexBody,
  mediawikiBody,
  structureRows,
  tableSections,
  texyBody,
} from './export-documents.ts'

/** The documents meant for people: what each writes exactly, and how a table is split into parts. */

const ns = { database: 'shop' }
const both = { structure: true, data: true }
const adapterOf = (tables: Record<string, ReturnType<typeof fakeTable>>, database = 'shop') =>
  new FakeAdapter({ databases: { [database]: { tables } } })
const users = () =>
  fakeTable(
    'users',
    ['id', 'name'],
    [
      { id: 1, name: 'a_b' },
      { id: 2, name: null },
    ]
  )
const index = (columns: string[], unique: boolean) => ({
  name: columns.join('_'),
  unique,
  primary: false,
  columns,
  type: null,
  predicate: null,
  definition: null,
  lengths: {},
})

describe('docOptions', () => {
  it('reads the choices of a request: only "1" asks, and the caption is on unless "0"', () => {
    expect(docOptions({ structure: '1', data: '1', latexCaption: '1', latexLabel: '1' })).toEqual({
      structure: true,
      data: true,
      latexCaption: true,
      latexLabel: true,
    })
    expect(docOptions({ structure: '0', data: '0', latexCaption: '0', latexLabel: '0' })).toEqual({
      structure: false,
      data: false,
      latexCaption: false,
      latexLabel: false,
    })
    expect(docOptions({ structure: 'yes', data: '' })).toEqual({
      structure: false,
      data: false,
      latexCaption: true,
      latexLabel: false,
    })
  })

  it('writes the data only by default', () => {
    expect(DATA_ONLY).toEqual({ structure: false, data: true, latexCaption: true, latexLabel: false })
  })
})

describe('cellText', () => {
  it('gives null for NULL and the text of anything else; binary by its size', () => {
    expect(cellText(null)).toBeNull()
    expect(cellText('')).toBe('')
    expect(cellText(5)).toBe('5')
    expect(cellText(false)).toBe('false')
    expect(cellText({ $bin: 'AQID' })).toBe('(binary, 3 bytes)')
    expect(cellText({ $bin: '' })).toBe('(binary, 0 bytes)')
  })

  it('refuses a cut text', () => {
    expect(() => cellText({ $text: 'ab', length: 9 })).toThrow('truncated text cannot be written to an export')
  })
})

describe('structureRows', () => {
  it('tells the key of each column: primary, then unique-first, then any other index, else none', async () => {
    const t = fakeTable('t', ['id', 'a', 'b', 'c', 'd', 'e'], [])
    t.schema.indexes.push(
      index(['a'], true),
      index(['b', 'c'], true), // c is in a unique index but not first: MUL
      index(['d'], false),
      index(['id'], true) // already the primary key: stays PRI
    )
    const rows = await structureRows(adapterOf({ t }), ns, 't')
    expect(rows.map((r) => r[4])).toEqual(['PRI', 'UNI', 'UNI', 'MUL', 'MUL', ''])
  })

  it('gives the name, type, nullability, default, extra and comment of each column', async () => {
    const t = fakeTable('t', ['id', 'n'], [])
    Object.assign(t.schema.columns[1] as object, {
      dataType: 'text',
      nullable: true,
      default: 'x',
      extra: 'e',
      comment: 'c',
    })
    expect(await structureRows(adapterOf({ t }), ns, 't')).toEqual([
      ['id', 'int', 'NO', null, 'PRI', '', ''],
      ['n', 'text', 'YES', 'x', '', 'e', 'c'],
    ])
  })
})

describe('tableSections', () => {
  it('makes a part for the structure and one for the data, titled apart only when both are there', () => {
    const a = adapterOf({ users: users() })
    const titles = (o: Parameters<typeof tableSections>[3]) => tableSections(a, ns, 'users', o).map((s) => s.title)
    expect(titles(both)).toEqual(['users (structure)', 'users (data)'])
    expect(titles({ structure: true, data: false })).toEqual(['users'])
    expect(titles({ structure: false, data: true })).toEqual(['users'])
    expect(titles({ structure: false, data: false })).toEqual([])
  })

  it('draws the structure as one batch with the seven columns', async () => {
    const [sec] = tableSections(adapterOf({ users: users() }), ns, 'users', { structure: true, data: false })
    const batches = await Array.fromAsync(sec?.batches() ?? [])
    expect(batches).toHaveLength(1)
    expect(batches[0]?.columns).toEqual(['Column', 'Type', 'Null', 'Default', 'Key', 'Extra', 'Comment'])
    expect(batches[0]?.rows).toHaveLength(2)
  })

  it('draws the columns of an empty table once when the server sends no batch at all', async () => {
    class Silent extends FakeAdapter {
      override async *iterateRows() {
        // no batch at all: not even the empty one a table without rows normally yields
      }
    }
    const a = new Silent({ databases: { shop: { tables: { users: users() } } } })
    const [sec] = tableSections(a, ns, 'users', DATA_ONLY)
    expect(await Array.fromAsync(sec?.batches() ?? [])).toEqual([{ columns: ['id', 'name'], rows: [] }])
    // With batches, the columns are not drawn a second time.
    const [full] = tableSections(adapterOf({ users: users() }), ns, 'users', DATA_ONLY)
    expect(await Array.fromAsync(full?.batches() ?? [])).toEqual([
      {
        columns: ['id', 'name'],
        rows: [
          [1, 'a_b'],
          [2, null],
        ],
      },
    ])
    const b = adapterOf({ users: users() })
    await Array.fromAsync(tableSections(b, ns, 'users', DATA_ONLY)[0]?.batches() ?? [])
    expect(b.calls.some((c) => c.method === 'describeTable')).toBe(false)
  })
})

describe('a table that comes in several batches', () => {
  const big = () =>
    adapterOf({
      t: fakeTable(
        't',
        ['id', 'v'],
        Array.from({ length: 501 }, (_, i) => ({ id: i + 1, v: 'x' }))
      ),
    })
  const lines = (text: string) => text.split('\n')

  it('LaTeX opens the table once and ends it once', async () => {
    const tex = await collect(latexBody(big(), ns, ['t']))
    expect(tex.match(/\\begin\{longtable\}/g)).toHaveLength(1)
    expect(tex.match(/\\endhead/g)).toHaveLength(1)
    expect(tex.match(/\\end\{longtable\}/g)).toHaveLength(1)
    expect(lines(tex).filter((l) => l.endsWith(' & x \\\\ \\hline'))).toHaveLength(501)
  })

  it('Texy! writes the header once', async () => {
    const texy = await collect(texyBody(big(), ns, ['t']))
    expect(texy.match(/\| \*id \| \*v/g)).toHaveLength(1)
    expect(lines(texy).filter((l) => l.endsWith(' | x'))).toHaveLength(501)
  })

  it('MediaWiki writes the header once', async () => {
    const wiki = await collect(mediawikiBody(big(), ns, ['t']))
    expect(wiki.match(/^! id$/gm)).toHaveLength(1)
    expect(wiki.match(/^\| x$/gm)).toHaveLength(501)
  })

  it('HTML writes the header once', async () => {
    const html = await collect(htmlBody(big(), ns, ['t']))
    expect(html.match(/<thead>/g)).toHaveLength(1)
    expect(html.match(/<tr><td>/g)).toHaveLength(501)
  })
})

describe('latexBody', () => {
  it('writes the whole document: a preamble, a longtable per part with a caption, NULL in italics', async () => {
    const tex = await collect(latexBody(adapterOf({ users: users() }, 'sh\nop'), { database: 'sh\nop' }, ['users']))
    expect(tex).toBe(
      [
        '% tsmyadmin LaTeX export',
        '% Database: sh op',
        '\\documentclass{article}',
        '\\usepackage{longtable}',
        '\\usepackage[margin=1.5cm,landscape]{geometry}',
        '\\begin{document}',
        '',
        '\\begin{longtable}{|l|l|}',
        '\\hline \\multicolumn{2}{|c|}{\\textbf{users}} \\\\ \\hline',
        '\\textbf{id} & \\textbf{name} \\\\ \\hline \\endhead',
        '1 & a\\_b \\\\ \\hline',
        '2 & \\textit{NULL} \\\\ \\hline',
        '\\end{longtable}',
        '',
        '\\end{document}',
        '',
      ].join('\n')
    )
  })

  it('escapes every special character, and flattens line breaks, in values, titles and column names', async () => {
    const t = fakeTable('t&_', ['c#'], [{ 'c#': '\\ & % $ # _ { } ~ ^\r\nx\ry\nz' }])
    const tex = await collect(latexBody(adapterOf({ 't&_': t }), ns, ['t&_']))
    expect(tex).toContain(
      '\\textbackslash{} \\& \\% \\$ \\# \\_ \\{ \\} \\textasciitilde{} \\textasciicircum{} x y z \\\\ \\hline'
    )
    expect(tex).toContain('\\textbf{t\\&\\_}')
    expect(tex).toContain('\\textbf{c\\#}')
  })

  it('writes a caption with a label when asked, numbered across the parts, with its key made of safe characters', async () => {
    const o = { ...both, latexLabel: true }
    const tex = await collect(
      latexBody(adapterOf({ users: users(), 'b c': fakeTable('b c', ['id'], []) }), ns, ['users', 'b c'], o)
    )
    expect(tex).toContain('\\hline \\caption{users (structure)}\\label{tbl:1:users_structure_} \\\\ \\hline\n')
    expect(tex).toContain('\\hline \\caption{users (data)}\\label{tbl:2:users_data_} \\\\ \\hline\n')
    expect(tex).toContain('\\label{tbl:3:b_c_structure_}')
    expect(tex).toContain('\\label{tbl:4:b_c_data_}')
    expect(tex).not.toContain('\\multicolumn')
  })

  it('writes a plain rule without a caption when the caption is turned off, even with a label', async () => {
    for (const latexLabel of [false, true]) {
      const tex = await collect(
        latexBody(adapterOf({ users: users() }), ns, ['users'], {
          structure: false,
          data: true,
          latexCaption: false,
          latexLabel,
        })
      )
      expect(tex).toContain('\\begin{longtable}{|l|l|}\n\\hline\n\\textbf{id}')
      expect(tex).not.toContain('\\caption')
      expect(tex).not.toContain('\\multicolumn')
    }
  })

  it('writes an empty table with its header only, and the structure table of a table', async () => {
    const tex = await collect(latexBody(adapterOf({ e: fakeTable('e', ['id'], []) }), ns, ['e']))
    expect(tex).toContain('\\textbf{id} \\\\ \\hline \\endhead\n\\end{longtable}\n')
    const s = await collect(latexBody(adapterOf({ users: users() }), ns, ['users'], { structure: true, data: false }))
    expect(s).toContain('\\begin{longtable}{|l|l|l|l|l|l|l|}')
    expect(s).toContain('\\textbf{Column} & \\textbf{Type}')
    expect(s).toContain('id & int & NO & \\textit{NULL} & PRI &  &  \\\\ \\hline')
  })

  it('refuses a cut text', async () => {
    const a = adapterOf({ t: fakeTable('t', ['id'], [{ id: { $text: 'ab', length: 9 } } as never]) })
    await expect(collect(latexBody(a, ns, ['t']))).rejects.toThrow('truncated text')
  })
})

describe('texyBody', () => {
  it('writes a heading and a ruled table per part, apart by a blank line', async () => {
    const a = adapterOf({ users: users(), e: fakeTable('e', ['id'], []) })
    const rule = `|${'-'.repeat(20)}`
    expect(await collect(texyBody(a, ns, ['users', 'e']))).toBe(
      [
        '===users',
        '',
        rule,
        '| *id | *name',
        rule,
        '| 1 | a_b',
        '| 2 | NULL',
        '',
        '===e',
        '',
        rule,
        '| *id',
        rule,
        '',
      ].join('\n')
    )
  })

  it('keeps pipes and line breaks out of the cells, the headings and the column names', async () => {
    const t = fakeTable('t\nx', ['a|b'], [{ 'a|b': 'p|q\r\nr\rs\nt' }])
    const texy = await collect(texyBody(adapterOf({ 't\nx': t }), ns, ['t\nx']))
    expect(texy).toContain('===t x\n')
    expect(texy).toContain('| *a&#124;b\n')
    expect(texy).toContain('| p&#124;q r s t\n')
  })

  it('shows binary by size and refuses a cut text', async () => {
    const t = fakeTable('t', ['id'], [{ id: { $bin: 'AQID' } }])
    expect(await collect(texyBody(adapterOf({ t }), ns, ['t']))).toContain('| (binary, 3 bytes)\n')
    const c = fakeTable('t', ['id'], [{ id: { $text: 'ab', length: 9 } } as never])
    await expect(collect(texyBody(adapterOf({ t: c }), ns, ['t']))).rejects.toThrow('truncated text')
  })
})

describe('mediawikiBody', () => {
  it('writes a wikitable per part with its caption, header and rows', async () => {
    const a = adapterOf({ users: users(), e: fakeTable('e', ['id'], []) })
    expect(await collect(mediawikiBody(a, ns, ['users', 'e']))).toBe(
      [
        '{| class="wikitable"',
        '|+ users',
        '|-',
        '! id',
        '! name',
        '|-',
        '| 1',
        '| a_b',
        '|-',
        '| 2',
        "| ''NULL''",
        '|}',
        '',
        '{| class="wikitable"',
        '|+ e',
        '|-',
        '! id',
        '|}',
        '',
      ].join('\n')
    )
  })

  it('escapes what the markup would take, and a leading character that starts a list or a heading', async () => {
    const values = [
      'a&b<c>d|e{f[g',
      ...['*', '#', ':', ';', '=', '!', '-'].map((c) => `${c}x`),
      'x-y',
      'l1\r\nl2\rl3\nl4',
    ]
    const t = fakeTable(
      't',
      ['v'],
      values.map((v) => ({ v }))
    )
    const wiki = await collect(mediawikiBody(adapterOf({ t }), ns, ['t']))
    expect(wiki).toContain('| a&amp;b&lt;c&gt;d&#124;e&#123;f&#91;g\n')
    for (const c of ['*', '#', ':', ';', '=', '!', '-']) {
      expect(wiki).toContain(`| &#${c.charCodeAt(0)};x\n`)
    }
    expect(wiki).toContain('| x-y\n')
    expect(wiki).toContain('| l1<br />l2<br />l3<br />l4\n')
  })

  it('shows binary by size and refuses a cut text', async () => {
    const t = fakeTable('t', ['id'], [{ id: { $bin: 'AQID' } }])
    expect(await collect(mediawikiBody(adapterOf({ t }), ns, ['t']))).toContain('| (binary, 3 bytes)\n')
    const c = fakeTable('t', ['id'], [{ id: { $text: 'ab', length: 9 } } as never])
    await expect(collect(mediawikiBody(adapterOf({ t: c }), ns, ['t']))).rejects.toThrow('truncated text')
  })
})

describe('htmlBody', () => {
  it('writes a page with a heading and a table per part, NULL in italics, an empty table with its header', async () => {
    const a = adapterOf(
      {
        'u"': fakeTable(
          'u"',
          ['id', 'n<'],
          [
            { id: 1, 'n<': 'x&"y' },
            { id: 2, 'n<': null },
          ]
        ),
        e: fakeTable('e', ['id'], []),
      },
      'd<b'
    )
    const html = await collect(htmlBody(a, { database: 'd<b' }, ['u"', 'e']))
    expect(
      html.startsWith(
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>d&lt;b</title>\n<style>\n'
      )
    ).toBe(true)
    expect(html).toContain(
      '</style>\n</head>\n<body>\n<h2>u&quot;</h2>\n<table>\n<thead><tr><th>id</th><th>n&lt;</th></tr></thead>\n<tbody>\n'
    )
    expect(html).toContain('<tr><td>1</td><td>x&amp;&quot;y</td></tr>\n<tr><td>2</td>')
    // The page prints well: its rules are in the page itself.
    expect(html).toContain(
      'table{border-collapse:collapse;font-size:.8rem;width:100%}\nth,td{border:1px solid #71717a;padding:.2rem .4rem;text-align:left;vertical-align:top;white-space:pre-wrap}\n'
    )
    expect(html).toContain(
      'th{background:#f4f4f5}\ni.null{color:#71717a}\ntr{break-inside:avoid}\nthead{display:table-header-group}\n'
    )
    expect(html).toContain('<tr><td>2</td><td><i class="null">NULL</i></td></tr>\n')
    expect(html).toContain(
      '</tbody>\n</table>\n<h2>e</h2>\n<table>\n<thead><tr><th>id</th></tr></thead>\n<tbody>\n</tbody>\n</table>\n</body>\n</html>\n'
    )
  })

  it('writes the structure and the data as two tables, and the structure of a table by its columns', async () => {
    const html = await collect(htmlBody(adapterOf({ users: users() }), ns, ['users'], both))
    expect(html).toContain('<h2>users (structure)</h2>')
    expect(html).toContain('<h2>users (data)</h2>')
    expect(html).toContain(
      '<th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th>Extra</th><th>Comment</th>'
    )
  })

  it('shows binary by size and refuses a cut text', async () => {
    const t = fakeTable('t', ['id'], [{ id: { $bin: 'AQID' } }])
    expect(await collect(htmlBody(adapterOf({ t }), ns, ['t']))).toContain('<td>(binary, 3 bytes)</td>')
    const c = fakeTable('t', ['id'], [{ id: { $text: 'ab', length: 9 } } as never])
    await expect(collect(htmlBody(adapterOf({ t: c }), ns, ['t']))).rejects.toThrow('truncated text')
  })
})
