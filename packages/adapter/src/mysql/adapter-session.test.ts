import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The MySQL adapter's connection that cancels statements, and ping and close, with `mysql2` replaced. */

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
