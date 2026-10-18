import type { ColumnProfile } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { columnNotes } from './column-notes.ts'

describe('columnNotes', () => {
  const profile = (sampled: number, columns: ColumnProfile['columns']): ColumnProfile => ({
    sampled,
    capped: false,
    columns,
    omitted: 0,
  })

  it('marks a column always NULL, one of one value, and one with a different value in every row', () => {
    const notes = columnNotes(
      profile(4, [
        { column: 'id', nulls: 0, distinct: 4, prefix: false },
        { column: 'gone', nulls: 4, distinct: 0, prefix: false },
        { column: 'kind', nulls: 0, distinct: 1, prefix: false },
        { column: 'name', nulls: 1, distinct: 3, prefix: false },
        { column: 'data', nulls: 4, distinct: null, prefix: false },
      ])
    )
    expect([...notes]).toEqual([
      ['id', 'unique'],
      ['gone', 'allNull'],
      ['kind', 'constant'],
      ['data', 'allNull'],
    ])
  })

  it('says nothing of an empty sample, nor of one row (it is unique and constant alike)', () => {
    expect(columnNotes(profile(0, [{ column: 'id', nulls: 0, distinct: 0, prefix: false }])).size).toBe(0)
    expect(columnNotes(profile(1, [{ column: 'id', nulls: 0, distinct: 1, prefix: false }])).get('id')).toBe('constant')
  })

  it('does not call a column with NULLs constant, nor one whose values are not compared unique', () => {
    const notes = columnNotes(
      profile(3, [
        { column: 'flag', nulls: 1, distinct: 1, prefix: false },
        { column: 'blob', nulls: 0, distinct: null, prefix: false },
      ])
    )
    expect(notes.size).toBe(0)
  })

  it('says nothing of how many values a column compared by its first characters holds', () => {
    const notes = columnNotes(
      profile(3, [
        { column: 'body', nulls: 0, distinct: 1, prefix: true },
        { column: 'html', nulls: 0, distinct: 3, prefix: true },
        { column: 'gone', nulls: 3, distinct: 0, prefix: true },
      ])
    )
    expect([...notes]).toEqual([['gone', 'allNull']])
  })
})
