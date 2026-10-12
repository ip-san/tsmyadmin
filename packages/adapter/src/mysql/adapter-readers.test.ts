import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import { rows, scripted } from '../test/scripted-conn.ts'
import { MysqlAdapter } from './adapter.ts'

/**
 * Two readers of the MySQL adapter that only a real server exercised, each with its connection scripted: the list of
 * databases with their sizes, and a table's description with the defaults a catalog column cannot hold (found by
 * mutation testing the adapter with the integration tests on).
 */

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'p' }
const ns = { database: 'db' }

/** The adapter with its pool replaced by scripted answers: `withPoolConnection` runs `fn` on a fake connection. */
function listing(answers: { databases: unknown[][]; stats?: unknown[][]; schemata?: unknown[][] }) {
  const adapter = new MysqlAdapter(config)
  const asked: string[] = []
  const fake = {
    query: async ({ sql }: { sql: string }) => {
      asked.push(sql)
      if (/SHOW DATABASES/.test(sql)) return [answers.databases, []]
      if (/information_schema\.TABLES/.test(sql)) return [answers.stats ?? [], []]
      if (/information_schema\.SCHEMATA/.test(sql)) return [answers.schemata ?? [], []]
      throw new Error(`unscripted: ${sql}`)
    },
  }
  ;(adapter as unknown as { withPoolConnection: (fn: (c: unknown) => unknown) => unknown }).withPoolConnection = async (
    fn
  ) => await fn(fake)
  return { adapter, asked }
}

describe('MysqlAdapter.listDatabases', () => {
  it('lists the databases by name with their size, table count and collation', async () => {
    const { adapter } = listing({
      databases: [['zeta'], ['alpha'], ['beta']],
      stats: [
        ['alpha', '4096', '3'],
        ['beta', 0, 0],
      ],
      schemata: [
        ['alpha', 'utf8mb4_bin'],
        ['beta', null],
        ['zeta', 'latin1_swedish_ci'],
      ],
    })
    expect(await adapter.listDatabases()).toEqual([
      { name: 'alpha', sizeBytes: 4096, tableCount: 3, collation: 'utf8mb4_bin' },
      { name: 'beta', sizeBytes: 0, tableCount: 0, collation: null },
      { name: 'zeta', sizeBytes: 0, tableCount: 0, collation: 'latin1_swedish_ci' },
    ])
  })

  it('has no size or count, and does not ask for them, when statistics are not wanted', async () => {
    const { adapter, asked } = listing({ databases: [['a']], stats: [['a', '1', '1']], schemata: [['a', 'x']] })
    expect(await adapter.listDatabases({ stats: false })).toEqual([
      { name: 'a', sizeBytes: null, tableCount: null, collation: 'x' },
    ])
    expect(asked.some((sql) => /information_schema\.TABLES/.test(sql))).toBe(false)
    const withStats = listing({ databases: [['a']], stats: [['a', '8', '2']] })
    expect(await withStats.adapter.listDatabases({ stats: true })).toMatchObject([{ sizeBytes: 8, tableCount: 2 }])
    expect(withStats.asked.some((sql) => /information_schema\.TABLES/.test(sql))).toBe(true)
  })

  it('puts the names in order whatever order the server listed them, a database with no statistics at zero', async () => {
    const { adapter } = listing({ databases: [['c'], ['a'], ['B'], ['b']] })
    expect((await adapter.listDatabases()).map((d) => d.name)).toEqual(['a', 'b', 'B', 'c'])
    expect((await adapter.listDatabases())[0]).toMatchObject({ sizeBytes: 0, tableCount: 0, collation: null })
  })

  it('reports a failure of the server as an adapter error', async () => {
    const adapter = new MysqlAdapter(config)
    ;(adapter as unknown as { withPoolConnection: () => Promise<never> }).withPoolConnection = async () => {
      throw Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 })
    }
    await expect(adapter.listDatabases()).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })
})

describe('MysqlAdapter.describeTable: a default the catalog cannot hold', () => {
  const info = [['BASE TABLE', 'InnoDB', '', 1, null, null]]
  const column = (name: string, def: string | null, extra = '') => [
    name,
    'varchar(10)',
    'YES',
    def,
    extra,
    '',
    null,
    '',
    null,
  ]
  const describe1 = async (cols: unknown[][], create: unknown[][], mariadb: boolean | null = null) => {
    const adapter = new MysqlAdapter(config)
    ;(adapter as unknown as { mariadb: boolean | null }).mariadb = mariadb
    const s = scripted([
      [/SELECT TABLE_TYPE, ENGINE/, rows(info)],
      [/FROM information_schema\.COLUMNS/, rows(cols)],
      [/CHECK_CONSTRAINTS/, rows([])],
      [/information_schema\.STATISTICS/, rows([])],
      [/k\.TABLE_NAME = \?/, rows([])],
      [/WHERE REFERENCED_TABLE_SCHEMA/, rows([])],
      [/SHOW CREATE TABLE/, rows(create)],
    ])
    ;(adapter as unknown as { withConn: (n: unknown, fn: (c: Conn) => unknown) => unknown }).withConn = async (
      _ns,
      fn
    ) => await fn(s.conn)
    return { table: await adapter.describeTable(ns, 't'), asked: s.asked }
  }

  it('recovers the characters outside the BMP from the hex literal SHOW CREATE TABLE prints', async () => {
    const create = [['t', 'CREATE TABLE `t` (\n  `a` varchar(10) DEFAULT 0xF09F98803F,\n  `b` int\n)']]
    const { table, asked } = await describe1([column('a', '??')], create)
    expect(table.columns[0]).toMatchObject({ default: '0xF09F98803F', defaultIsExpression: true })
    expect(asked.find((q) => /SHOW CREATE TABLE/.test(q.text))?.text).toBe('SHOW CREATE TABLE `db`.`t`')
  })

  it('leaves a question mark the user really typed, and asks nothing when no default has one', async () => {
    const real = [['t', "CREATE TABLE `t` (\n  `a` varchar(10) DEFAULT '?'\n)"]]
    expect((await describe1([column('a', '?')], real)).table.columns[0]).toMatchObject({
      default: '?',
      defaultIsExpression: false,
    })
    const none = await describe1([column('a', 'abc'), column('b', null)], real)
    expect(none.asked.some((q) => /SHOW CREATE TABLE/.test(q.text))).toBe(false)
    const expression = await describe1([column('a', 'concat(?)', 'DEFAULT_GENERATED')], real)
    expect(expression.asked.some((q) => /SHOW CREATE TABLE/.test(q.text))).toBe(false)
  })

  it('does not ask MariaDB, which prints a question mark there too, and asks for MySQL and an unknown server', async () => {
    const create = [['t', 'CREATE TABLE `t` (\n  `a` varchar(10) DEFAULT 0xAA\n)']]
    const maria = await describe1([column('a', "'?'")], create, true)
    expect(maria.asked.some((q) => /SHOW CREATE TABLE/.test(q.text))).toBe(false)
    expect((await describe1([column('a', '?')], create, false)).table.columns[0]?.default).toBe('0xAA')
    expect((await describe1([column('a', '?')], create, null)).table.columns[0]?.default).toBe('0xAA')
  })

  it("finds the column's line by its exact name, quotes and regular-expression characters included", async () => {
    const create = [
      [
        't',
        'CREATE TABLE `t` (\n  `a.b` varchar(10) DEFAULT 0x01,\n  `a-b` varchar(10) DEFAULT 0x02,\n  `we``ird` varchar(10) DEFAULT 0x03,\n  `x` varchar(10) DEFAULT 0x04\n)',
      ],
    ]
    const { table } = await describe1([column('a.b', '?'), column('we`ird', '?'), column('x', '?')], create)
    expect(table.columns.map((c) => c.default)).toEqual(['0x01', '0x03', '0x04'])
    const only = await describe1(
      [column('a.b', '?')],
      [['t', 'CREATE TABLE `t` (\n  `aXb` varchar(10) DEFAULT 0xFF\n)']]
    )
    expect(only.table.columns[0]).toMatchObject({ default: '?', defaultIsExpression: false })
  })

  it('leaves the default as reported when the statement has no row, no such line or no hex literal', async () => {
    expect((await describe1([column('a', '?')], [])).table.columns[0]?.default).toBe('?')
    expect((await describe1([column('a', '?')], [['t', null]])).table.columns[0]?.default).toBe('?')
    expect(
      (await describe1([column('a', '?')], [['t', 'CREATE TABLE `t` (\n  `other` int DEFAULT 0x01\n)']])).table
        .columns[0]?.default
    ).toBe('?')
    expect(
      (await describe1([column('a', '?')], [['t', 'CREATE TABLE `t` (\n  `a` int DEFAULT 5\n)']])).table.columns[0]
        ?.default
    ).toBe('?')
    expect(
      (await describe1([column('a', '?')], [['t', 'CREATE TABLE `t` (\n  `a` int DEFAULT 0xZZ\n)']])).table.columns[0]
        ?.default
    ).toBe('?')
  })

  it('knows the server namespace to ask server-wide questions in', () => {
    expect(new MysqlAdapter(config).serverNamespace).toEqual({ database: 'information_schema' })
  })
})
