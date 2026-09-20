import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { collect } from './export.ts'
import { htmlBody, latexBody, mediawikiBody, texyBody } from './export-documents.ts'
import { officeBody, sheetNames } from './export-office.ts'
import { readZip } from './zip.ts'

const adapter = () =>
  new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'A & B <c> 50% _x_' },
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

/** Every open tag has its close, in order: the XML is well formed as far as nesting goes. */
function balanced(xml: string): boolean {
  const stack: string[] = []
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) return false
    } else stack.push(m[2] as string)
  }
  return stack.length === 0
}

describe('document exports', () => {
  it('writes LaTeX with its specials escaped and NULL marked', async () => {
    const tex = await collect(latexBody(adapter(), ns, ['users']))
    expect(tex).toContain('\\begin{longtable}{|l|l|}')
    expect(tex).toContain('A \\& B <c> 50\\% \\_x\\_')
    expect(tex).toContain('\\textit{NULL}')
    expect(tex).toContain('line break | pipe')
    expect(tex.trimEnd().endsWith('\\end{document}')).toBe(true)
  })

  it('writes Texy! and MediaWiki tables with their separators kept out of the values', async () => {
    const texy = await collect(texyBody(adapter(), ns, ['users']))
    expect(texy).toContain('===users')
    expect(texy).toContain('| 3 | line break &#124; pipe')
    const wiki = await collect(mediawikiBody(adapter(), ns, ['users', 'empty']))
    expect(wiki).toContain('{| class="wikitable"')
    expect(wiki).toContain('| A &amp; B &lt;c&gt; 50% _x_')
    expect(wiki).toContain("| ''NULL''")
    expect(wiki).toContain('line<br />break &#124; pipe')
    expect(wiki.match(/^\|\}$/gm)).toHaveLength(2)
  })

  it('writes an HTML page with escaped text and NULL apart from an empty string', async () => {
    const html = await collect(htmlBody(adapter(), ns, ['users']))
    expect(html).toContain('<td>A &amp; B &lt;c&gt; 50% _x_</td>')
    expect(html).toContain('<td><i class="null">NULL</i></td>')
    expect(html).toContain('@page{size:landscape')
  })
})

describe('office exports', () => {
  const read = async (kind: 'ods' | 'odt' | 'docx') =>
    readZip(new Uint8Array(Buffer.concat(await Array.fromAsync(officeBody(kind, adapter(), ns, ['users', 'empty'])))))
  const text = (files: ReturnType<typeof readZip>, name: string) =>
    new TextDecoder().decode(files.find((f) => f.name === name)?.bytes())

  it('makes a spreadsheet whose first entry says what it is, with numbers as numbers and NULL as an empty cell', async () => {
    const files = await read('ods')
    expect(files[0]?.name).toBe('mimetype')
    expect(text(files, 'mimetype')).toBe('application/vnd.oasis.opendocument.spreadsheet')
    const content = text(files, 'content.xml')
    expect(balanced(content)).toBe(true)
    expect(content).toContain('<table:table table:name="users">')
    expect(content).toContain('<table:table table:name="empty">')
    expect(content).toContain('office:value-type="float" office:value="1"')
    expect(content).toContain('<table:table-cell/>')
    expect(content).toContain('A &amp; B &lt;c&gt;')
    expect(content).toContain('<text:p>line</text:p><text:p>break | pipe</text:p>')
  })

  it('makes a text document and a Word document', async () => {
    const odt = await read('odt')
    expect(text(odt, 'mimetype')).toBe('application/vnd.oasis.opendocument.text')
    expect(balanced(text(odt, 'content.xml'))).toBe(true)
    expect(text(odt, 'content.xml')).toContain('<text:h text:outline-level="2">users</text:h>')
    const docx = await read('docx')
    expect(docx.map((f) => f.name)).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    const document = text(docx, 'word/document.xml')
    expect(balanced(document)).toBe(true)
    expect(document).toContain('A &amp; B &lt;c&gt; 50% _x_')
  })

  it('writes a chosen text for NULL in a spreadsheet, and the structure into a text or Word document', async () => {
    const zip = async (kind: 'ods' | 'odt' | 'docx', o: Parameters<typeof officeBody>[4], nullText?: string) =>
      readZip(
        new Uint8Array(Buffer.concat(await Array.fromAsync(officeBody(kind, adapter(), ns, ['users'], o, nullText))))
      )
    const ods = text(await zip('ods', undefined, '(none)'), 'content.xml')
    expect(ods).toContain('office:value-type="string"><text:p>(none)</text:p>')
    expect(ods).not.toContain('<table:table-cell/>')
    const both = { structure: true, data: true }
    const odt = text(await zip('odt', both), 'content.xml')
    expect(odt).toContain('<text:h text:outline-level="2">users (structure)</text:h>')
    expect(odt).toContain('<text:h text:outline-level="2">users (data)</text:h>')
    expect(balanced(odt)).toBe(true)
    const docx = text(await zip('docx', { structure: true, data: false }), 'word/document.xml')
    expect(docx).toContain('Column')
    expect(docx).not.toContain('A &amp; B')
  })

  it('names sheets within Excel’s and LibreOffice’s rules', () => {
    expect(sheetNames(['a/b', 'A/B', 'x'.repeat(40), "'q'"])).toEqual(['a_b', 'A_B_2', 'x'.repeat(31), '_q_'])
  })
})
