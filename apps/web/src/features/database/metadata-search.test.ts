import type { TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { findSpans, foldTerm, indexMetadata, matchMetadata } from './metadata-search.ts'

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

const index = indexMetadata(schemas)
const find = (term: string) => matchMetadata(index, foldTerm(term)).matches

describe('matchMetadata', () => {
  it('finds columns by name across tables, in the order of the tables and columns', () => {
    const found = find('user')
    expect(found.map((m) => [m.table, m.column])).toEqual([
      ['users', null],
      ['posts', 'user_id'],
    ])
  })

  it('finds by type and by comment, of columns and of tables', () => {
    expect(find('json').map((m) => m.column)).toEqual(['profile'])
    expect(find('会員').map((m) => [m.table, m.column])).toEqual([
      ['users', null],
      ['posts', 'user_id'],
    ])
    // The table line says which part matched: here the comment, not the name.
    const own = find('会員')[0]
    expect(own?.name.spans).toEqual([])
    expect(own?.comment?.spans).toEqual([[0, 2]])
  })

  it('ignores case and width, and blank finds nothing', () => {
    expect(find('ＵＳＥＲ_ＩＤ').map((m) => m.column)).toEqual(['user_id'])
    expect(find('VARCHAR').map((m) => m.column)).toEqual(['name'])
    expect(find('  ')).toEqual([])
  })

  it('finds nothing where nothing holds the term', () => {
    expect(find('nowhere')).toEqual([])
  })

  it('gives at most the limit, and how many there are in all', () => {
    const { matches, total } = matchMetadata(index, foldTerm('i'), 2)
    expect(matches.map((m) => [m.table, m.column])).toEqual([
      ['users', 'id'],
      ['users', 'profile'],
    ])
    // users.id, users.profile, posts.id, posts.user_id
    expect(total).toBe(4)
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

  it('marks a character that folds to several once, however many matches fall in it', () => {
    // … is three dots: three matches of "." in one character are one mark on it.
    expect(findSpans('合計…', '.')).toEqual([[2, 3]])
    expect(findSpans('oﬃce', 'ff')).toEqual([[1, 2]])
  })

  it('covers the whole of a character a match ends inside', () => {
    // ﬁ is f and i: a match ending at its f marks all of it.
    expect(findSpans('aﬁ', 'af')).toEqual([[0, 2]])
  })

  it('keeps a character of two code units whole, and a letter with its accent', () => {
    expect(findSpans('😀id', 'id')).toEqual([[2, 4]])
    // e and a combining acute accent are one character: matching é marks both.
    expect(findSpans('cafe\u0301s', 'café')).toEqual([[0, 5]])
  })

  it('keeps matches that only touch apart', () => {
    expect(findSpans('idid', 'id')).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('finds nothing for an empty term', () => {
    expect(findSpans('abc', '')).toEqual([])
  })
})
