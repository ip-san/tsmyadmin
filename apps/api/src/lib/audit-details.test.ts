import { AdapterError, type DatabaseAdapter } from '@tsmyadmin/adapter'
import { PASSWORD_MASK, type RowKey } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { SQL_SUMMARY_MAX, summarise, withAudit } from './audit.ts'
import { createLogger } from './logging.ts'
import { withRequestContext } from './request-context.ts'

/**
 * The value-free summary of each audited call, the outcome and failure lines, and what is scrubbed from them. The
 * audit line is where an operator's password could leak, so each of these is a place a leak or a wrong line would hide
 * (found as surviving mutants; see `bun run mutation`).
 */

const who = { dialect: 'postgres' as const, host: 'db', port: 5432, user: 'admin' }
const ns = { database: 'shop', schema: 'app' }

function wrap(methods: Record<string, unknown>) {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
  return { lines, adapter: withAudit(methods as unknown as DatabaseAdapter, who, logger) }
}

describe('summarise: what each audited call says about itself', () => {
  it('names the database and, when there is one, the schema, and nothing about the values', () => {
    expect(summarise('insertRow', [ns, 't', { a: 1, b: 'secret' }])).toEqual({
      database: 'shop',
      schema: 'app',
      table: 't',
      rows: 1,
      columns: ['a', 'b'],
    })
    expect(summarise('insertRow', [{ database: 'shop' }, 't', undefined])).toEqual({
      database: 'shop',
      table: 't',
      rows: 1,
      columns: [],
    })
    expect(summarise('insertRow', [{ database: 'shop', schema: '' }, 't', {}])).toEqual({
      database: 'shop',
      table: 't',
      rows: 1,
      columns: [],
    })
    expect(summarise('cancelQuery', [])).toEqual({ queryId: undefined })
  })

  it('counts the rows of a batch when it is a list, and leaves the count to the outcome when it is a stream', () => {
    expect(
      summarise('insertRows', [
        ns,
        't',
        ['a', 'b'],
        [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      ])
    ).toEqual({ database: 'shop', schema: 'app', table: 't', rows: 3, columns: ['a', 'b'] })
    expect(summarise('insertRows', [ns, 't', ['a'], []])).toMatchObject({ rows: 0 })
    function* stream() {
      yield [1]
    }
    expect(summarise('insertRows', [ns, 't', ['a'], stream()])).toEqual({
      database: 'shop',
      schema: 'app',
      table: 't',
      columns: ['a'],
    })
  })

  it('describes a key by its kind and column names, a ctid by its kind alone', () => {
    const update = (key: RowKey) => summarise('updateRow', [ns, 't', key, { x: 1, y: 2 }])
    expect(update({ kind: 'pk', values: { id: 1, k: 'v' } })).toMatchObject({ key: 'pk(id,k)', columns: ['x', 'y'] })
    expect(update({ kind: 'all-columns', values: { a: 1, b: 2 } })).toMatchObject({ key: 'all-columns(a,b)' })
    expect(update({ kind: 'ctid', value: '(0,1)' })).toMatchObject({ key: 'ctid' })
    expect(summarise('updateRow', [ns, 't', { kind: 'pk', values: { id: 1 } }, undefined])).toMatchObject({
      columns: [],
    })
  })

  it('counts the rows of a delete and describes the first key, with no key for none', () => {
    const keys: RowKey[] = [
      { kind: 'pk', values: { id: 1 } },
      { kind: 'pk', values: { id: 2 } },
    ]
    expect(summarise('deleteRows', [ns, 't', keys])).toEqual({
      database: 'shop',
      schema: 'app',
      table: 't',
      rows: 2,
      key: 'pk(id)',
    })
    expect(summarise('deleteRows', [ns, 't', []])).toEqual({
      database: 'shop',
      schema: 'app',
      table: 't',
      rows: 0,
      key: undefined,
    })
    expect(summarise('deleteRows', [ns, 't'])).toEqual({
      database: 'shop',
      schema: 'app',
      table: 't',
      rows: 0,
      key: undefined,
    })
  })

  it('describes a cancel and a kill by the id, and a kill by whether it ended a statement or a session', () => {
    expect(summarise('cancelQuery', ['q1'])).toEqual({ queryId: 'q1' })
    expect(summarise('killProcess', [42])).toEqual({ processId: 42, killMode: 'connection' })
    expect(summarise('killProcess', [42, 'query'])).toEqual({ processId: 42, killMode: 'query' })
  })

  it('logs the statement cut at the limit with an ellipsis, and its whole length', () => {
    const run = (sql: string) => summarise('executeSql', [ns, sql, undefined]) as { sql: string; sqlLength: number }
    const exact = `SELECT ${'1'.repeat(SQL_SUMMARY_MAX - 7)}`
    expect(exact).toHaveLength(SQL_SUMMARY_MAX)
    expect(run(exact)).toEqual({ database: 'shop', schema: 'app', sql: exact, sqlLength: SQL_SUMMARY_MAX })
    const over = `${exact}1`
    expect(run(over).sql).toBe(`${exact}…`)
    expect(run(over).sqlLength).toBe(SQL_SUMMARY_MAX + 1)
    expect(run('').sql).toBe('')
    expect(summarise('executeSql', [ns, undefined, undefined])).toMatchObject({ sql: '', sqlLength: 0 })
  })

  it('logs an upload by its label and size alone, never its text', () => {
    expect(summarise('executeSql', [ns, "INSERT INTO t VALUES ('secret')", { auditLabel: 'import:csv' }])).toEqual({
      database: 'shop',
      schema: 'app',
      sql: '<import:csv>',
      sqlLength: 31,
    })
  })

  it('joins the statements it keeps with a semicolon and a line break', () => {
    expect((summarise('executeSql', [ns, 'SELECT 1; SELECT 2', undefined]) as { sql: string }).sql).toBe(
      'SELECT 1;\nSELECT 2'
    )
  })

  it('reads the statement the way the dialect says, PostgreSQL by default', () => {
    // `#` starts a comment in MySQL and is an operator in PostgreSQL: what follows it is code only in the latter.
    const sql = "SELECT 1 # IDENTIFIED BY 'secret'"
    const pg = (summarise('executeSql', [ns, sql, undefined]) as { sql: string }).sql
    const my = (summarise('executeSql', [ns, sql, undefined], 'mysql') as { sql: string }).sql
    expect(my).toBe('SELECT 1')
    expect(pg).toBe(`SELECT 1 # IDENTIFIED BY '${PASSWORD_MASK}'`)
    expect(pg).toBe((summarise('executeSql', [ns, sql, undefined], 'postgres') as { sql: string }).sql)
  })
})

describe('redacting the statement', () => {
  const logged = (sql: string) => (summarise('executeSql', [ns, sql, undefined], 'mysql') as { sql: string }).sql

  it('masks the password of an account statement and the one in a connection string', () => {
    expect(logged("ALTER USER u IDENTIFIED BY 'hunter2'")).toBe(`ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}'`)
    const conn = logged("CREATE SUBSCRIPTION s CONNECTION 'host=h password=hunter2 dbname=d' PUBLICATION p")
    expect(conn).not.toContain('hunter2')
    expect(conn).toContain(PASSWORD_MASK)
    expect(logged('x password=hunter2 y')).toBe(`x password=${PASSWORD_MASK} y`)
  })

  it('masks from the first quote on when the literal never closes, so no fragment is left', () => {
    const open = logged("ALTER USER u IDENTIFIED BY 'unterminated secret")
    expect(open).not.toContain('unterminated')
    expect(open).not.toContain('secret')
    expect(open).toContain(PASSWORD_MASK)
    expect(logged('ALTER USER u IDENTIFIED BY "dq unterminated')).not.toContain('unterminated')
    expect(logged("ALTER USER u IDENTIFIED BY 'a b' WITH GRANT OPTION")).toBe(
      `ALTER USER u IDENTIFIED BY '${PASSWORD_MASK}' WITH GRANT OPTION`
    )
  })
})

describe('a dollar-quoted password that is never closed', () => {
  // A statement with the closing tag forgotten fails to run, but its line is still written: nothing after the opening
  // tag may reach it.
  const logged = (sql: string, dialect: 'postgres' | 'mysql') =>
    (summarise('executeSql', [ns, sql, undefined], dialect) as { sql: string }).sql

  it.each(['postgres', 'mysql'] as const)('masks everything after the opening tag (%s)', (dialect) => {
    for (const sql of [
      'ALTER ROLE u PASSWORD $$hunter2',
      'ALTER ROLE u PASSWORD $$hunter2 more words',
      'ALTER ROLE u PASSWORD $tag$hunter2 more',
      'ALTER ROLE u PASSWORD $tag$hunter2 $other$ more',
    ]) {
      const out = logged(sql, dialect)
      expect(out, sql).not.toContain('hunter2')
      expect(out, sql).not.toContain('more')
      expect(out, sql).toBe(`ALTER ROLE u PASSWORD '${PASSWORD_MASK}'`)
    }
  })

  it.each(['postgres', 'mysql'] as const)(
    'still masks a closed one whole, and keeps what follows it (%s)',
    (dialect) => {
      expect(logged('ALTER ROLE u PASSWORD $$hunter2$$', dialect)).toBe(`ALTER ROLE u PASSWORD '${PASSWORD_MASK}'`)
      expect(logged('ALTER ROLE u PASSWORD $tag$hunter2$tag$ VALID UNTIL x', dialect)).toBe(
        `ALTER ROLE u PASSWORD '${PASSWORD_MASK}' VALID UNTIL x`
      )
      expect(logged('ALTER ROLE u PASSWORD $1', dialect)).toBe(`ALTER ROLE u PASSWORD '${PASSWORD_MASK}'`)
    }
  )
})

describe('withAudit', () => {
  it('passes a read-only method through bound to the adapter, and any other property as it is', async () => {
    const adapter = {
      dialect: 'postgres',
      note: 'plain',
      who() {
        return (this as { dialect: string }).dialect
      },
    }
    const { adapter: wrapped, lines } = wrap(adapter)
    expect((wrapped as unknown as { note: string }).note).toBe('plain')
    expect((wrapped as unknown as { who: () => string }).who()).toBe('postgres')
    expect(lines).toHaveLength(0)
    const { adapter: other } = wrap({ updateRow: 'not a function' })
    expect((other as unknown as { updateRow: string }).updateRow).toBe('not a function')
    expect(Reflect.get(other as object, Symbol.iterator)).toBeUndefined()
  })

  it('writes the outcome of a script: the statements run and how many failed', async () => {
    const { adapter, lines } = wrap({
      executeSql: async () => [{ kind: 'rows' }, { kind: 'error' }, null, { kind: 'error' }, { kind: 'affected' }],
    })
    await adapter.executeSql(ns, 'SELECT 1', {} as never)
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'audit',
      ok: true,
      statements: 5,
      errors: 2,
      action: 'executeSql',
    })
    const { adapter: plain, lines: more } = wrap({ executeSql: async () => 'not a list' })
    await plain.executeSql(ns, 'SELECT 1', {} as never)
    expect(more[0]).not.toHaveProperty('statements')
  })

  it('writes the rows an insert affected, for a bulk insert only', async () => {
    const result = { affectedRows: 7 }
    const bulk = wrap({ insertRows: async () => result, insertRow: async () => result })
    await bulk.adapter.insertRows(ns, 't', ['a'], [[1]])
    await bulk.adapter.insertRow(ns, 't', { a: 1 })
    expect(bulk.lines[0]).toMatchObject({ action: 'insertRows', rows: 7, ok: true })
    expect(bulk.lines[1]).toMatchObject({ action: 'insertRow', rows: 1 })
    expect(bulk.lines[1]).not.toHaveProperty('affectedRows')
    for (const odd of [null, undefined, 5, 'x', {}]) {
      const w = wrap({ insertRows: async () => odd })
      await w.adapter.insertRows(ns, 't', ['a'], [[1]])
      expect(w.lines[0]?.rows, String(odd)).toBe(1)
    }
  })

  it('writes the time the call took, as whole milliseconds that are not negative', async () => {
    const { adapter, lines } = wrap({ killProcess: async () => undefined })
    await adapter.killProcess('5')
    const ms = lines[0]?.ms as number
    expect(Number.isInteger(ms)).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(ms).toBeLessThan(5000)
  })

  it('writes a failure as a warning with the error class alone, and throws it again', async () => {
    const boom = new AdapterError('QUERY_FAILED', "Duplicate entry 'secret'", 'detail', { nativeCode: 'ER_DUP_ENTRY' })
    const { adapter, lines } = wrap({ updateRow: async () => Promise.reject(boom) })
    await expect(adapter.updateRow(ns, 't', { kind: 'pk', values: { id: 1 } }, { a: 1 })).rejects.toBe(boom)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'audit',
      ok: false,
      error: 'QUERY_FAILED',
      nativeCode: 'ER_DUP_ENTRY',
      action: 'updateRow',
    })
    expect(JSON.stringify(lines[0])).not.toContain('secret')
    expect(Number.isInteger(lines[0]?.ms)).toBe(true)
    expect(lines[0]?.ms as number).toBeGreaterThanOrEqual(0)
  })

  it('names a failure that is not an adapter error by its class, or by Error, and has no native code', async () => {
    const cases: [unknown, string][] = [
      [new TypeError('x'), 'TypeError'],
      [new Error('x'), 'Error'],
      ['a string', 'Error'],
      [null, 'Error'],
    ]
    for (const [thrown, name] of cases) {
      const { adapter, lines } = wrap({ killProcess: async () => Promise.reject(thrown) })
      await expect(adapter.killProcess('1')).rejects.toBe(thrown)
      expect(lines[0], name).toMatchObject({ ok: false, error: name })
      expect(lines[0], name).not.toHaveProperty('nativeCode')
    }
    const noNative = wrap({ killProcess: async () => Promise.reject(new AdapterError('QUERY_FAILED', 'm')) })
    await expect(noNative.adapter.killProcess('1')).rejects.toThrow()
    expect(noNative.lines[0]).not.toHaveProperty('nativeCode')
  })

  it('scrubs the secrets registered for the request from every text field of the line, and leaves the others', async () => {
    const { adapter, lines } = wrap({ executeSql: async () => [] })
    await withRequestContext({ requestId: 'r1', redact: ['hunter2', 'second'] }, () =>
      adapter.executeSql({ database: 'db-hunter2', schema: 'second' }, 'SELECT 1', {} as never)
    )
    expect(lines[0]).toMatchObject({
      requestId: 'r1',
      database: `db-${PASSWORD_MASK}`,
      schema: PASSWORD_MASK,
      sqlLength: 8,
    })
    expect(typeof lines[0]?.sqlLength).toBe('number')
    const { adapter: none, lines: untouched } = wrap({ executeSql: async () => [] })
    await withRequestContext({ requestId: 'r2', redact: [] }, () =>
      none.executeSql({ database: 'hunter2' }, 'SELECT 1', {} as never)
    )
    expect(untouched[0]).toMatchObject({ database: 'hunter2' })
  })

  it('logs without a request when there is none, and a secret list that is not there scrubs nothing', async () => {
    const { adapter, lines } = wrap({ killProcess: async () => undefined })
    await adapter.killProcess('3')
    expect(lines[0]).toMatchObject({ action: 'killProcess', processId: '3', ok: true })
    expect(lines[0]?.requestId).toBeUndefined()
  })
})
