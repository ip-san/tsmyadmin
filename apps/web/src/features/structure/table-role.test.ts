import type { ColumnProfile, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { columnNotes, tableRole } from './table-role.ts'

type Shape = Pick<TableSchema, 'primaryKey' | 'foreignKeys' | 'referencedBy'>
const fk = (columns: string[], refTable: string) =>
  ({ name: `fk_${refTable}`, columns, refTable, refColumns: ['id'] }) as unknown as Shape['foreignKeys'][number]
const from = (fromTable: string) =>
  ({
    name: `fk_${fromTable}`,
    fromTable,
    fromColumns: ['x_id'],
    columns: ['id'],
  }) as unknown as Shape['referencedBy'][number]
const shape = (primaryKey: string[], foreignKeys: Shape['foreignKeys'], referencedBy: Shape['referencedBy'] = []) => ({
  primaryKey,
  foreignKeys,
  referencedBy,
})

describe('tableRole', () => {
  it('calls a table whose key is two foreign keys a junction', () => {
    const tags = shape(['post_id', 'tag_id'], [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')])
    expect(tableRole(tags)).toEqual({ role: 'junction', refersTo: 2, referredBy: 0 })
  })

  it('does not call it a junction when its key has a column of its own', () => {
    const lines = shape(['order_id', 'line_no'], [fk(['order_id'], 'orders'), fk(['product_id'], 'products')])
    expect(tableRole(lines).role).toBe('detail')
  })

  it('tells masters, details, the ones in the middle and the isolated apart', () => {
    expect(tableRole(shape(['id'], [], [from('orders'), from('orders')]))).toEqual({
      role: 'master',
      refersTo: 0,
      referredBy: 1,
    })
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')])).role).toBe('detail')
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')], [from('lines')])).role).toBe('middle')
    expect(tableRole(shape(['id'], [])).role).toBe('isolated')
  })

  it('counts the tables a table refers to once, however many keys go to one', () => {
    const twice = shape(['id'], [fk(['created_by'], 'users'), fk(['updated_by'], 'users')])
    expect(tableRole(twice).refersTo).toBe(1)
  })
})

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
        { column: 'id', nulls: 0, distinct: 4 },
        { column: 'gone', nulls: 4, distinct: 0 },
        { column: 'kind', nulls: 0, distinct: 1 },
        { column: 'name', nulls: 1, distinct: 3 },
        { column: 'data', nulls: 4, distinct: null },
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
    expect(columnNotes(profile(0, [{ column: 'id', nulls: 0, distinct: 0 }])).size).toBe(0)
    expect(columnNotes(profile(1, [{ column: 'id', nulls: 0, distinct: 1 }])).get('id')).toBe('constant')
  })

  it('does not call a column with NULLs constant, nor one whose values are not compared unique', () => {
    const notes = columnNotes(
      profile(3, [
        { column: 'flag', nulls: 1, distinct: 1 },
        { column: 'blob', nulls: 0, distinct: null },
      ])
    )
    expect(notes.size).toBe(0)
  })
})
