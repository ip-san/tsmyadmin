import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { boxColumns } from './layout.ts'
import { diagramFor, type OverlayStep, overlayUpTo } from './overlay.ts'

const rel = (table: string, refTable: string): RelationDef => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: { database: 'app' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: 'CASCADE',
})

const steps: OverlayStep[] = [
  { text: 'users', tables: [{ name: 'users', tone: 'focus', badge: '1' }] },
  {
    text: 'orders',
    tables: [{ name: 'orders', tone: 'delete', badge: '12' }],
    relations: [{ key: 'k1', tone: 'delete' }],
    columns: [{ table: 'orders', column: 'users_id' }],
  },
  { text: 'users again', tables: [{ name: 'users', tone: 'blocked' }], columns: [{ table: 'orders', column: 'id' }] },
]

describe('overlayUpTo', () => {
  it('shows nothing before the first step', () => {
    const o = overlayUpTo(steps, -1)
    expect(o.tables.size).toBe(0)
    expect(o.relations.size).toBe(0)
  })

  it('adds each step to the ones before it', () => {
    const o = overlayUpTo(steps, 1)
    expect([...o.tables.keys()]).toEqual(['users', 'orders'])
    expect(o.tables.get('orders')).toEqual({ tone: 'delete', badge: '12' })
    expect(o.relations.get('k1')).toBe('delete')
    expect([...(o.columns.get('orders') ?? [])]).toEqual(['users_id'])
  })

  it('lets a later step restate a table, and gathers the columns of every step', () => {
    const o = overlayUpTo(steps, 2)
    expect(o.tables.get('users')).toEqual({ tone: 'blocked', badge: undefined })
    expect([...(o.columns.get('orders') ?? [])]).toEqual(['users_id', 'id'])
  })

  it('stops at the last step when asked for more', () => {
    expect(overlayUpTo(steps, 99).tables.size).toBe(2)
  })
})

describe('diagramFor', () => {
  const relations = [rel('orders', 'users'), rel('items', 'orders'), rel('logs', 'audit')]

  it('draws only the tables named, once each, and the keys between them', () => {
    const d = diagramFor(['users', 'orders', 'users'], relations)
    expect(d.tables).toEqual(['users', 'orders'])
    expect(d.relations.map((r) => r.name)).toEqual(['fk_orders_users'])
    expect(Object.keys(d.positions)).toEqual(['users', 'orders'])
  })

  it('lays the referenced table to the left of the one that refers to it', () => {
    const d = diagramFor(['orders', 'users'], relations)
    expect(d.positions.users?.x).toBeLessThan(d.positions.orders?.x ?? 0)
  })

  it('lists the key columns, then the extra ones', () => {
    const d = diagramFor(['users', 'orders'], relations, new Map([['orders', ['created_at', 'users_id']]]))
    expect(d.columns.get('orders')).toEqual([...boxColumns('orders', d.relations), 'created_at'])
  })
})
