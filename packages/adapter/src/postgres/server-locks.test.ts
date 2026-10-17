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
    expect(report.status).toBe('ok')
    expect(report.waits[0]).toEqual({
      blocked: { id: '201', user: 'app', database: 'shop', waitSec: 4, query: null },
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
    expect(report.waits[1]?.blocked.waitSec).toBeNull()
    expect(report.waits[1]?.blocking).toMatchObject({ idleInTransaction: false, transactionSec: null, state: null })
  })
})
