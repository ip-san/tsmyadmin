import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, index, table } from '@/test/schema-fixtures.ts'
import { dictionaryMarkdown, markdownText, referencesOf } from './dictionary-markdown.ts'

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

describe('markdownText', () => {
  it('writes what Markdown would read as formatting, a link or HTML, as text', () => {
    expect(markdownText('a*b* [x](y) `c` | d ~e~ \\')).toBe('a\\*b\\* \\[x\\](y) \\`c\\` \\| d \\~e\\~ \\\\')
    expect(markdownText('<script>&amp;')).toBe('&lt;script&gt;&amp;amp;')
  })

  it('leaves an _ inside a word, and escapes one at its edge', () => {
    expect(markdownText('user_id')).toBe('user_id')
    expect(markdownText('_private_ x_')).toBe('\\_private\\_ x\\_')
    expect(markdownText('日本_語')).toBe('日本_語')
  })

  it('does not let a text start a heading, a quote, a list or a rule', () => {
    expect(markdownText('# not a heading')).toBe('\\# not a heading')
    expect(markdownText('- item')).toBe('\\- item')
    expect(markdownText('+ item')).toBe('\\+ item')
    expect(markdownText('=')).toBe('\\=')
    expect(markdownText('  1. first')).toBe('  1\\. first')
    expect(markdownText('2) second')).toBe('2\\) second')
    expect(markdownText('> quote')).toBe('&gt; quote')
    expect(markdownText('a - b # c')).toBe('a - b # c')
    expect(markdownText('2026 年')).toBe('2026 年')
  })

  it('writes a line break as a space, or as asked', () => {
    expect(markdownText('a\nb\r\nc\rd')).toBe('a b c d')
    expect(markdownText('a\nb', '<br>')).toBe('a<br>b')
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

  it('names the tables it could not read at the top', () => {
    expect(dictionaryMarkdown('shop', [], ['a_b', 'c*'])).toBe(
      `# ${t.title('shop')}\n\n> ${markdownText(t.failed(['a_b', 'c*']))}\n`
    )
    expect(markdownText(t.failed(['c*']))).toContain('c\\*')
  })

  it('escapes the names and comments it writes', () => {
    const odd = table('a|b', { comment: '# big', columns: [column('<x>', 'int', { comment: '*' })] })
    const md = dictionaryMarkdown('s*', [odd], [])
    expect(md).toContain(`# ${t.title('s\\*')}`)
    expect(md).toContain('## a\\|b\n\n\\# big\n')
    expect(md).toContain(`| &lt;x&gt; | int | ${locale.common.yes} |  |  | \\* |`)
  })
})
