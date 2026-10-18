import type { TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { findSpans, matchMetadata } from './metadata-search.ts'

const table = (name: string, comment: string | null, columns: [string, string, string | null][]) =>
  ({
    name,
    comment,
    columns: columns.map(([n, dataType, c]) => ({ name: n, dataType, comment: c })),
  }) as unknown as TableSchema

const schemas = [
  table('users', '会員', [
    ['id', 'int', null],
    ['name', 'varchar(50)', '表示名'],
    ['profile', 'json', 'ユーザーの設定'],
  ]),
  table('posts', null, [
    ['id', 'int', null],
    ['user_id', 'int', '書いた会員'],
  ]),
]

describe('matchMetadata', () => {
  it('finds columns by name across tables, in the order of the tables and columns', () => {
    const found = matchMetadata(schemas, 'user')
    expect(found.map((m) => [m.table, m.column])).toEqual([
      ['users', null],
      ['posts', 'user_id'],
    ])
  })

  it('finds by type and by comment, of columns and of tables', () => {
    expect(matchMetadata(schemas, 'json').map((m) => m.column)).toEqual(['profile'])
    expect(matchMetadata(schemas, '会員').map((m) => [m.table, m.column])).toEqual([
      ['users', null],
      ['posts', 'user_id'],
    ])
    // The table line says which part matched: here the comment, not the name.
    const own = matchMetadata(schemas, '会員')[0]
    expect(own?.name.spans).toEqual([])
    expect(own?.comment?.spans).toEqual([[0, 2]])
  })

  it('ignores case and width, and blank finds nothing', () => {
    expect(matchMetadata(schemas, 'ＵＳＥＲ_ＩＤ').map((m) => m.column)).toEqual(['user_id'])
    expect(matchMetadata(schemas, 'VARCHAR').map((m) => m.column)).toEqual(['name'])
    expect(matchMetadata(schemas, '  ')).toEqual([])
  })

  it('finds nothing where nothing holds the term', () => {
    expect(matchMetadata(schemas, 'nowhere')).toEqual([])
  })
})

describe('findSpans', () => {
  it('marks every place, without overlaps, on the characters as shown', () => {
    expect(findSpans('aXa_xa', 'xa')).toEqual([
      [1, 3],
      [4, 6],
    ])
    expect(findSpans('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('maps a match in folded text back to the full-width or half-width characters it came from', () => {
    expect(findSpans('ＩＤ番号', 'id')).toEqual([[0, 2]])
    // Half-width ｶﾞ folds to one character, ガ: the match covers both of its characters.
    expect(findSpans('ｶﾞｲﾄﾞ', 'ガイ')).toEqual([[0, 3]])
  })

  it('finds nothing for an empty term', () => {
    expect(findSpans('abc', '')).toEqual([])
  })
})
