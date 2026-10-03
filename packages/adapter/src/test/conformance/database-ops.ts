import { type StatementResult } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { mysqlAccount } from '../../mysql/users.ts'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'
import { EXEC } from './helpers.ts'

/** Conformance: the blocks of `database-ops` (in the order they have always run in). */
export function describeDatabaseOps(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, runDdl } = env
  describe('renaming and copying a database', () => {
    const src = `${scratch}_srcdb`
    const renamed = `${scratch}_rendb`
    const copied = `${scratch}_cpydb`
    const inDb = async (database: string, sql: string) => {
      for (const r of await env.db.executeSql({ database }, sql, EXEC))
        if (r.kind === 'error') throw new Error(`SQL failed: ${r.message}\n${r.sql}`)
    }
    const dropQuietly = async (name: string) => {
      if ((await env.db.listDatabases()).some((d) => d.name === name))
        for (const sql of env.db.ddl.build(ns, { op: 'dropDatabase', name })) await exec(sql)
    }
    /** A parent/child pair with a foreign key between them, so a move that loses the key is noticed. */
    const seed = async (database: string) => {
      // A non-default collation on MySQL, so a rename that silently falls back to the server default is caught.
      if (dialect === 'mysql') await execOk(`CREATE DATABASE ${quoteIdent('mysql', database)} COLLATE utf8mb4_bin`)
      else await runDdl({ op: 'createDatabase', name: database })
      await inDb(database, 'CREATE TABLE parent (id INT PRIMARY KEY, v VARCHAR(10))')
      await inDb(
        database,
        'CREATE TABLE child (id INT PRIMARY KEY, parent_id INT NOT NULL, CONSTRAINT child_parent FOREIGN KEY (parent_id) REFERENCES parent (id))'
      )
      await inDb(database, "INSERT INTO parent (id, v) VALUES (1, 'a'), (2, 'b')")
      await inDb(database, 'INSERT INTO child (id, parent_id) VALUES (10, 1), (20, 2)')
    }
    /** What the preview route fills in on MySQL; PostgreSQL ignores both fields. */
    const tablesOf = async (database: string) =>
      (await env.db.listTables({ database })).filter((t) => t.kind === 'table').map((t) => t.name)
    const rowIds = async (database: string, table: string) =>
      (await env.db.browseRows({ database }, table, { offset: 0, limit: 100, sort: [], filters: [] })).rows.map(
        (r) => r[0]
      )

    afterEach(async () => {
      for (const name of [src, renamed, copied]) await dropQuietly(name)
    })

    it('renames a database with its tables, rows and foreign keys, and removes the old name', async () => {
      await seed(src)
      // Opens a pooled connection to the source first: the rename must still go through (PostgreSQL refuses
      // while any session is connected, and this tool's own idle pool is exactly such a session).
      expect(await rowIds(src, 'parent')).toEqual([1, 2])
      const collation = (await env.db.listDatabases()).find((d) => d.name === src)?.collation ?? undefined
      await runDdl({
        op: 'renameDatabase',
        name: src,
        newName: renamed,
        tables: await tablesOf(src),
        ...(collation ? { collation } : {}),
      })
      const names = (await env.db.listDatabases()).map((d) => d.name)
      expect(names).toContain(renamed)
      if (dialect === 'postgres') expect(names).not.toContain(src)
      // MySQL keeps the old database, emptied of its tables, for the user to inspect and drop.
      else expect(await tablesOf(src)).toEqual([])
      expect(await rowIds(renamed, 'child')).toEqual([10, 20])
      expect((await env.db.describeTable({ database: renamed }, 'child')).foreignKeys.map((f) => f.name)).toEqual([
        'child_parent',
      ])
      if (dialect === 'mysql') {
        expect(collation).toBe('utf8mb4_bin')
        expect((await env.db.listDatabases()).find((d) => d.name === renamed)?.collation).toBe('utf8mb4_bin')
      }
    })

    it('never drops the old database on MySQL, so a table created after the preview is not lost', async () => {
      if (dialect !== 'mysql') return
      await seed(src)
      // The statements are built from the table list as it stood at preview time …
      const sql = env.db.ddl.build(ns, {
        op: 'renameDatabase',
        name: src,
        newName: renamed,
        tables: await tablesOf(src),
      })
      expect(sql.some((s) => /DROP\s+DATABASE/i.test(s))).toBe(false)
      // … and another session adds a table with a row before the user confirms.
      await inDb(src, 'CREATE TABLE late (id INT PRIMARY KEY)')
      await inDb(src, 'INSERT INTO late (id) VALUES (42)')
      for (const statement of sql) await execOk(statement)
      expect(await rowIds(renamed, 'parent')).toEqual([1, 2])
      expect(await rowIds(src, 'late')).toEqual([42])
    })

    it('leaves a query running on the source alone, and refuses the rename instead (PostgreSQL)', async () => {
      if (dialect !== 'postgres') return
      await seed(src)
      // Same account and application name as the rename itself: only the connection's state tells them apart.
      const running = env.db.executeSql({ database: src }, 'SELECT pg_sleep(2)', EXEC)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const results: StatementResult[] = []
      for (const sql of env.db.ddl.build(ns, { op: 'renameDatabase', name: src, newName: renamed }))
        results.push(...(await exec(sql, { stopOnError: true })))
      expect(results.some((r) => r.kind === 'error')).toBe(true)
      expect((await running).every((r) => r.kind !== 'error')).toBe(true)
      expect((await env.db.listDatabases()).map((d) => d.name)).toContain(src)
    }, 20_000)

    it('copies a database with its rows, leaving the source untouched', async () => {
      await seed(src)
      expect(await rowIds(src, 'parent')).toEqual([1, 2])
      const tables = await Promise.all(
        (await tablesOf(src)).map(async (name) => ({
          name,
          columns: (await env.db.describeTable({ database: src }, name)).columns.map((c) => c.name),
        }))
      )
      await runDdl({ op: 'copyDatabase', name: src, newName: copied, withData: true, tables })
      expect(await rowIds(copied, 'parent')).toEqual([1, 2])
      expect(await rowIds(copied, 'child')).toEqual([10, 20])
      expect(await rowIds(src, 'child')).toEqual([10, 20])
    })

    it('copies the foreign keys, the AUTO_INCREMENT counters and the accounts’ privileges when asked (MySQL)', async () => {
      if (dialect !== 'mysql') return
      const account = { name: `cp_${scratch}`.slice(0, 32), host: '%' }
      const q = (n: string) => quoteIdent('mysql', n)
      await seed(src)
      await inDb(src, 'CREATE TABLE counter (id INT AUTO_INCREMENT PRIMARY KEY)')
      await inDb(src, 'INSERT INTO counter (id) VALUES (1)')
      await inDb(src, 'ALTER TABLE counter AUTO_INCREMENT = 500')
      await execOk(`CREATE USER ${mysqlAccount(account)} IDENTIFIED BY 'cp-pw'`)
      try {
        await execOk(`GRANT SELECT, INSERT ON ${q(src)}.* TO ${mysqlAccount(account)} WITH GRANT OPTION`)
        const grants = await env.db.databaseGrants(src)
        expect(grants.find((g) => g.user === account.name)).toMatchObject({
          host: '%',
          privileges: ['INSERT', 'SELECT'],
          grantable: true,
        })
        const tables = await Promise.all(
          (await tablesOf(src)).map(async (name) => {
            const s = await env.db.describeTable({ database: src }, name)
            return {
              name,
              columns: s.columns.map((c) => c.name),
              ...(s.autoIncrement ? { autoIncrement: s.autoIncrement } : {}),
              foreignKeys: s.foreignKeys.map((fk) => ({
                name: fk.name,
                columns: fk.columns,
                refTable: fk.refTable,
                refDatabase: fk.refNamespace.database,
                refColumns: fk.refColumns,
              })),
            }
          })
        )
        await runDdl({
          op: 'copyDatabase',
          name: src,
          newName: copied,
          withData: true,
          foreignKeys: true,
          autoIncrement: true,
          privileges: true,
          tables,
          grants: grants.filter((g) => g.user === account.name),
        })
        // The key points at the copy's own parent, not the source's.
        const fk = (await env.db.describeTable({ database: copied }, 'child')).foreignKeys[0]
        expect(fk).toMatchObject({ refTable: 'parent', refNamespace: { database: copied } })
        // The counter is the source's, not the one the single row would give.
        expect((await env.db.describeTable({ database: copied }, 'counter')).autoIncrement).toBe('500')
        expect((await env.db.databaseGrants(copied)).find((g) => g.user === account.name)).toMatchObject({
          privileges: ['INSERT', 'SELECT'],
          grantable: true,
        })
      } finally {
        await exec(`DROP USER IF EXISTS ${mysqlAccount(account)}`, { stopOnError: false })
      }
    })
  })

  describe('permission errors', () => {
    it('maps insufficient privileges to PERMISSION_DENIED for a read-only account', async () => {
      const name = `ro_${scratch}`
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((s) => s.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      await runOp({
        op: 'createUser',
        user,
        password: 'ro-pw',
        attributes: { superuser: false, createdb: false, createrole: false },
      })
      const q = (n: string) => quoteIdent(dialect, n)
      if (dialect === 'mysql') await execOk(`GRANT SELECT ON ${q(ns.database)}.* TO ${mysqlAccount(user)}`)
      else
        await execOk(
          `GRANT CONNECT ON DATABASE ${q(ns.database)} TO ${q(name)}; GRANT USAGE ON SCHEMA public TO ${q(name)}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${q(name)}`
        )
      const ro = ctx.createAs(name, 'ro-pw')
      try {
        expect((await ro.browseRows(ns, 'users', { offset: 0, limit: 1, sort: [], filters: [] })).rows).toHaveLength(1)
        await expect(ro.updateRow(ns, 'users', { kind: 'pk', values: { id: 1 } }, { age: 1 })).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        })
        const results = await ro.executeSql(ns, 'DELETE FROM users WHERE id = 1', EXEC)
        expect(results[0]).toMatchObject({ kind: 'error', code: 'PERMISSION_DENIED' })
      } finally {
        await ro.close()
        // PostgreSQL refuses to drop a role that still owns privileges; revoke first (as the UI advises).
        if (dialect === 'postgres')
          await runOp({ op: 'revokeAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
        await runOp({ op: 'dropUser', user })
      }
    })
  })
}
