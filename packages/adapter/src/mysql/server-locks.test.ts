import { describe, expect, it } from 'vitest'
import { type Answer, fail, rows, scripted } from '../test/scripted-conn.ts'
import { mysqlLockWaits } from './server.ts'

/** Lock waits on MySQL 8 and MariaDB, and what a server without them, or an account without the privilege, gets. */

const PAIR = [
  12,
  'app',
  'shop',
  4,
  'UPDATE t SET v = 2 WHERE id = 1',
  11,
  'app',
  'shop',
  'Sleep',
  1,
  60,
  'UPDATE t SET v = 1 WHERE id = 1',
  'shop.t',
  'X,REC_NOT_GAP',
]

const server = (waits: Answer, more: [RegExp, Answer][] = []) =>
  scripted([
    [/Threads_connected/, rows([['Threads_connected', '140']])],
    [/@@max_connections/, rows([[151]])],
    [/COUNT\(\*\)/, rows([[3]])],
    [/performance_schema\.data_lock_waits/, waits],
    ...more,
  ])

describe('mysqlLockWaits', () => {
  it('pairs the waiting session with the one holding the lock, with the connection usage', async () => {
    const s = server(rows([PAIR]))
    expect(await mysqlLockWaits(s.conn)).toEqual({
      status: 'ok',
      waits: [
        {
          blocked: { id: '12', user: 'app', database: 'shop', waitSec: 4, query: 'UPDATE t SET v = 2 WHERE id = 1' },
          blocking: {
            id: '11',
            user: 'app',
            database: 'shop',
            state: 'Sleep',
            idleInTransaction: true,
            transactionSec: 60,
            query: 'UPDATE t SET v = 1 WHERE id = 1',
          },
          table: 'shop.t',
          mode: 'X,REC_NOT_GAP',
        },
      ],
      connections: { current: 140, max: 151, idleInTransaction: 3 },
    })
  })

  it('falls back to MariaDB’s INNODB_LOCK_WAITS once performance_schema has no lock table, and remembers it', async () => {
    const s = server(fail('NOT_FOUND', 'ER_NO_SUCH_TABLE'), [[/INNODB_LOCK_WAITS/, rows([PAIR])]])
    expect((await mysqlLockWaits(s.conn)).waits.map((w) => w.blocking.id)).toEqual(['11'])
    expect(s.asked.filter((q) => /data_lock_waits/.test(q.text))).toHaveLength(1)
    await mysqlLockWaits(s.conn)
    expect(s.asked.filter((q) => /data_lock_waits/.test(q.text))).toHaveLength(1)
    expect(s.asked.filter((q) => /INNODB_LOCK_WAITS/.test(q.text))).toHaveLength(2)
  })

  it('says `unsupported` where neither form exists, or performance_schema is off and its tables are empty', async () => {
    const neither = server(fail('NOT_FOUND', 'ER_NO_SUCH_TABLE'), [
      [/INNODB_LOCK_WAITS/, fail('QUERY_FAILED', 'ER_UNKNOWN_TABLE')],
    ])
    expect(await mysqlLockWaits(neither.conn)).toMatchObject({ status: 'unsupported', waits: [] })
    const off = server(rows([]), [[/@@performance_schema/, rows([[0]])]])
    expect((await mysqlLockWaits(off.conn)).status).toBe('unsupported')
    const on = server(rows([]), [[/@@performance_schema/, rows([[1]])]])
    expect(await mysqlLockWaits(on.conn)).toMatchObject({ status: 'ok', waits: [] })
  })

  it('says `denied` without the PROCESS privilege, still counting the connections', async () => {
    const s = scripted([
      [/Threads_connected/, rows([['Threads_connected', '5']])],
      [/@@max_connections/, rows([[151]])],
      [/INNODB_TRX/, fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')],
    ])
    expect(await mysqlLockWaits(s.conn)).toEqual({
      status: 'denied',
      waits: [],
      connections: { current: 5, max: 151, idleInTransaction: null },
    })
    const table = server(fail('PERMISSION_DENIED', 'ER_TABLEACCESS_DENIED_ERROR'))
    expect((await mysqlLockWaits(table.conn)).status).toBe('denied')
  })

  it('lets any other failure through', async () => {
    const s = server(fail('QUERY_FAILED', 'ER_PARSE_ERROR'))
    await expect(mysqlLockWaits(s.conn)).rejects.toMatchObject({ nativeCode: 'ER_PARSE_ERROR' })
    const count = scripted([
      [/Threads_connected/, rows([['Threads_connected', '5']])],
      [/@@max_connections/, rows([[151]])],
      [/COUNT\(\*\)/, new Error('boom')],
    ])
    await expect(mysqlLockWaits(count.conn)).rejects.toThrow('boom')
  })
})
