import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
import { pgTableUsage } from './introspect.ts'

/** What `pgTableUsage` makes of the statistics views' rows, every way they can come (a real server answers one way). */

const usage = (tables: unknown[][], indexes: unknown[][], since: unknown[][] = [['2026-10-01T00:00:00Z']]) =>
  scripted([
    [/pg_stat_user_tables/, rows(tables)],
    [/pg_stat_user_indexes/, rows(indexes)],
    [/pg_stat_database/, rows(since)],
  ])

describe('pgTableUsage', () => {
  it('reads sequential and index scans per table, and the scans of each index with whether it is unique', async () => {
    const s = usage(
      [
        ['orders', 120, 40],
        ['logs', 3, null],
      ],
      [
        ['orders', 'orders_pkey', 40, true],
        ['orders', 'orders_note_idx', 0, 'f'],
        ['orders', 'orders_user_idx', null, 't'],
      ]
    )
    expect(await pgTableUsage(s.conn, { database: 'shop' })).toEqual({
      status: 'ok',
      unit: 'scans',
      since: '2026-10-01T00:00:00Z',
      tables: [
        { table: 'orders', fullReads: 120, indexReads: 40 },
        // A table without an index has no index scans to count (NULL), which is none.
        { table: 'logs', fullReads: 3, indexReads: 0 },
      ],
      indexes: [
        { table: 'orders', index: 'orders_pkey', reads: 40, unique: true },
        { table: 'orders', index: 'orders_note_idx', reads: 0, unique: false },
        { table: 'orders', index: 'orders_user_idx', reads: 0, unique: true },
      ],
    })
  })

  it('reads the namespace public when none is named, and the schema given otherwise', async () => {
    const s = usage([], [])
    await pgTableUsage(s.conn, { database: 'shop' })
    await pgTableUsage(s.conn, { database: 'shop', schema: 'sales' })
    const bound = s.asked.filter((q) => /pg_stat_user_/.test(q.text)).map((q) => q.params)
    expect(bound).toEqual([['public'], ['public'], ['sales'], ['sales']])
  })

  it('has no start to give when the statistics were never reset', async () => {
    expect((await pgTableUsage(usage([], [], [[null]]).conn, { database: 'shop' })).since).toBeNull()
    expect((await pgTableUsage(usage([], [], []).conn, { database: 'shop' })).since).toBeNull()
  })
})
