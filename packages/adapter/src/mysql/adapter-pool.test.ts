import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How the MySQL adapter opens its pool: the driver's `createPool` is replaced, so what it was given can be read.
 * These options decide how every value comes back (numbers, dates, JSON, rows as arrays) and are not otherwise seen.
 */

const created: { options: Record<string, unknown>; pool: EventEmitter }[] = []
vi.mock('mysql2/promise', () => ({
  default: {
    createPool: (options: Record<string, unknown>) => {
      const pool = new EventEmitter()
      created.push({ options, pool })
      return pool
    },
  },
}))

const { MysqlAdapter } = await import('./adapter.ts')

const config = { dialect: 'mysql' as const, host: 'db.example', port: 3307, user: 'u', password: 'secret' }
const poolOf = (a: InstanceType<typeof MysqlAdapter>) => (a as unknown as { getPool: () => EventEmitter }).getPool()
const threadsOf = (a: InstanceType<typeof MysqlAdapter>) => (a as unknown as { ownThreads: number[] }).ownThreads

beforeEach(() => {
  created.length = 0
})

describe('MysqlAdapter pool', () => {
  it('connects as the account to the host and port given, and to the database only when one was given', () => {
    poolOf(new MysqlAdapter(config))
    expect(created[0]?.options).toMatchObject({ host: 'db.example', port: 3307, user: 'u', password: 'secret' })
    expect(created[0]?.options).not.toHaveProperty('database')
    poolOf(new MysqlAdapter({ ...config, database: 'shop' }))
    expect(created[1]?.options).toMatchObject({ database: 'shop' })
    poolOf(new MysqlAdapter({ ...config, database: '' }))
    expect(created[2]?.options).not.toHaveProperty('database')
  })

  it('reads values the way the rest of the tool expects them', () => {
    poolOf(new MysqlAdapter(config))
    expect(created[0]?.options).toMatchObject({
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      dateStrings: true,
      jsonStrings: true,
      rowsAsArray: true,
      connectionLimit: 4,
      connectTimeout: 10_000,
      idleTimeout: 60_000,
      connectAttributes: { program_name: 'tsmyadmin' },
    })
  })

  it('uses the collation of the connection as the charset, utf8mb4_unicode_ci unless another was chosen', () => {
    poolOf(new MysqlAdapter(config))
    poolOf(new MysqlAdapter({ ...config, collation: 'latin1_swedish_ci' }))
    expect(created.map((c) => c.options.charset)).toEqual(['utf8mb4_unicode_ci', 'latin1_swedish_ci'])
  })

  it('refuses a collation that is only a character set, naming it', () => {
    expect(() => poolOf(new MysqlAdapter({ ...config, collation: 'utf8mb4' }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: 'Not a collation name: utf8mb4' })
    )
  })

  it('hands geometry over as its raw bytes and leaves every other type to the driver', () => {
    poolOf(new MysqlAdapter(config))
    const cast = created[0]?.options.typeCast as (f: unknown, next: () => unknown) => unknown
    const bytes = Buffer.from([1, 2])
    expect(cast({ type: 'GEOMETRY', buffer: () => bytes }, () => 'driver')).toBe(bytes)
    expect(cast({ type: 'VAR_STRING', buffer: () => bytes }, () => 'driver')).toBe('driver')
    expect(cast({ type: 'geometry', buffer: () => bytes }, () => 'driver')).toBe('driver')
  })

  it('opens one pool and keeps it', () => {
    const a = new MysqlAdapter(config)
    expect(poolOf(a)).toBe(poolOf(a))
    expect(created).toHaveLength(1)
  })

  it('remembers the thread of each connection it opens, and only the latest 64', () => {
    const a = new MysqlAdapter(config)
    const pool = poolOf(a)
    for (let id = 1; id <= 64; id++) pool.emit('connection', { threadId: id })
    expect(threadsOf(a)).toHaveLength(64)
    expect(threadsOf(a)[0]).toBe(1)
    pool.emit('connection', { threadId: 65 })
    expect(threadsOf(a)).toHaveLength(64)
    expect(threadsOf(a)[0]).toBe(2)
    expect(threadsOf(a).at(-1)).toBe(65)
    for (let id = 66; id <= 200; id++) pool.emit('connection', { threadId: id })
    expect(threadsOf(a)).toEqual(Array.from({ length: 64 }, (_, i) => 137 + i))
  })

  it('starts with no threads of its own', () => {
    expect(threadsOf(new MysqlAdapter(config))).toEqual([])
  })
})
