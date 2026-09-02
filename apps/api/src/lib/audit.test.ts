import { ADAPTER_METHOD_NAMES, AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { AUDITED_METHODS, PASSTHROUGH_METHODS, SQL_SUMMARY_MAX, summarise, withAudit } from './audit.ts'
import { createLogger } from './logging.ts'
import { withRequestContext } from './request-context.ts'

const who = { dialect: 'mysql' as const, host: 'db', port: 3306, user: 'root' }
const ns = { database: 'shop' }

function setup() {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
  const inner = new FakeAdapter({
    databases: { shop: { tables: { users: fakeTable('users', ['id', 'name'], [{ id: 1, name: 'A' }]) } } },
  })
  return { lines, inner, adapter: withAudit(inner, who, logger) }
}

describe('audit spec consistency', () => {
  it('classifies every DatabaseAdapter method as audited or pass-through', () => {
    expect([...AUDITED_METHODS, ...PASSTHROUGH_METHODS].sort()).toEqual([...ADAPTER_METHOD_NAMES].sort())
  })
})

describe('withAudit', () => {
  it('logs mutating calls with identity, request id and a value-free summary', async () => {
    const { lines, adapter } = setup()
    await withRequestContext({ requestId: 'req-1', redact: [] }, () =>
      adapter.updateRow(ns, 'users', { kind: 'pk', values: { id: 1 } }, { name: 'secret-value' })
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: 'audit',
      action: 'updateRow',
      requestId: 'req-1',
      dbUser: 'root',
      dbHost: 'db:3306',
      database: 'shop',
      table: 'users',
      key: 'pk(id)',
      columns: ['name'],
      ok: true,
    })
    expect(JSON.stringify(lines[0])).not.toContain('secret-value')
  })

  it('does not log read-only calls and keeps their behaviour', async () => {
    const { lines, adapter, inner } = setup()
    expect(await adapter.listDatabases()).toMatchObject([{ name: 'shop' }])
    expect((await adapter.browseRows(ns, 'users', { offset: 0, limit: 10, sort: [], filters: [] })).total).toBe(1)
    expect(lines).toHaveLength(0)
    expect(inner.calls.map((c) => c.method)).toEqual(['listDatabases', 'browseRows'])
  })

  it('truncates SQL, counts statements/errors and scrubs redacted secrets', async () => {
    const { lines, adapter } = setup()
    const long = `SELECT '${'x'.repeat(SQL_SUMMARY_MAX)}'`
    await adapter.executeSql(ns, long, { maxRows: 1, timeoutMs: 1000, stopOnError: true })
    expect(String(lines[0]?.sql).length).toBeLessThanOrEqual(SQL_SUMMARY_MAX + 1)
    expect(lines[0]).toMatchObject({ sqlLength: long.length, statements: 1, errors: 0 })
    await withRequestContext({ requestId: 'r', redact: ['hunter2'] }, () =>
      adapter.executeSql(ns, "ALTER USER 'a'@'%' IDENTIFIED BY 'hunter2'", {
        maxRows: 1,
        timeoutMs: 1000,
        stopOnError: true,
      })
    )
    expect(JSON.stringify(lines[1])).not.toContain('hunter2')
    expect(lines[1]?.sql).toContain('****')
  })

  it('redacts passwords containing quotes, E-strings and dollar quoting', async () => {
    const { lines, adapter } = setup()
    const script = [
      "CREATE USER 'u'@'%' IDENTIFIED BY 'ab''cd-secret'",
      "CREATE ROLE r PASSWORD E'x\\'y-secret'",
      'ALTER ROLE r PASSWORD $$dollar-secret$$',
      'ALTER ROLE r PASSWORD $q$tagged-secret$q$',
      'SET PASSWORD = "dq""secret"',
    ].join(';\n')
    await adapter.executeSql(ns, script, { maxRows: 1, timeoutMs: 1000, stopOnError: true })
    const logged = String(lines[0]?.sql)
    for (const secret of ['cd-secret', 'y-secret', 'dollar-secret', 'tagged-secret', 'dq', 'secret"']) {
      expect(logged).not.toContain(secret)
    }
    expect(logged.match(/\*\*\*\*/g)).toHaveLength(5)
  })

  it('redacts password literals typed directly into SQL (no request context needed)', async () => {
    const { lines, adapter } = setup()
    const script = [
      "CREATE USER 'app'@'%' IDENTIFIED BY 'Sup3r!'",
      "ALTER USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY \"Qu0te\"",
      "CREATE ROLE r LOGIN PASSWORD 'pgpass'",
      "SET PASSWORD FOR 'x'@'%' = 'legacy'",
      "SELECT PASSWORD('fn')",
      "SELECT * FROM t WHERE note = 'password is fine here'",
      "ALTER USER 'a'@'%' IDENTIFIED BY 'newpw1' REPLACE 'currentpw'",
      "SET PASSWORD = 'newpw2' REPLACE 'currentpw2'",
      "CREATE USER 'h'@'%' IDENTIFIED WITH mysql_native_password AS '*HASHVALUE'",
      "REPLACE INTO t (a) VALUES ('kept')",
    ].join(';\n')
    await adapter.executeSql(ns, script, { maxRows: 1, timeoutMs: 1000, stopOnError: true })
    const logged = String(lines[0]?.sql)
    for (const secret of ['Sup3r!', 'Qu0te', 'pgpass', 'legacy', "'fn'", 'currentpw', 'newpw', '*HASHVALUE'])
      expect(logged).not.toContain(secret)
    expect(logged).toContain("REPLACE INTO t (a) VALUES ('kept')")
    expect(logged).toContain("IDENTIFIED BY '****'")
    expect(logged).toContain("PASSWORD '****'")
    expect(logged).toContain("note = 'password is fine here'")
  })

  it('logs failures with ok=false and rethrows', async () => {
    const { lines, adapter } = setup()
    await expect(adapter.deleteRows(ns, 'users', [{ kind: 'pk', values: { id: 99 } }])).rejects.toBeInstanceOf(
      AdapterError
    )
    expect(lines[0]).toMatchObject({ action: 'deleteRows', rows: 1, key: 'pk(id)', ok: false, error: 'KEY_MISMATCH' })
    // The server's message would quote the offending value; only the error class reaches the log.
    expect(JSON.stringify(lines[0])).not.toContain('matched 0 rows')
  })

  it('logs a failed insert by error code, never by the message that quotes the value', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
    const inner = {
      ...new FakeAdapter({ databases: { shop: { tables: {} } } }),
      insertRow: () =>
        Promise.reject(
          new AdapterError('QUERY_FAILED', "ER_DUP_ENTRY: Duplicate entry 'alice@example.com'", undefined, {
            nativeCode: 'ER_DUP_ENTRY',
          })
        ),
    } as unknown as FakeAdapter
    const adapter = withAudit(inner, who, logger)
    await expect(adapter.insertRow(ns, 'users', { email: 'alice@example.com' })).rejects.toBeInstanceOf(AdapterError)
    expect(lines[0]).toMatchObject({
      action: 'insertRow',
      ok: false,
      error: 'QUERY_FAILED',
      nativeCode: 'ER_DUP_ENTRY',
    })
    expect(JSON.stringify(lines[0])).not.toContain('alice')
  })

  it('summarises every audited method without values', () => {
    expect(summarise('insertRow', [ns, 't', { a: 1, b: 'v' }])).toEqual({
      database: 'shop',
      table: 't',
      rows: 1,
      columns: ['a', 'b'],
    })
    expect(summarise('insertRows', [ns, 't', ['a'], [[1], [2]]])).toEqual({
      database: 'shop',
      table: 't',
      rows: 2,
      columns: ['a'],
    })
    expect(summarise('killProcess', ['42'])).toEqual({ processId: '42' })
    expect(summarise('deleteRows', [{ database: 'd', schema: 's' }, 't', [{ kind: 'ctid', value: '(0,1)' }]])).toEqual({
      database: 'd',
      schema: 's',
      table: 't',
      rows: 1,
      key: 'ctid',
    })
  })
})
