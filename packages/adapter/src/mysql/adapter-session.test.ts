import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { fail, rows, scripted } from '../test/scripted-conn.ts'

/**
 * The MySQL adapter's connection that cancels statements, ping and close, and two places where a failure must not
 * be taken for the one case the code tolerates (a retry only for an interrupted probe, a fallback only for an
 * unknown variable), with `mysql2` replaced.
 */

const state = vi.hoisted(() => ({
  created: [] as { options: Record<string, unknown>; query: unknown; end: unknown }[],
  create: (async () => undefined) as () => Promise<void>,
}))

vi.mock('mysql2/promise', async (original) => {
  const actual = (await original()) as unknown as { default: Record<string, unknown> }
  return {
    ...actual,
    default: {
      ...actual.default,
      createConnection: async (options: Record<string, unknown>) => {
        await state.create()
        const conn = { options, query: vi.fn(async () => [[], []]), end: vi.fn(async () => undefined) }
        state.created.push(conn)
        return conn
      },
    },
  }
})

const { MysqlAdapter } = await import('./adapter.ts')
type Adapter = InstanceType<typeof MysqlAdapter>
const config = { dialect: 'mysql' as const, host: 'db.example', port: 3307, user: 'u', password: 'secret' }
type Internals = Record<string, ((...args: unknown[]) => unknown) | undefined>
const internals = (a: Adapter) => a as unknown as Internals

/** The mocked `query` and `end` of the first connection the adapter opened. */
const opened = () => {
  const first = state.created[0]
  if (!first) throw new Error('no connection was opened')
  return { query: first.query as ReturnType<typeof vi.fn>, end: first.end as ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  state.created.length = 0
  state.create = async () => undefined
})

describe('MysqlAdapter: the connection that cancels statements', () => {
  it('connects on its own as the same account, giving up after 10 seconds', async () => {
    await internals(new MysqlAdapter(config)).openCanceller?.({ database: 'd' })
    expect(state.created[0]?.options).toEqual({
      host: 'db.example',
      port: 3307,
      user: 'u',
      password: 'secret',
      connectTimeout: 10_000,
    })
  })

  it('cancels a statement with KILL QUERY, which keeps the session, and closes without failing', async () => {
    const c = (await internals(new MysqlAdapter(config)).openCanceller?.({ database: 'd' })) as {
      cancel: (id: string) => Promise<void>
      close: () => Promise<void>
    }
    await c.cancel('4242')
    expect(opened().query.mock.calls).toEqual([['KILL QUERY 4242']])
    await c.close()
    const { end } = opened()
    expect(end).toHaveBeenCalledTimes(1)
    end.mockRejectedValueOnce(new Error('already closed'))
    await expect(c.close()).resolves.toBeUndefined()
  })

  it('reports a failed cancel as an adapter error', async () => {
    const c = (await internals(new MysqlAdapter(config)).openCanceller?.({ database: 'd' })) as {
      cancel: (id: string) => Promise<void>
    }
    opened().query.mockRejectedValueOnce(
      Object.assign(new Error('Unknown thread id'), { code: 'ER_NO_SUCH_THREAD', errno: 1094 })
    )
    await expect(c.cancel('1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports it as an adapter error when it cannot connect', async () => {
    state.create = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    await expect(internals(new MysqlAdapter(config)).openCanceller?.({ database: 'd' })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    })
  })
})

describe('MysqlAdapter: ping and close', () => {
  it('pings with SELECT 1 on a pooled connection and gives the connection back, a failure being an adapter error', async () => {
    const a = new MysqlAdapter(config)
    const query = vi.fn(async () => [[], []])
    const release = vi.fn()
    internals(a).getConnection = async () => ({ query, release })
    await expect(a.ping()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('SELECT 1')
    expect(release).toHaveBeenCalledTimes(1)
    query.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }))
    await expect(a.ping()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('ends the pool once and forgets it, and does nothing when there is none', async () => {
    const a = new MysqlAdapter(config)
    await expect(a.close()).resolves.toBeUndefined()
    const end = vi.fn(async () => undefined)
    ;(a as unknown as { pool: unknown }).pool = { end }
    await a.close()
    expect(end).toHaveBeenCalledTimes(1)
    expect((a as unknown as { pool: unknown }).pool).toBeNull()
    await a.close()
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe('MysqlAdapter: failures the code must not take for the ones it tolerates', () => {
  it('rethrows an adapter error that is not the unknown variable when setting the statement time', async () => {
    const a = new MysqlAdapter(config)
    const c = scripted([[/max_execution_time/, fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')]])
    await expect(internals(a).setStatementTimeout?.(c.conn, 1)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(c.asked).toHaveLength(1)
    expect((a as unknown as { timeoutVariable: string }).timeoutVariable).toBe('max_execution_time')
  })

  it('remembers that the server has only max_statement_time, and does not ask for the other again', async () => {
    const a = new MysqlAdapter(config)
    const c = scripted([
      [/max_execution_time/, fail('QUERY_FAILED', 'ER_UNKNOWN_SYSTEM_VARIABLE')],
      [/max_statement_time/, rows([])],
    ])
    await internals(a).setStatementTimeout?.(c.conn, 1000)
    expect((a as unknown as { timeoutVariable: string }).timeoutVariable).toBe('max_statement_time')
  })

  it('probes a transaction once more only when the first probe was interrupted, not for any other failure', async () => {
    const a = new MysqlAdapter(config)
    const probe = async (error: Error) => {
      const query = vi.fn(async (sql: string) => {
        if (sql === 'DO 0') throw error
        return [[], []]
      })
      const core = {}
      ;(a as unknown as { getConnection: () => Promise<unknown> }).getConnection = async () => ({
        connection: core,
        query,
        release: () => undefined,
        destroy: () => undefined,
      })
      ;(a as unknown as { mariadb: boolean }).mariadb = false
      ;(a as unknown as { currentDatabase: WeakMap<object, string> }).currentDatabase.set(core, 'd')
      const conn = (await (a as unknown as { acquire: (ns: unknown) => Promise<Conn> }).acquire({
        database: 'd',
      })) as Conn
      await conn.inTransaction?.().catch(() => undefined)
      return query.mock.calls.filter(([sql]) => sql === 'DO 0').length
    }
    expect(await probe(Object.assign(new Error('x'), { code: 'ER_OTHER' }))).toBe(1)
    expect(await probe(Object.assign(new Error('x'), { code: 'ER_QUERY_INTERRUPTED' }))).toBe(2)
  })

  it('treats a server version it cannot read as not MariaDB', async () => {
    for (const answer of [[], [[null]], [['8.0.36']]]) {
      const a = new MysqlAdapter(config)
      const core = {}
      const query = vi.fn(async (q: string | { sql: string }) => {
        const sql = typeof q === 'string' ? q : q.sql
        return sql === 'SELECT VERSION()'
          ? [answer, [{ name: 'v', columnType: 253, columnLength: 10, flags: 0, characterSet: 224 }]]
          : [{ affectedRows: 0 }, undefined]
      })
      ;(a as unknown as { getConnection: () => Promise<unknown> }).getConnection = async () => ({
        connection: core,
        query,
        release: () => undefined,
        destroy: () => undefined,
      })
      await (a as unknown as { acquire: (ns: unknown) => Promise<Conn> }).acquire({ database: 'd' })
      expect((a as unknown as { mariadb: boolean | null }).mariadb).toBe(false)
    }
  })
})
