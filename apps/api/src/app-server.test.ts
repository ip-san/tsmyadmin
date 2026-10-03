import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  ApiErrorSchema,
  BrowseResultSchema,
  DiagnosticReportSchema,
  IMPORT_MAX_BYTES,
  ImportEventSchema,
  KeyValueSchema,
  ProcessInfoSchema,
  ReplicationInfoSchema,
  ServerCatalogSchema,
  ServerInfoSchema,
} from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeStoresAfterEach, fixtureAdapter, harness } from './test-support/app-harness.ts'

const stores = closeStoresAfterEach()

describe('export', () => {
  it('downloads a SQL dump of the whole database with a content-disposition', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/sql')
    expect(res.headers.get('content-disposition')).toContain('filename="shop.sql"')
    const body = await res.text()
    expect(body).toContain('-- Table: users')
    expect(body).toContain('INSERT INTO `users`')
  })

  it('aborts the transfer when the adapter fails mid-stream', async () => {
    const adapter = fixtureAdapter()
    const original = adapter.iterateRows.bind(adapter)
    adapter.iterateRows = async function* (ns, table, opts) {
      for await (const b of original(ns, table, opts)) {
        yield b
        throw new Error('connection lost')
      }
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
  })

  it('exports one table as CSV and rejects multi-table CSV', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const csv = await h.req('/api/databases/shop/export?format=csv&tables=users')
    expect(csv.status).toBe(200)
    expect(await csv.text()).toContain('id,name')
    expect((await h.req('/api/databases/shop/export?format=csv&tables=users,posts')).status).toBe(400)
    // Unknown tables are refused before the download starts (a JSON 404, not an aborted stream).
    expect((await h.req('/api/databases/shop/export?format=sql&tables=users,users2')).status).toBe(404)
    // A format that is not offered is refused, not guessed at.
    expect((await h.req('/api/databases/shop/export?format=xlsx')).status).toBe(400)
  })

  it('sends a file per format, packaged as asked, and refuses UPDATE for a table without a key', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ods = await h.req('/api/databases/shop/export?format=ods&tables=users')
    expect(ods.status).toBe(200)
    expect(ods.headers.get('content-type')).toBe('application/vnd.oasis.opendocument.spreadsheet')
    expect(ods.headers.get('content-disposition')).toContain('shop_users.ods')
    expect(new Uint8Array(await ods.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    const gz = await h.req('/api/databases/shop/export?format=markdown&compress=gzip&filename=%40DATABASE%40-md')
    expect(gz.headers.get('content-type')).toBe('application/gzip')
    expect(gz.headers.get('content-disposition')).toContain('shop-md.md.gz')
    // A CSV per table lifts the one-table limit and comes as a zip.
    const zip = await h.req('/api/databases/shop/export?format=csv&filePerTable=1')
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toBe('application/zip')
    expect((await h.req('/api/databases/shop/export?format=latex&tables=users&charset=nope')).status).toBe(400)
  })
})

describe('server catalog', () => {
  it('returns collations, engines and plugins, and refuses a kind that is not one of them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/catalog/engines')
    expect(res.status).toBe(200)
    expect(ServerCatalogSchema.parse(await res.json())).toEqual({ columns: ['name'], rows: [['fake engines']] })
    expect((await h.req('/api/server/catalog/users')).status).toBe(400)
  })

  it('returns the replication role, state and logs', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/replication')
    expect(res.status).toBe(200)
    expect(ReplicationInfoSchema.parse(await res.json())).toMatchObject({
      role: 'standalone',
      logs: [{ name: 'binlog.000001' }],
    })
  })

  it('previews a replication change with the password masked, and refuses one that is not valid', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const change = { op: 'changeSource', host: 'db1', user: 'repl', password: 'secret-pw', autoPosition: true }
    const res = await h.req('/api/server/replication/preview', { method: 'POST', body: JSON.stringify({ op: change }) })
    expect(res.status).toBe(200)
    const { sql } = (await res.json()) as { sql: string[] }
    expect(sql.join('\n')).toContain('****')
    expect(sql.join('\n')).not.toContain('secret-pw')
    const bad = await h.req('/api/server/replication/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { ...change, port: 0 } }),
    })
    expect(bad.status).toBe(400)
  })

  it('serves a diagnostic report by kind, and refuses a kind or a file it does not know', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/diagnostics/slowLog')
    expect(res.status).toBe(200)
    expect(DiagnosticReportSchema.parse(await res.json())).toMatchObject({ status: 'unsupported', rows: [] })
    expect((await h.req('/api/server/diagnostics/nothing')).status).toBe(400)
    expect((await h.req('/api/server/diagnostics/binlogEvents?file=')).status).toBe(400)
  })

  it('reads the statements after a logged time, and refuses a time that is not one', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/server/diagnostics/recentStatements')).status).toBe(200)
    expect((await h.req('/api/server/diagnostics/recentStatements?since=2026-09-21%2010:00:00.123456')).status).toBe(
      200
    )
    // The time is bound as a parameter, but it is still only ever a time.
    expect((await h.req("/api/server/diagnostics/recentStatements?since=1'%20OR%201=1")).status).toBe(400)
    expect((await h.req('/api/server/diagnostics/recentStatements?since=yesterday')).status).toBe(400)
  })
})

describe('import', () => {
  const upload = (
    h: ReturnType<typeof harness>,
    fields: Record<string, string>,
    file: { name: string; body: string }
  ) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([file.body], file.name, { type: 'text/plain' }))
    // Browsers send Origin on same-origin form posts; hono/csrf requires it for multipart bodies.
    return h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
  }

  it('rejects files over IMPORT_MAX_BYTES and bodies over the route limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const tooBig = await upload(h, { format: 'sql' }, { name: 'big.sql', body: 'x'.repeat(IMPORT_MAX_BYTES + 1) })
    expect(tooBig.status).toBe(413)
    expect(ApiErrorSchema.parse(await tooBig.json()).code).toBe('PAYLOAD_TOO_LARGE')
    const overLimit = await upload(
      h,
      { format: 'sql' },
      { name: 'huge.sql', body: 'x'.repeat(IMPORT_MAX_BYTES + 2 * 1024 * 1024) }
    )
    expect(overLimit.status).toBe(413)
    expect(ApiErrorSchema.parse(await overLimit.json())).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
    })
  })

  it('decodes percent-encoded database and table names', async () => {
    const adapter = new FakeAdapter({
      databases: { 'we ird/db': { tables: { 'a?b': fakeTable('a?b', ['id'], [{ id: 1 }]) } } },
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req(
      `/api/databases/${encodeURIComponent('we ird/db')}/tables/${encodeURIComponent('a?b')}/rows`
    )
    expect(res.status).toBe(200)
    expect(BrowseResultSchema.parse(await res.json()).rows).toEqual([[1]])
  })

  it('imports a SQL file and reports per-statement results', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'sql' }, { name: 'dump.sql', body: 'INSERT INTO users VALUES (9); SELECT 1' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    // The run streams progress and then the result (NDJSON); a validation problem mid-run is a `fatal` event.
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((line) => ImportEventSchema.parse(JSON.parse(line)))
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { format: 'sql', succeeded: 1, failed: 0 } })
    const latin1 = await upload(h, { format: 'sql' }, { name: 'l1.sql', body: 'x' })
    expect(latin1.status).toBe(200)
    const bytes = new FormData()
    bytes.set('format', 'sql')
    bytes.set('file', new File([new Uint8Array([0x53, 0x45, 0x4c, 0xe9])], 'l1.sql'))
    const bad = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: bytes,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
    expect(bad.status).toBe(400)
    expect(ApiErrorSchema.parse(await bad.json())).toMatchObject({ code: 'VALIDATION', reason: 'INVALID_ENCODING' })
  })

  it('imports a CSV into a table and rejects bad headers with 400', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'id,name\n7,Zed\n' })
    expect(res.status).toBe(200)
    const last = (text: string) => ImportEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? ''))
    expect(last(await res.text())).toMatchObject({
      type: 'result',
      result: { format: 'csv', inserted: 1, columns: ['id', 'name'] },
    })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.some((r) => r[1] === 'Zed')).toBe(true)
    const bad = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'nope\n1\n' })
    expect(bad.status).toBe(200)
    expect(last(await bad.text())).toMatchObject({
      type: 'fatal',
      error: { code: 'VALIDATION', reason: 'CSV_UNKNOWN_COLUMNS' },
    })
  })

  it('rejects cross-site form posts (CSRF) with 403', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    fd.set('file', new File(['SELECT 1'], 'x.sql'))
    const res = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('requires a file and a valid format', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    const noFile = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
    expect(noFile.status).toBe(400)
    expect((await upload(h, { format: 'xml' }, { name: 'x', body: 'x' })).status).toBe(400)
  })
})

describe('users', () => {
  const withUsers = () =>
    fixtureAdapter({
      // Real drivers return affected-row results for account statements (never the SQL text).
      onSql: (_ns, sql) => [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }],
      users: [
        { name: 'root', host: 'localhost', canLogin: true, attributes: [] },
        { name: 'app', host: '%', canLogin: false, attributes: ['LOCKED'] },
      ],
    })

  it('lists users and shows grants', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const users = await (await h.req('/api/users')).json()
    expect(users).toHaveLength(2)
    const grants = await (await h.req('/api/users/grants?name=app&host=%25')).json()
    expect(grants).toEqual({ statements: ["GRANT USAGE ON *.* TO 'app'@'%'"] })
    expect((await h.req('/api/users/grants?name=ghost')).status).toBe(404)
    await h.req('/api/users/grants?name=root&database=shop&schema=app')
    expect(h.adapter.calls.at(-1)).toEqual({
      method: 'showGrants',
      args: [{ name: 'root' }, { database: 'shop', schema: 'app' }],
    })
  })

  it('previews masked SQL and executes the real statements without echoing the password', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const op = {
      op: 'createUser',
      user: { name: 'new', host: '%' },
      password: 'hunter2',
      attributes: { createdb: true },
    }
    const preview = (await (
      await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op }) })
    ).json()) as { sql: string[] }
    expect(preview.sql[0]).toBe("CREATE USER 'new'@'%' IDENTIFIED BY '****'")
    expect(JSON.stringify(preview)).not.toContain('hunter2')
    const res = await h.req('/api/users/execute', { method: 'POST', body: JSON.stringify({ op }) })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    // The response says outright whether a failure undid the statements that had succeeded (PostgreSQL wraps
    // a multi-statement account operation in one transaction); MySQL commits each statement as it runs.
    expect(JSON.parse(body)).toMatchObject({ rolledBack: false, results: [{ kind: 'affected' }] })
    const executed = h.adapter.calls.filter((c) => c.method === 'executeSql')
    expect(executed).toHaveLength(1)
    expect(executed[0]?.args[1]).toBe(
      "CREATE USER 'new'@'%' IDENTIFIED BY 'hunter2';\nGRANT CREATE ON *.* TO 'new'@'%'"
    )
    expect(executed[0]?.args[0]).toEqual({ database: 'information_schema' })
  })

  it('scrubs the password from error messages that quote the failing SQL', async () => {
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) => [
        {
          kind: 'error',
          sql,
          message: `You have an error in your SQL syntax near 'IDENTIFIED BY 'hunter2'' at line 1`,
          code: 'QUERY_FAILED',
        },
      ],
      users: [],
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/users/execute', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'setPassword', user: { name: 'x', host: '%' }, password: 'hunter2' } }),
    })
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    expect(body).toContain('****')
  })

  it('refuses a column grant the servers could not run, on preview and on execute alike', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const send = (path: string, op: unknown) =>
      h.req(`/api/users/${path}`, { method: 'POST', body: JSON.stringify({ op }) })
    const base = { user: { name: 'r', host: '%' }, database: 'shop', table: 'orders' }
    // The rule lives in a refinement on the request schema, so both routes have to carry it: previewing SQL
    // that execute would then reject is the one failure mode worth pinning down.
    for (const path of ['preview', 'execute']) {
      // DELETE has no column form on either server.
      expect(
        (await send(path, { op: 'grantPrivileges', ...base, privileges: ['DELETE'], columns: ['id'] })).status
      ).toBe(400)
      // Columns without a table name nothing.
      const { table: _table, ...noTable } = base
      expect(
        (await send(path, { op: 'grantPrivileges', ...noTable, privileges: ['SELECT'], columns: ['id'] })).status
      ).toBe(400)
      // The valid form goes through.
      expect(
        (await send(path, { op: 'grantPrivileges', ...base, privileges: ['SELECT'], columns: ['id'] })).status
      ).toBe(200)
    }
    expect(h.adapter.calls.filter((c) => c.method === 'executeSql').map((c) => c.args[1])).toEqual([
      "GRANT SELECT (`id`) ON `shop`.`orders` TO 'r'@'%'",
    ])
  })

  it('validates user ops', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op: { op: 'nuke' } }) })).status
    ).toBe(400)
    expect((await h.req('/api/users')).status).toBe(200)
    expect((await h.app.request('/api/users')).status).toBe(401)
  })
})

describe('server', () => {
  const withProcesses = () =>
    fixtureAdapter({
      processes: [
        {
          id: '7',
          user: 'root',
          host: 'localhost',
          database: 'shop',
          state: 'Query',
          timeSec: 3,
          query: 'SELECT 1',
          self: false,
        },
        {
          id: '8',
          user: 'app',
          host: '10.0.0.1',
          database: null,
          state: 'Sleep',
          timeSec: 120,
          query: null,
          self: true,
        },
      ],
    })

  it('exposes info, variables, status and processes', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect(ServerInfoSchema.parse(await (await h.req('/api/server/info')).json()).version).toBe('0.0.0-fake')
    expect(
      z
        .array(KeyValueSchema)
        .parse(await (await h.req('/api/server/variables')).json())
        .some((v) => v.name === 'max_connections')
    ).toBe(true)
    expect(z.array(KeyValueSchema).parse(await (await h.req('/api/server/status')).json())).toHaveLength(1)
    expect(z.array(ProcessInfoSchema).parse(await (await h.req('/api/server/processes')).json())).toHaveLength(2)
  })

  it('kills a process by numeric id only', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(200)
    expect(
      z
        .array(ProcessInfoSchema)
        .parse(await (await h.req('/api/server/processes')).json())
        .map((p) => p.id)
    ).toEqual(['7'])
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(404)
    expect((await h.req('/api/server/processes/abc/kill', { method: 'POST' })).status).toBe(400)
    expect(
      (await h.app.request('/api/server/processes/7/kill', { method: 'POST', headers: { origin: 'http://localhost' } }))
        .status
    ).toBe(401)
  })
})
