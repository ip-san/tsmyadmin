import { describe, expect, it } from 'vitest'
import { type Answer, fail, rows, scripted } from '../test/scripted-conn.ts'
import { mysqlTableUsage } from './server.ts'

/** Table and index reads from performance_schema, and what a server without it, or an account without the privilege, gets. */

const server = (
  usage: Answer,
  on: Answer = rows([[1]]),
  instrument: Answer = rows([['YES']]),
  started: Answer = rows([['1800000000']])
) =>
  scripted([
    [/@@performance_schema/, on],
    [/setup_instruments/, instrument],
    [/table_io_waits_summary_by_index_usage/, usage],
    [/Uptime/, started],
  ])

describe('mysqlTableUsage', () => {
  it('adds up the reads without an index as full reads, and lists each index with whether it is unique', async () => {
    const s = server(
      rows([
        ['orders', null, 120, null],
        ['orders', 'PRIMARY', 40, 0],
        ['orders', 'idx_user', 7, 1],
        ['users', 'PRIMARY', 0, 0],
        // InnoDB's hidden clustered index of a table without a key: the catalog has no row for it.
        ['users', 'GEN_CLUST_INDEX', 3, null],
      ])
    )
    expect(await mysqlTableUsage(s.conn, 'shop')).toEqual({
      status: 'ok',
      unit: 'rows',
      since: new Date(1_800_000_000 * 1000).toISOString(),
      tables: [
        { table: 'orders', fullReads: 120, indexReads: 47 },
        { table: 'users', fullReads: 0, indexReads: 3 },
      ],
      indexes: [
        { table: 'orders', index: 'PRIMARY', reads: 40, unique: true },
        { table: 'orders', index: 'idx_user', reads: 7, unique: false },
        { table: 'users', index: 'PRIMARY', reads: 0, unique: true },
        { table: 'users', index: 'GEN_CLUST_INDEX', reads: 3, unique: false },
      ],
    })
    expect(s.asked.find((q) => /table_io_waits/.test(q.text))?.params).toEqual(['shop'])
  })

  const none = (status: 'unsupported' | 'denied') => ({ status, unit: 'rows', since: null, tables: [], indexes: [] })

  it.each([[[['OFF']]], [[[0]]], [[['0']]]])(
    'says there is nothing to read when performance_schema is off (%j), without asking its tables',
    async (off) => {
      const s = server(rows([]), rows(off))
      expect(await mysqlTableUsage(s.conn, 'shop')).toEqual(none('unsupported'))
      expect(s.asked.some((q) => /table_io_waits/.test(q.text))).toBe(false)
    }
  )

  it('says so too when the instrument that counts table reads is off: every count would be zero', async () => {
    const s = server(rows([['orders', null, 0, null]]), rows([[1]]), rows([['NO']]))
    expect(await mysqlTableUsage(s.conn, 'shop')).toEqual(none('unsupported'))
    expect(s.asked.some((q) => /table_io_waits/.test(q.text))).toBe(false)
  })

  it.each([
    ['an empty answer', rows([])],
    ['a refusal', fail('PERMISSION_DENIED')],
    ['no such table', fail('QUERY_FAILED', 'ER_NO_SUCH_TABLE')],
  ])('still gives the counts, with the start unknown, when the uptime comes back as %s', async (_, started) => {
    const s = server(rows([['orders', null, 1, null]]), rows([[1]]), rows([['YES']]), started)
    const report = await mysqlTableUsage(s.conn, 'shop')
    expect(report.status).toBe('ok')
    expect(report.since).toBeNull()
  })

  it('reads the instrument as on whatever case the server writes it in', async () => {
    const s = server(rows([['orders', null, 1, null]]), rows([[1]]), rows([['yes']]))
    expect((await mysqlTableUsage(s.conn, 'shop')).status).toBe('ok')
  })

  it('says so when the server has no such table, and when the account may not read it', async () => {
    expect(await mysqlTableUsage(server(fail('QUERY_FAILED', 'ER_NO_SUCH_TABLE')).conn, 'shop')).toEqual(
      none('unsupported')
    )
    expect(await mysqlTableUsage(server(fail('PERMISSION_DENIED')).conn, 'shop')).toEqual(none('denied'))
    expect(await mysqlTableUsage(server(fail('QUERY_FAILED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')).conn, 'shop')).toEqual(
      none('denied')
    )
  })

  it('passes on any other failure', async () => {
    await expect(mysqlTableUsage(server(fail('QUERY_FAILED', 'ER_PARSE_ERROR')).conn, 'shop')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    })
  })
})
