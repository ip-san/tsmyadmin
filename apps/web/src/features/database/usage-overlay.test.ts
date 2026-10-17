import type { TableUsageReport } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { unusedIndexes, usageOverlay } from './usage-overlay.ts'

const t = locale.designer.usage
const report: TableUsageReport = {
  status: 'ok',
  unit: 'scans',
  since: '2026-10-01T00:00:00Z',
  tables: [
    { table: 'orders', fullReads: 900, indexReads: 20 },
    { table: 'users', fullReads: 3, indexReads: 4000 },
    { table: 'logs', fullReads: 0, indexReads: 0 },
    { table: 'even', fullReads: 5, indexReads: 5 },
  ],
  indexes: [
    { table: 'orders', index: 'orders_pkey', reads: 0, unique: true },
    { table: 'orders', index: 'idx_orders_note', reads: 0, unique: false },
    { table: 'users', index: 'idx_users_name', reads: 12, unique: false },
  ],
}

describe('usageOverlay', () => {
  const overlay = usageOverlay(report)

  it('marks a table read mostly in full, and one read mostly through an index, with their counts', () => {
    expect(overlay.tables.get('orders')).toEqual({ tone: 'scan', badge: t.badge(900, 20) })
    expect(overlay.tables.get('users')).toEqual({ tone: 'index', badge: t.badge(3, 4000) })
  })

  it('leaves a table never read untoned, and calls a tie an index read', () => {
    expect(overlay.tables.has('logs')).toBe(false)
    expect(overlay.tables.get('even')?.tone).toBe('index')
  })
})

describe('unusedIndexes', () => {
  it('lists the indexes never read, leaving out those that keep rows unique', () => {
    expect(unusedIndexes(report).map((i) => i.index)).toEqual(['idx_orders_note'])
  })
})
