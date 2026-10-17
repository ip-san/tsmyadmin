import { describe, expect, it } from 'vitest'
import { type Answer, fail, rows, scripted } from '../test/scripted-conn.ts'
import { mysqlTableUsage } from './server.ts'

/** Table and index reads from performance_schema, and what a server without it, or an account without the privilege, gets. */

const server = (usage: Answer, on: Answer = rows([[1]])) =>
  scripted([
    [/@@performance_schema/, on],
    [/table_io_waits_summary_by_index_usage/, usage],
    [/Uptime/, rows([['Uptime', '3600']])],
    [/UNIX_TIMESTAMP/, rows([[1_800_003_600]])],
  ])

describe('mysqlTableUsage', () => {
  it('adds up the reads without an index as full reads, and lists each index with whether it is unique', async () => {
    const s = server(
      rows([
        ['orders', null, 120, null],
        ['orders', 'PRIMARY', 40, 0],
        ['orders', 'idx_user', 7, 1],
        ['users', 'PRIMARY', 0, 0],
      ])
    )
    expect(await mysqlTableUsage(s.conn, 'shop')).toEqual({
      status: 'ok',
      unit: 'rows',
      since: new Date(1_800_000_000 * 1000).toISOString(),
      tables: [
        { table: 'orders', fullReads: 120, indexReads: 47 },
        { table: 'users', fullReads: 0, indexReads: 0 },
      ],
      indexes: [
        { table: 'orders', index: 'PRIMARY', reads: 40, unique: true },
        { table: 'orders', index: 'idx_user', reads: 7, unique: false },
        { table: 'users', index: 'PRIMARY', reads: 0, unique: true },
      ],
    })
    expect(s.asked.find((q) => /table_io_waits/.test(q.text))?.params).toEqual(['shop'])
  })

  const none = (status: 'unsupported' | 'denied') => ({ status, unit: 'rows', since: null, tables: [], indexes: [] })

  it('says there is nothing to read when performance_schema is off, without asking its tables', async () => {
    const s = server(rows([]), rows([['OFF']]))
    expect(await mysqlTableUsage(s.conn, 'shop')).toEqual(none('unsupported'))
    expect(s.asked.some((q) => /table_io_waits/.test(q.text))).toBe(false)
  })

  it('says so when the server has no such table, and when the account may not read it', async () => {
    expect(await mysqlTableUsage(server(fail('QUERY_FAILED', 'ER_NO_SUCH_TABLE')).conn, 'shop')).toEqual(
      none('unsupported')
    )
    expect(await mysqlTableUsage(server(fail('PERMISSION_DENIED')).conn, 'shop')).toEqual(none('denied'))
  })

  it('passes on any other failure', async () => {
    await expect(mysqlTableUsage(server(fail('QUERY_FAILED', 'ER_PARSE_ERROR')).conn, 'shop')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    })
  })
})
