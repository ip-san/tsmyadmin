import type { TableInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { groupTables, pageEntries } from './nav-groups.ts'

const t = (name: string): TableInfo => ({
  name,
  kind: 'table',
  inherits: [],
  rowEstimate: null,
  engine: null,
  comment: null,
  sizeBytes: null,
})

describe('groupTables', () => {
  const tables = ['orders', 'shop_items', 'shop_orders', 'users', 'wp_posts', '_hidden_x', '_hidden_y'].map(t)

  it('gathers tables that share a prefix, and leaves single ones and the rest where they are', () => {
    const entries = groupTables(tables, '_')
    expect(entries.map((e) => (e.kind === 'group' ? `${e.prefix}:${e.tables.length}` : e.table.name))).toEqual([
      'orders',
      'shop:2',
      'users',
      'wp_posts',
      '_hidden_x',
      '_hidden_y',
    ])
  })

  it('groups nothing without a delimiter, and takes a delimiter longer than one character', () => {
    expect(groupTables(tables, '').every((e) => e.kind === 'table')).toBe(true)
    const dotted = groupTables(['a.b.x', 'a.b.y', 'c'].map(t), '.')
    expect(dotted.map((e) => e.kind)).toEqual(['group', 'table'])
    expect(groupTables(['ab__1', 'ab__2'].map(t), '__')[0]).toMatchObject({ kind: 'group', prefix: 'ab' })
  })
})

describe('pageEntries', () => {
  it('shows the first entries and counts the rest', () => {
    expect(pageEntries([1, 2, 3, 4, 5], 2)).toEqual({ shown: [1, 2], rest: 3 })
    expect(pageEntries([1, 2], 10)).toEqual({ shown: [1, 2], rest: 0 })
  })
})
