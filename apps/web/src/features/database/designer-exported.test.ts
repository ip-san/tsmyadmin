import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { exportedDiagram } from './designer-exported.ts'

const rel = (table: string, column: string, refTable: string, name = `fk_${table}`): RelationDef => ({
  table,
  name,
  columns: [column],
  refNamespace: { database: 'shop' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})
const key = rel('posts', 'user_id', 'users')
const candidate = rel('logs', 'post_id', 'posts', '\u0000post_id')
const names = ['users', 'posts', 'logs']
const none = () => undefined

describe('exportedDiagram', () => {
  it('writes every table and key of the database, and no candidate, without a focus', () => {
    const d = exportedDiagram({
      focused: false,
      shown: { tables: [...names, 'gone'], relations: [key, candidate] },
      names,
      keys: [key],
      allColumns: none,
    })
    expect(d.tables).toEqual(names)
    expect(d.relations).toEqual([key])
    // The candidate's column is not listed as a key column.
    expect(d.columns.get('logs')).toEqual([])
    expect(d.columns.get('posts')).toEqual(['user_id'])
  })

  it('writes what is drawn when focused, leaving out a table compared with and the candidates', () => {
    const d = exportedDiagram({
      focused: true,
      shown: { tables: ['posts', 'logs', 'gone'], relations: [candidate] },
      names,
      keys: [key],
      allColumns: none,
    })
    expect(d.tables).toEqual(['posts', 'logs'])
    expect(d.relations).toEqual([])
  })

  it('lists every column after the key columns when the boxes list them all', () => {
    const d = exportedDiagram({
      focused: false,
      shown: { tables: names, relations: [key] },
      names,
      keys: [key],
      allColumns: (n) => (n === 'posts' ? ['id', 'user_id', 'title'] : undefined),
    })
    expect(d.columns.get('posts')).toEqual(['user_id', 'id', 'title'])
  })
})
