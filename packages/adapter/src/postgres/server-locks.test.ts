import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
import { pgLockWaits } from './server.ts'

/** Lock waits on PostgreSQL: pg_blocking_pids, and what an account that may not read other statements sees. */

describe('pgLockWaits', () => {
  it('pairs each waiting backend with its blocker, hiding statements the account may not read', async () => {
    const s = scripted([
      [/count\(\*\)/, rows([['12', '2', '100']])],
      [
        /pg_blocking_pids/,
        rows([
          [
            201,
            'app',
            'shop',
            '4',
            '<insufficient privilege>',
            200,
            'app',
            'shop',
            'idle in transaction',
            true,
            '60',
            'UPDATE t SET v = 1',
            't',
            'ShareLock',
          ],
          [202, null, null, null, null, 200, null, null, null, false, null, null, null, null],
        ]),
      ],
    ])
    const report = await pgLockWaits(s.conn)
    expect(report.connections).toEqual({ current: 12, max: 100, idleInTransaction: 2 })
    // Another role's sessions count, though their type is hidden from an account without pg_read_all_stats.
    expect(s.asked[0]?.text).toContain('OR (backend_type IS NULL AND datid IS NOT NULL AND usesysid IS NOT NULL)')
    expect(report.status).toBe('ok')
    expect(report.waits[0]).toEqual({
      blocked: { id: '201', user: 'app', database: 'shop', waitSec: 4, query: null, hidden: true },
      blocking: {
        id: '200',
        user: 'app',
        database: 'shop',
        state: 'idle in transaction',
        idleInTransaction: true,
        transactionSec: 60,
        query: 'UPDATE t SET v = 1',
      },
      table: 't',
      mode: 'ShareLock',
    })
    // No statement is not a hidden one.
    expect(report.waits[1]?.blocked).not.toHaveProperty('hidden')
    expect(report.waits[1]?.blocking).not.toHaveProperty('hidden')
    expect(report.waits[1]?.blocked.waitSec).toBeNull()
    expect(report.waits[1]?.blocking).toMatchObject({ idleInTransaction: false, transactionSec: null, state: null })
  })

  it('finds the waiting backends by the locks they were not given, which any account reads', async () => {
    const s = scripted([
      [/count\(\*\)/, rows([['1', '0', '100']])],
      [/pg_blocking_pids/, rows([])],
    ])
    await pgLockWaits(s.conn)
    // Not by the wait event, hidden with the statement from an account without pg_read_all_stats.
    expect(s.asked[1]?.text.replace(/\s+/g, ' ')).toBe(
      'SELECT w.pid, w.usename, w.datname, EXTRACT(EPOCH FROM (now() - coalesce(w.query_start, m.waitstart)))::bigint, ' +
        'left(w.query, 65536), ' +
        "b.pid, b.usename, b.datname, CASE WHEN b.state = 'active' THEN concat_ws(' / ', b.state, b.wait_event_type) ELSE b.state END, " +
        "coalesce(b.state LIKE 'idle in transaction%', false), EXTRACT(EPOCH FROM (now() - b.xact_start))::bigint, " +
        'left(b.query, 65536), t.rel, m.mode ' +
        'FROM (SELECT DISTINCT ON (l.pid) l.pid, l.mode, l.waitstart FROM pg_locks l WHERE NOT l.granted ORDER BY l.pid) m ' +
        'JOIN pg_stat_activity w ON w.pid = m.pid ' +
        'CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ' +
        'JOIN pg_stat_activity b ON b.pid = bp.pid ' +
        'LEFT JOIN LATERAL (SELECT l.relation::regclass::text AS rel FROM pg_locks l ' +
        "WHERE l.pid = w.pid AND l.relation IS NOT NULL AND (NOT l.granted OR l.locktype = 'tuple') " +
        'AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) ' +
        'ORDER BY l.granted LIMIT 1) t ON true ' +
        'ORDER BY 4 DESC NULLS LAST, 1, 6'
    )
  })

  it("lists a wait between two other roles' sessions, whose statements it may not read", async () => {
    const s = scripted([
      [/count\(\*\)/, rows([['3', '0', '100']])],
      [
        /pg_blocking_pids/,
        rows([
          [
            350,
            'app',
            'shop',
            '2',
            '<insufficient privilege>',
            338,
            'app',
            'shop',
            null,
            false,
            null,
            '<insufficient privilege>',
            't',
            'ShareLock',
          ],
        ]),
      ],
    ])
    expect((await pgLockWaits(s.conn)).waits).toEqual([
      {
        blocked: { id: '350', user: 'app', database: 'shop', waitSec: 2, query: null, hidden: true },
        blocking: {
          id: '338',
          user: 'app',
          database: 'shop',
          state: null,
          idleInTransaction: false,
          transactionSec: null,
          query: null,
          hidden: true,
        },
        table: 't',
        mode: 'ShareLock',
      },
    ])
  })
})
