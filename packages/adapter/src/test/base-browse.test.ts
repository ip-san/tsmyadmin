import { BROWSE_ALL_MAX, DISTINCT_VALUES_LIMIT, EXACT_COUNT_MAX_ROWS } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { countMode } from '../base.ts'
import type { Conn } from '../driver.ts'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'
import { rows, scripted } from './scripted-conn.ts'

/**
 * The reads behind the browse page: the distinct values of a column, the table search, and the page of rows with its
 * count and the statement shown to the user. Both dialects, with the table's description supplied and the connection
 * scripted.
 */

const ns = { database: 'd', schema: 'sales' }
type Dialect = 'mysql' | 'postgres'
type Rule = [RegExp, ReturnType<typeof rows> | Error]
type Table = {
  columns: [string, string][]
  primaryKey?: string[]
  rowEstimate?: number | null
  foreignKeys?: unknown[]
  referencedBy?: unknown[]
}

const adapterFor = (dialect: Dialect, table: Table, script: Rule[] = []) => {
  const cfg = { dialect, host: 'h', port: 1, user: 'u', password: 'p' } as const
  const adapter = dialect === 'mysql' ? new MysqlAdapter(cfg) : new PostgresAdapter(cfg)
  const s = scripted(script)
  ;(adapter as unknown as { withConn: unknown }).withConn = async (_n: unknown, fn: (c: Conn) => unknown) =>
    await fn(s.conn)
  ;(adapter as unknown as { describeTable: unknown }).describeTable = async () => ({
    kind: 'table',
    columns: table.columns.map(([name, dataType]) => ({ name, dataType, nullable: false })),
    primaryKey: table.primaryKey ?? [],
    indexes: [],
    rowEstimate: table.rowEstimate ?? null,
    foreignKeys: table.foreignKeys ?? [],
    referencedBy: table.referencedBy ?? [],
    partitioned: false,
    hasChildren: false,
  })
  return { adapter, asked: s.asked }
}
const T: Table = {
  columns: [
    ['id', 'integer'],
    ['name', 'varchar(20)'],
    ['note', 'text'],
  ],
  primaryKey: ['id'],
}

describe('countMode', () => {
  it('counts exactly up to the threshold and estimates above it, and counts exactly when there is no estimate', () => {
    expect(countMode(null)).toBe('exact')
    expect(countMode(0)).toBe('exact')
    expect(countMode(EXACT_COUNT_MAX_ROWS)).toBe('exact')
    expect(countMode(EXACT_COUNT_MAX_ROWS + 1)).toBe('estimate')
    expect(countMode(50, 10)).toBe('estimate')
    expect(countMode(10, 10)).toBe('exact')
  })
})

describe('distinctValues', () => {
  it('lists the values of a column with how often each occurs, most frequent first, one past the limit asked for', async () => {
    const m = adapterFor('mysql', T, [
      [
        /GROUP BY/,
        rows([
          ['a', 5],
          [null, '2'],
        ]),
      ],
    ])
    expect(await m.adapter.distinctValues(ns, 't', 'name')).toEqual({
      values: [
        { value: 'a', count: 5 },
        { value: null, count: 2 },
      ],
      truncated: false,
    })
    expect(m.asked[0]).toEqual({
      text: 'SELECT `name`, COUNT(*) AS n FROM `d`.`t` GROUP BY `name` ORDER BY n DESC, `name` LIMIT ?',
      params: [DISTINCT_VALUES_LIMIT + 1],
    })
    const p = adapterFor('postgres', T, [[/GROUP BY/, rows([])]])
    await p.adapter.distinctValues(ns, 't', 'name')
    expect(p.asked[0]?.text).toContain('LIMIT $1')
  })

  it("keeps the limit's worth of values and says there were more when one extra came back", async () => {
    const many = Array.from({ length: DISTINCT_VALUES_LIMIT + 1 }, (_, i) => [`v${i}`, 1])
    const out = await adapterFor('mysql', T, [[/GROUP BY/, rows(many)]]).adapter.distinctValues(ns, 't', 'name')
    expect(out.values).toHaveLength(DISTINCT_VALUES_LIMIT)
    expect(out.truncated).toBe(true)
    const exact = await adapterFor('mysql', T, [
      [/GROUP BY/, rows(many.slice(0, DISTINCT_VALUES_LIMIT))],
    ]).adapter.distinctValues(ns, 't', 'name')
    expect(exact.truncated).toBe(false)
  })

  it('refuses a column the table does not have, before asking the server anything', async () => {
    const m = adapterFor('mysql', T)
    await expect(m.adapter.distinctValues(ns, 't', 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Unknown column: nope',
    })
    expect(m.asked).toHaveLength(0)
  })
})

describe('searchTable', () => {
  const count = (n: unknown): Rule[] => [[/COUNT/, rows([[n]])]]

  it('looks in every column that has a readable text form for the term as a phrase, case-insensitively', async () => {
    const m = adapterFor('mysql', T, count(3))
    const out = await m.adapter.searchTable(ns, 't', 'a_b')
    expect(out).toMatchObject({ total: 3, count: 'exact', columns: ['id', 'name', 'note'] })
    expect(m.asked[0]?.text).toBe(
      "SELECT COUNT(*) FROM (SELECT 1 FROM `d`.`t` WHERE (CAST(`id` AS CHAR) LIKE ? ESCAPE '!' OR CAST(`name` AS CHAR) LIKE ? ESCAPE '!' OR CAST(`note` AS CHAR) LIKE ? ESCAPE '!') LIMIT ?) AS tsmyadmin_search"
    )
    expect(m.asked[0]?.params).toEqual(['%a!_b%', '%a!_b%', '%a!_b%', EXACT_COUNT_MAX_ROWS + 1])
    const p = adapterFor('postgres', T, count(1))
    await p.adapter.searchTable(ns, 't', 'x')
    expect(p.asked[0]?.text).toContain(`"id"::text ILIKE $1 ESCAPE '!' OR "name"::text ILIKE $2`)
  })

  it('writes the same search with the term in as a literal, for the SQL tab, and as a DELETE', async () => {
    const out = await adapterFor('mysql', T, count(0)).adapter.searchTable(ns, 't', "it's 100%")
    expect(out.sql).toBe(
      "SELECT * FROM `d`.`t` WHERE (CAST(`id` AS CHAR) LIKE '%it''s 100!%%' ESCAPE '!' OR CAST(`name` AS CHAR) LIKE '%it''s 100!%%' ESCAPE '!' OR CAST(`note` AS CHAR) LIKE '%it''s 100!%%' ESCAPE '!')"
    )
    expect(out.deleteSql).toBe(out.sql.replace('SELECT * FROM', 'DELETE FROM'))
  })

  it('splits the term into words for any and all, joining the words with OR and AND', async () => {
    const any = adapterFor('mysql', { columns: [['a', 'varchar(5)']] }, count(1))
    await any.adapter.searchTable(ns, 't', '  red   blue ', { mode: 'any' })
    expect(any.asked[0]?.text).toContain(
      "(CAST(`a` AS CHAR) LIKE ? ESCAPE '!') OR (CAST(`a` AS CHAR) LIKE ? ESCAPE '!')"
    )
    expect(any.asked[0]?.params).toEqual(['%red%', '%blue%', EXACT_COUNT_MAX_ROWS + 1])
    const all = adapterFor('mysql', { columns: [['a', 'varchar(5)']] }, count(1))
    await all.adapter.searchTable(ns, 't', 'red blue', { mode: 'all' })
    expect(all.asked[0]?.text).toContain("ESCAPE '!') AND (CAST(")
    const phrase = adapterFor('mysql', { columns: [['a', 'varchar(5)']] }, count(1))
    await phrase.adapter.searchTable(ns, 't', 'red blue')
    expect(phrase.asked[0]?.params).toEqual(['%red blue%', EXACT_COUNT_MAX_ROWS + 1])
  })

  it("hands the term to the server's own regular expression operator in regexp mode, unescaped", async () => {
    const m = adapterFor('mysql', { columns: [['a', 'varchar(5)']] }, count(1))
    await m.adapter.searchTable(ns, 't', 'a.*b', { mode: 'regexp' })
    expect(m.asked[0]?.text).toContain('CAST(`a` AS CHAR) REGEXP ?')
    expect(m.asked[0]?.params?.[0]).toBe('a.*b')
    const p = adapterFor('postgres', { columns: [['a', 'varchar(5)']] }, count(1))
    await p.adapter.searchTable(ns, 't', 'a.*b', { mode: 'regexp' })
    expect(p.asked[0]?.text).toContain('"a"::text ~* $1')
  })

  it('narrows to columns whose name holds the text, ignoring case and surrounding spaces, and skips the unreadable types', async () => {
    const table: Table = {
      columns: [
        ['Name', 'varchar(5)'],
        ['nickname', 'varchar(5)'],
        ['id', 'int'],
        ['blob', 'bytea'],
      ],
    }
    const named = await adapterFor('postgres', table, count(0)).adapter.searchTable(ns, 't', 'x', { column: '  NAME ' })
    expect(named.columns).toEqual(['Name', 'nickname'])
    const everything = await adapterFor('postgres', table, count(0)).adapter.searchTable(ns, 't', 'x')
    expect(everything.columns).toEqual(['Name', 'nickname', 'id'])
    const blank = await adapterFor('postgres', table, count(0)).adapter.searchTable(ns, 't', 'x', { column: '   ' })
    expect(blank.columns).toEqual(['Name', 'nickname', 'id'])
  })

  it('finds nothing, and asks nothing, when no column can be searched', async () => {
    const m = adapterFor('postgres', { columns: [['blob', 'bytea']] })
    expect(await m.adapter.searchTable(ns, 't', 'x')).toEqual({
      total: 0,
      count: 'exact',
      columns: [],
      sql: '',
      deleteSql: '',
    })
    expect(m.asked).toHaveLength(0)
    expect((await adapterFor('mysql', T).adapter.searchTable(ns, 't', 'x', { column: 'nope' })).columns).toEqual([])
  })

  it('counts up to the threshold and says "at least" above it, reading the count as a number or text', async () => {
    expect(await adapterFor('mysql', T, count(7)).adapter.searchTable(ns, 't', 'x')).toMatchObject({
      total: 7,
      count: 'exact',
    })
    expect(await adapterFor('mysql', T, count('9')).adapter.searchTable(ns, 't', 'x')).toMatchObject({
      total: 9,
      count: 'exact',
    })
    expect(await adapterFor('mysql', T, [[/COUNT/, rows([])]]).adapter.searchTable(ns, 't', 'x')).toMatchObject({
      total: 0,
    })
    expect(await adapterFor('mysql', T, count(EXACT_COUNT_MAX_ROWS)).adapter.searchTable(ns, 't', 'x')).toMatchObject({
      total: EXACT_COUNT_MAX_ROWS,
      count: 'exact',
    })
    expect(
      await adapterFor('mysql', T, count(EXACT_COUNT_MAX_ROWS + 1)).adapter.searchTable(ns, 't', 'x')
    ).toMatchObject({
      total: EXACT_COUNT_MAX_ROWS,
      count: 'lower_bound',
    })
  })
})

describe('browseRows', () => {
  const opts = (over: Record<string, unknown> = {}) =>
    ({ limit: 25, offset: 50, sort: [], filters: [], ...over }) as never
  const page = (data: unknown[][] = [[1, 'a', 'n']], total: unknown = 1): Rule[] => [
    [/^SELECT COUNT/, rows([[total]])],
    [/^SELECT /, rows(data, ['id', 'name', 'note'])],
  ]

  it('reads a page in key order with the limit and offset as parameters, and the count beside it', async () => {
    const m = adapterFor('mysql', T, page())
    const out = await m.adapter.browseRows(ns, 't', opts())
    expect(out).toMatchObject({
      rows: [[1, 'a', 'n']],
      truncated: false,
      total: 1,
      count: 'exact',
      keyKind: 'pk',
      keyColumns: ['id'],
    })
    expect(m.asked[0]).toEqual({
      text: 'SELECT `id`, `name`, `note` FROM `d`.`t` ORDER BY `id` LIMIT ? OFFSET ?',
      params: [25, 50],
    })
    expect(m.asked[1]?.text).toBe('SELECT COUNT(*) FROM (SELECT 1 FROM `d`.`t` LIMIT ?) AS tsmyadmin_count')
    expect(m.asked[1]?.params).toEqual([EXACT_COUNT_MAX_ROWS + 1])
    expect(out.statement.literal).toBe('SELECT `id`, `name`, `note` FROM `d`.`t` ORDER BY `id` LIMIT 25 OFFSET 50')
    expect(out.statement.params).toEqual([25, 50])
    expect(out.statement.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('orders by the sort asked for, instead of the key, and refuses a column the table does not have', async () => {
    const m = adapterFor('mysql', T, page())
    await m.adapter.browseRows(
      ns,
      't',
      opts({
        sort: [
          { column: 'name', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
      })
    )
    expect(m.asked[0]?.text).toContain('ORDER BY `name` DESC, `id` ASC LIMIT')
    await expect(
      m.adapter.browseRows(ns, 't', opts({ sort: [{ column: 'nope', direction: 'asc' }] }))
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Unknown column: nope' })
    await expect(
      m.adapter.browseRows(ns, 't', opts({ filters: [{ column: 'nope', op: 'eq', value: '1' }] }))
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Unknown column: nope' })
  })

  it('orders a table without a key by ctid on PostgreSQL while it is small, and not at all when it is large or on MySQL', async () => {
    const noKey: Table = { columns: [['a', 'integer']], rowEstimate: 10 }
    const p = adapterFor('postgres', noKey, page())
    await p.adapter.browseRows(ns, 't', opts())
    expect(p.asked[0]?.text).toContain('ORDER BY "sales"."t".ctid LIMIT')
    expect(p.asked[0]?.text).toContain('ctid::text AS "ctid"')
    const large = adapterFor('postgres', { ...noKey, rowEstimate: EXACT_COUNT_MAX_ROWS + 1 }, page())
    await large.adapter.browseRows(ns, 't', opts())
    expect(large.asked[0]?.text).not.toContain('ORDER BY')
    const m = adapterFor('mysql', noKey, page())
    await m.adapter.browseRows(ns, 't', opts())
    expect(m.asked[0]?.text).not.toContain('ORDER BY')
  })

  it('reads the whole table up to a ceiling, from the start, when the limit is 0', async () => {
    const m = adapterFor('mysql', T, page())
    const out = await m.adapter.browseRows(ns, 't', opts({ limit: 0, offset: 99 }))
    expect(m.asked[0]?.params).toEqual([BROWSE_ALL_MAX, 0])
    expect(out.statement.literal).toContain(`LIMIT ${BROWSE_ALL_MAX} OFFSET 0`)
  })

  it('counts under the same filter as the page', async () => {
    const m = adapterFor('mysql', T, page())
    await m.adapter.browseRows(ns, 't', opts({ filters: [{ column: 'name', op: 'eq', value: 'a' }] }))
    expect(m.asked[0]?.text).toContain('WHERE `name` = ? ORDER BY')
    expect(m.asked[1]?.text).toContain('FROM `d`.`t` WHERE `name` = ? LIMIT ?')
    expect(m.asked[1]?.params).toEqual(['a', EXACT_COUNT_MAX_ROWS + 1])
  })

  it("answers with the catalog's estimate, without counting, for a large table with no filter", async () => {
    const big: Table = { ...T, rowEstimate: EXACT_COUNT_MAX_ROWS + 1 }
    const m = adapterFor('mysql', big, page())
    const out = await m.adapter.browseRows(ns, 't', opts())
    expect(out).toMatchObject({ total: EXACT_COUNT_MAX_ROWS + 1, count: 'estimate', truncated: false })
    expect(m.asked.some((q) => q.text.startsWith('SELECT COUNT'))).toBe(false)
    const filtered = adapterFor('mysql', big, page())
    expect(
      await filtered.adapter.browseRows(ns, 't', opts({ filters: [{ column: 'name', op: 'eq', value: 'a' }] }))
    ).toMatchObject({ count: 'exact' })
  })

  it('counts exactly up to the threshold and says "at least" above it, and reads a count it cannot as unknown', async () => {
    const total = async (value: unknown) =>
      (await adapterFor('mysql', T, page([], value)).adapter.browseRows(ns, 't', opts())) as {
        total: number | null
        count: string
      }
    expect(await total(7)).toMatchObject({ total: 7, count: 'exact' })
    expect(await total('12')).toMatchObject({ total: 12, count: 'exact' })
    expect(await total(EXACT_COUNT_MAX_ROWS)).toMatchObject({ total: EXACT_COUNT_MAX_ROWS, count: 'exact' })
    expect(await total(EXACT_COUNT_MAX_ROWS + 1)).toMatchObject({ total: EXACT_COUNT_MAX_ROWS, count: 'lower_bound' })
    expect(await total('abc')).toMatchObject({ total: null, count: 'exact' })
    expect(await total(null)).toMatchObject({ total: null })
    expect(await total(0)).toMatchObject({ total: 0 })
  })

  it('hands back the foreign keys and the tables that refer to this one', async () => {
    const fk = [{ columns: ['id'], refTable: 'x' }]
    const by = [{ table: 'y' }]
    const out = await adapterFor('mysql', { ...T, foreignKeys: fk, referencedBy: by }, page()).adapter.browseRows(
      ns,
      't',
      opts()
    )
    expect(out).toMatchObject({ foreignKeys: fk, referencedBy: by })
  })

  it('times the stages of the page read only when asked, and leaves the profile out when there is none', async () => {
    const m = adapterFor('mysql', T, page())
    const stages = [{ state: 'starting', seconds: 0.1 }]
    let started = 0
    const internals = m.adapter as unknown as { startProfiling: unknown; readProfile: unknown }
    internals.startProfiling = async () => (++started, true)
    internals.readProfile = async () => stages
    expect(await m.adapter.browseRows(ns, 't', opts({ profile: true }))).toMatchObject({
      statement: { profile: stages },
    })
    expect(started).toBe(1)
    expect((await m.adapter.browseRows(ns, 't', opts())).statement).not.toHaveProperty('profile')
    expect(started).toBe(1)
    internals.readProfile = async () => []
    expect((await m.adapter.browseRows(ns, 't', opts({ profile: true }))).statement).not.toHaveProperty('profile')
    internals.readProfile = async () => Promise.reject(new Error('no'))
    expect((await m.adapter.browseRows(ns, 't', opts({ profile: true }))).statement).not.toHaveProperty('profile')
  })
})
