import type { ColumnProfile, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { columnNotes, tableRole } from './table-role.ts'

type Shape = Pick<TableSchema, 'name' | 'primaryKey' | 'foreignKeys' | 'referencedBy'>
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
  name: 'it',
  primaryKey,
  foreignKeys,
  referencedBy,
})

describe('tableRole', () => {
  it('calls a table whose key is two foreign keys a junction', () => {
    const tags = shape(['post_id', 'tag_id'], [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')])
    expect(tableRole(tags)).toEqual({ role: 'junction', refersTo: 2, referredBy: 0, self: false })
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
      self: false,
    })
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')])).role).toBe('detail')
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')], [from('lines')])).role).toBe('middle')
    expect(tableRole(shape(['id'], [])).role).toBe('isolated')
  })

  it('calls a table whose only key is to itself a tree, and does not count itself as another table', () => {
    // parent_id → it: the key of a tree; its own row refers to it as well.
    const tree = shape(['id'], [fk(['parent_id'], 'it')], [from('it')])
    expect(tableRole(tree)).toEqual({ role: 'tree', refersTo: 0, referredBy: 0, self: true })
    // A tree that also refers to another table is a detail of it, still marked as a tree.
    const both = shape(['id'], [fk(['parent_id'], 'it'), fk(['org_id'], 'orgs')], [from('it')])
    expect(tableRole(both)).toEqual({ role: 'detail', refersTo: 1, referredBy: 0, self: true })
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
