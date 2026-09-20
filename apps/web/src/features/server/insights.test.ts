import type { KeyValue } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { queryStatistics, startedAt, statusCategory, traffic } from './insights.ts'

const kv = (o: Record<string, string>): KeyValue[] =>
  Object.entries(o).map(([name, value]) => ({ name, value, description: null }))

describe('traffic', () => {
  it('gives totals per hour of uptime and current values as they are (MySQL)', () => {
    const found = traffic('mysql', kv({ Bytes_sent: '7200', Connections: '20', Threads_connected: '3' }), 7200)
    expect(found).toEqual([
      { key: 'bytesSent', value: 7200, kind: 'bytes', perHour: 3600 },
      { key: 'connections', value: 20, kind: 'count', perHour: 10 },
      { key: 'threadsConnected', value: 3, kind: 'count', perHour: null },
    ])
  })

  it('adds commits and rollbacks into transactions (PostgreSQL) and leaves per-hour empty for a new server', () => {
    const found = traffic('postgres', kv({ xact_commit: '90', xact_rollback: '10' }), 30)
    expect(found[0]).toEqual({ key: 'transactions', value: 100, kind: 'count', perHour: null })
  })
})

describe('queryStatistics', () => {
  it('lists statement kinds by count with their share (MySQL)', () => {
    const found = queryStatistics(
      'mysql',
      kv({ Com_select: '75', Com_insert: '25', Com_update: '0', Questions: '999' })
    )
    expect(found).toEqual([
      { name: 'select', count: 75, share: 0.75 },
      { name: 'insert', count: 25, share: 0.25 },
    ])
  })

  it('lists the rows touched by kind (PostgreSQL)', () => {
    expect(
      queryStatistics('postgres', kv({ tup_returned: '10', tup_deleted: '30', xact_commit: '5' })).map((r) => r.name)
    ).toEqual(['deleted', 'returned'])
  })
})

describe('statusCategory', () => {
  it('takes the prefix on MySQL only', () => {
    expect(statusCategory('mysql', 'Innodb_buffer_pool_reads')).toBe('Innodb')
    expect(statusCategory('mysql', 'Uptime')).toBe('Uptime')
    expect(statusCategory('postgres', 'blks_read')).toBe('')
  })
})

describe('startedAt', () => {
  it('is the uptime before now, and unknown without one', () => {
    expect(startedAt(3600, Date.UTC(2026, 0, 1, 12))?.toISOString()).toBe('2026-01-01T11:00:00.000Z')
    expect(startedAt(null)).toBeNull()
  })
})
