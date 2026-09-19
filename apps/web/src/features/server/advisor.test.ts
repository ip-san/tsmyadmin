import type { KeyValue } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { advise, fill, settingBytes } from './advisor.ts'

const kv = (o: Record<string, string>): KeyValue[] =>
  Object.entries(o).map(([name, value]) => ({ name, value, description: null }))
const ids = (f: ReturnType<typeof advise>) => f.map((x) => x.id)

describe('advise (MySQL)', () => {
  const base = { dialect: 'mysql' as const, uptimeSec: 10 * 86_400 }

  it('is quiet for a healthy server', () => {
    const status = kv({
      Questions: '100000',
      Slow_queries: '2',
      Connections: '5000',
      Threads_created: '20',
      Max_used_connections: '30',
    })
    const variables = kv({ max_connections: '151', slow_query_log: 'ON', innodb_flush_log_at_trx_commit: '1' })
    expect(advise({ ...base, status, variables })).toEqual([])
  })

  it('names what the counters point at, and marks the status variables', () => {
    const status = kv({
      Questions: '100000',
      Slow_queries: '9000',
      Connections: '1000',
      Threads_created: '400',
      Max_used_connections: '140',
      Innodb_buffer_pool_reads: '5000',
      Innodb_buffer_pool_read_requests: '100000',
    })
    const variables = kv({ max_connections: '151', slow_query_log: 'OFF', thread_cache_size: '0' })
    const found = advise({ ...base, status, variables })
    expect(ids(found)).toEqual(
      expect.arrayContaining(['slowLogOff', 'slowQueries', 'threadCache', 'maxConnections', 'bufferPool'])
    )
    expect(found.find((f) => f.id === 'slowQueries')).toMatchObject({
      level: 'warn',
      flags: ['Slow_queries'],
      values: { ratio: '9.0%' },
    })
  })

  it('does not read a ratio over too few events', () => {
    const status = kv({ Questions: '50', Slow_queries: '50', Connections: '10', Threads_created: '10' })
    expect(ids(advise({ ...base, status, variables: kv({ slow_query_log: 'ON' }) }))).toEqual([])
  })

  it('says statistics are short when the server has only just started', () => {
    expect(ids(advise({ ...base, uptimeSec: 3600, status: [], variables: [] }))).toEqual(['uptimeShort'])
  })
})

describe('advise (PostgreSQL)', () => {
  const base = { dialect: 'postgres' as const, uptimeSec: null }

  it('reads cache hits, deadlocks and settings that put data at risk', () => {
    const status = kv({
      blks_hit: '9000',
      blks_read: '5000',
      deadlocks: '2',
      total_connections: '90',
      max_connections: '100',
    })
    const variables = kv({ fsync: 'off', autovacuum: 'on', shared_buffers: '8192 8kB' })
    expect(ids(advise({ ...base, status, variables }))).toEqual(
      expect.arrayContaining(['pgCacheHit', 'pgDeadlocks', 'pgConnections', 'pgFsyncOff', 'pgSharedBuffers'])
    )
  })
})

describe('helpers', () => {
  it('reads pg_settings sizes', () => {
    expect(settingBytes('16384 8kB')).toBe(16384 * 8192)
    expect(settingBytes('128MB')).toBe(128 * 1024 ** 2)
    expect(settingBytes('4096 kB')).toBe(4096 * 1024)
    expect(settingBytes(undefined)).toBeNull()
  })

  it('fills placeholders', () => {
    expect(fill('{a} of {b}{c}', { a: '1', b: '2' })).toBe('1 of 2')
  })
})
