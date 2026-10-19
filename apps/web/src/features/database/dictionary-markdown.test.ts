import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, index, table } from '@/test/schema-fixtures.ts'
import { dictionaryMarkdown, markdownLine, markdownText, referencesOf } from './dictionary-markdown.ts'

const t = locale.dictionary

describe('referencesOf', () => {
  it('names what each column of a foreign key points at, pairwise', () => {
    const refs = referencesOf({
      foreignKeys: [
        {
          name: 'fk',
          columns: ['a', 'b'],
          refNamespace: { database: 'd' },
          refTable: 'r',
          refColumns: ['x', 'y'],
          onUpdate: null,
          onDelete: null,
        },
      ],
    })
    expect([...refs]).toEqual([
      ['a', 'r.x'],
      ['b', 'r.y'],
    ])
  })
})

describe('referencesOf, of a column in two keys', () => {
  it('names the first key it takes part in', () => {
    const refs = referencesOf({ foreignKeys: [fk(['a'], 'first'), fk(['a'], 'second')] })
    expect([...refs]).toEqual([['a', 'first.id']])
  })
})

describe('markdownText', () => {
  it('writes what Markdown would read as formatting, a link or HTML, as text', () => {
    expect(markdownText('a*b* [x](y) `c` | d ~e~ \\')).toBe('a\\*b\\* \\[x\\](y) \\`c\\` \\| d \\~e\\~ \\\\')
    expect(markdownText('<script>&amp; &#60; R&D')).toBe('&lt;script>&amp;amp; &amp;#60; R&D')
  })

  it('leaves an _ inside a word, and escapes one at its edge', () => {
    expect(markdownText('user_id')).toBe('user_id')
    expect(markdownText('_private_ x_')).toBe('\\_private\\_ x\\_')
    expect(markdownText('日本_語')).toBe('日本_語')
  })

  it('leaves what only begins a block where it is, within a line: defaults stay as the SQL wrote them', () => {
    for (const text of ['1.5', '0.00', '-1', '# x', '> 0', '(a > 0)', '+1', '2) b', 'https://example.com'])
      expect(markdownText(text)).toBe(text)
    expect(markdownText('count(*)')).toBe('count(\\*)')
  })

  it('writes a line break as a space, or as asked', () => {
    expect(markdownText('a\nb\r\nc\rd')).toBe('a b c d')
    expect(markdownText('a\nb', '<br>')).toBe('a<br>b')
  })
})

describe('markdownLine', () => {
  it('does not let a line start a heading, a quote, a list, a rule or a block of code', () => {
    expect(markdownLine('# not a heading')).toBe('\\# not a heading')
    expect(markdownLine('- item')).toBe('\\- item')
    expect(markdownLine('+ item')).toBe('\\+ item')
    expect(markdownLine('=')).toBe('\\=')
    expect(markdownLine('> quote')).toBe('\\> quote')
    expect(markdownLine('  1. first')).toBe('1\\. first')
    expect(markdownLine('2) second')).toBe('2\\) second')
    expect(markdownLine('3.')).toBe('3\\.')
    expect(markdownLine('    SELECT 1')).toBe('SELECT 1')
    expect(markdownLine('\tcode')).toBe('code')
  })

  it('leaves what does not begin a block', () => {
    for (const text of ['a - b # c', '2026 年', '1.5 倍', 'x > y', 'a 1. b']) expect(markdownLine(text)).toBe(text)
    expect(markdownLine('12. twelfth')).toBe('12\\. twelfth')
  })
})

describe('dictionaryMarkdown', () => {
  const users = table('users', {
    comment: 'People | who sign in',
    columns: [
      column('id', 'int', { nullable: false }),
      column('name', 'varchar(20)', { default: "'x'", comment: 'line one\nline two' }),
    ],
    indexes: [index(['id'], { name: 'PRIMARY', unique: true, primary: true }), index(['name'])],
  })
  const posts = table('posts', {
    columns: [column('id', 'int', { nullable: false }), column('user_id', 'int')],
    foreignKeys: [fk(['user_id'], 'users')],
  })
  const view = table('v_posts', { kind: 'view', primaryKey: [], columns: [column('id', 'int')] })

  it('writes a section per table, in the order given, with the columns of the page', () => {
    expect(dictionaryMarkdown('shop', [users, posts, view], [])).toBe(
      [
        `# ${t.title('shop')}`,
        '',
        '## users',
        '',
        'People \\| who sign in',
        '',
        `| ${locale.table.name} | ${t.type} | ${t.nullable} | ${t.default} | ${t.references} | ${locale.database.comment} |`,
        '| --- | --- | --- | --- | --- | --- |',
        `| id${t.primaryMark} | int | ${locale.common.no} |  |  |  |`,
        `| name | varchar(20) | ${locale.common.yes} | 'x' |  | line one<br>line two |`,
        '',
        `${t.indexes}:`,
        '',
        `- PRIMARY (id) ${t.unique}`,
        '- ix_name (name)',
        '',
        '## posts',
        '',
        `| ${locale.table.name} | ${t.type} | ${t.nullable} | ${t.default} | ${t.references} | ${locale.database.comment} |`,
        '| --- | --- | --- | --- | --- | --- |',
        `| id${t.primaryMark} | int | ${locale.common.no} |  |  |  |`,
        `| user_id | int | ${locale.common.yes} |  | users.id |  |`,
        '',
        `## v_posts${t.viewMark}`,
        '',
        `| ${locale.table.name} | ${t.type} | ${t.nullable} | ${t.default} | ${t.references} | ${locale.database.comment} |`,
        '| --- | --- | --- | --- | --- | --- |',
        `| id | int | ${locale.common.yes} |  |  |  |`,
        '',
      ].join('\n')
    )
  })

  it('keeps a # within a heading, and escapes only the ones that would close it', () => {
    const md = dictionaryMarkdown('shop', [table('a # b'), table('c ##')], [])
    expect(md).toContain('\n## a # b\n')
    expect(md).toContain('\n## c \\##\n')
  })

  it('writes a cell without the blanks around its text, and the columns of an index with commas', () => {
    const t1 = table('t', { columns: [column('c', 'int', { comment: '  padded  ' })], indexes: [index(['a', 'b'])] })
    const md = dictionaryMarkdown('shop', [t1], [])
    expect(md).toContain(`| c | int | ${locale.common.yes} |  |  | padded |`)
    expect(md).toContain('- ix_a_b (a, b)')
  })

  it('names the tables it could not read at the top', () => {
    expect(dictionaryMarkdown('shop', [], ['a_b', 'c*'])).toBe(
      `# ${t.title('shop')}\n\n> ${markdownText(t.failed(['a_b', 'c*']))}\n`
    )
    expect(markdownText(t.failed(['c*']))).toContain('c\\*')
  })

  it('escapes the names and comments it writes', () => {
    const odd = table('a|b #', {
      comment: '    # big',
      columns: [column('<x>', 'decimal(5,2)', { comment: '*', default: '-1.50' })],
    })
    const md = dictionaryMarkdown('s*', [odd], [])
    expect(md).toContain(`# ${t.title('s\\*')}`)
    expect(md).toContain('## a\\|b \\#\n\n\\# big\n')
    expect(md).toContain(`| &lt;x> | decimal(5,2) | ${locale.common.yes} | -1.50 |  | \\* |`)
  })
})
