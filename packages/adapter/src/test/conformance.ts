import type { Cell, ColumnSpec, DdlOp, Dialect, Namespace, RowKey, StatementResult } from '@tsmyadmin/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mysqlAccount } from '../mysql/users.ts'
import { quoteIdent } from '../sql/quote.ts'
import type { DatabaseAdapter, ExecuteOptions, RowBatch } from '../types.ts'

export interface ConformanceContext {
  dialect: Dialect
  create: () => DatabaseAdapter
  /** Same server, wrong password. */
  createBad: () => DatabaseAdapter
  /** Same server, different account. */
  createAs: (user: string, password: string) => DatabaseAdapter
  ns: Namespace
  otherDatabase: string
  /** Expected schemas in ns.database (PostgreSQL) or [] (MySQL). */
  schemas: string[]
  /** Expected wire values for `types_all` row id=1, keyed by column. */
  typesRow1: Record<string, Cell>
  /** A read-only statement that runs for several seconds and can be interrupted by the statement timeout. */
  slowSql: string
}

const EXEC: ExecuteOptions = { maxRows: 1000, timeoutMs: 10_000, stopOnError: true }

function byName(columns: { name: string }[], row: Cell[]): Record<string, Cell> {
  const out: Record<string, Cell> = {}
  columns.forEach((c, i) => {
    out[c.name] = row[i] ?? null
  })
  return out
}

function col(name: string, dataType: string, extra: Partial<ColumnSpec> = {}): ColumnSpec {
  return { name, dataType, nullable: true, default: null, autoIncrement: false, comment: null, ...extra }
}

/**
 * Shared behavioural contract for every DatabaseAdapter implementation.
 * Each top-level `describe` is named after the adapter method it covers (checked by spec-consistency tests).
 */
export function describeAdapterConformance(ctx: ConformanceContext): void {
  const { ns, dialect } = ctx
  const scratch = `t_${dialect}_${Date.now().toString(36)}`
  const scratchNoPk = `${scratch}_nopk`
  const scratchDdl = `${scratch}_ddl`
  let db: DatabaseAdapter

  const exec = async (sql: string, opts: Partial<ExecuteOptions> = {}): Promise<StatementResult[]> => {
    const results = await db.executeSql(ns, sql, { ...EXEC, ...opts })
    return results
  }
  const execOk = async (sql: string): Promise<StatementResult[]> => {
    const results = await exec(sql)
    for (const r of results) if (r.kind === 'error') throw new Error(`SQL failed: ${r.message}\n${r.sql}`)
    return results
  }
  const runDdl = async (op: DdlOp) => {
    for (const sql of db.ddl.build(ns, op)) await execOk(sql)
  }
  // Every scratch table this suite creates; dropped before and after the run so nothing leaks into the shared DB.
  const SCRATCH_TABLES = [
    scratch,
    scratchNoPk,
    scratchDdl,
    `${scratch}_empty`,
    `${scratch}_dump`,
    `${scratch}_keyset`,
    `${scratch}_gen`,
    `${scratch}_uns`,
    `${scratch}_partial`,
    `${scratch}_copy`,
    `${scratchDdl}_rn`,
    `${scratch}_camel`,
    `${scratch}_pu`,
    `${scratch}_seq`,
    `${scratch}_like`,
  ]
  const browseAll = async (table: string) => db.browseRows(ns, table, { offset: 0, limit: 100, sort: [], filters: [] })

  describe(`adapter conformance (${dialect})`, () => {
    beforeAll(async () => {
      db = ctx.create()
      await db.ping()
      await execOk(SCRATCH_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`).join('; '))
      await execOk(`CREATE TABLE ${scratch} (id INT PRIMARY KEY, name VARCHAR(50) NULL, n INT NULL)`)
      await execOk(`CREATE TABLE ${scratchNoPk} (a INT NULL, b VARCHAR(50) NULL)`)
      await execOk(`CREATE TABLE ${scratch}_empty (id INT PRIMARY KEY)`)
      await execOk(`INSERT INTO ${scratchNoPk} (a, b) VALUES (1, 'one'), (1, 'one'), (2, 'two'), (NULL, NULL)`)
    })

    afterAll(async () => {
      await exec(SCRATCH_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`).join('; '), { stopOnError: false })
      await db.close()
    })

    describe('ping', () => {
      it('resolves for valid credentials', async () => {
        await expect(db.ping()).resolves.toBeUndefined()
      })

      it('rejects with AUTH_FAILED for a wrong password', async () => {
        const bad = ctx.createBad()
        await expect(bad.ping()).rejects.toMatchObject({ name: 'AdapterError', code: 'AUTH_FAILED' })
        await bad.close()
      })
    })

    describe('listDatabases', () => {
      it('includes the fixture databases', async () => {
        const names = (await db.listDatabases()).map((d) => d.name)
        expect(names).toContain(ns.database)
        expect(names).toContain(ctx.otherDatabase)
      })
    })

    describe('listSchemas', () => {
      it('returns the expected schemas for the dialect', async () => {
        const schemas = await db.listSchemas(ns.database)
        for (const s of ctx.schemas) expect(schemas).toContain(s)
        if (ctx.schemas.length === 0) expect(schemas).toEqual([])
      })
    })

    describe('listTables', () => {
      it('lists fixture tables and views with metadata', async () => {
        const tables = await db.listTables(ns)
        const map = new Map(tables.map((t) => [t.name, t]))
        for (const name of ['users', 'posts', 'types_all', 'no_pk', 'unique_only', 'composite_pk', 'active_users']) {
          expect(map.has(name), `missing table ${name}`).toBe(true)
        }
        expect(map.get('users')?.kind).toBe('table')
        expect(map.get('active_users')?.kind).toBe('view')
        expect(map.get('users')?.comment).toBe('application users')
        const est = map.get('users')?.rowEstimate
        expect(est === null || typeof est === 'number').toBe(true)
      })
    })

    describe('describeTable', () => {
      it('describes columns, primary key, indexes and comments', async () => {
        const users = await db.describeTable(ns, 'users')
        expect(users.kind).toBe('table')
        expect(users.comment).toBe('application users')
        expect(users.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'age', 'created_at'])
        expect(users.primaryKey).toEqual(['id'])
        expect(users.rowEstimate === null || typeof users.rowEstimate === 'number').toBe(true)
        const name = users.columns.find((c) => c.name === 'name')
        expect(name?.nullable).toBe(false)
        expect(name?.comment).toBe('display name')
        expect(users.columns.find((c) => c.name === 'age')?.nullable).toBe(true)
        expect(users.columns.find((c) => c.name === 'id')?.extra).not.toBe('')
        const createdAt = users.columns.find((c) => c.name === 'created_at')
        expect(createdAt?.default).toBeTruthy()
        const uq = users.indexes.find((i) => i.name === 'uq_users_email')
        expect(uq).toMatchObject({ unique: true, primary: false, columns: ['email'] })
        expect(users.indexes.find((i) => i.name === 'idx_users_name')).toMatchObject({
          unique: false,
          columns: ['name'],
        })
        expect(users.indexes.find((i) => i.primary)?.columns).toEqual(['id'])
      })

      it('lists reverse references (tables pointing at this one)', async () => {
        const users = await db.describeTable(ns, 'users')
        expect(users.referencedBy).toHaveLength(1)
        expect(users.referencedBy[0]).toMatchObject({
          name: 'fk_posts_user',
          fromTable: 'posts',
          fromColumns: ['user_id'],
          columns: ['id'],
        })
        expect((await db.describeTable(ns, 'posts')).referencedBy).toEqual([])
        expect((await browseAll('users')).referencedBy).toHaveLength(1)
      })

      it('describes foreign keys with referential actions', async () => {
        const posts = await db.describeTable(ns, 'posts')
        expect(posts.foreignKeys).toHaveLength(1)
        expect(posts.foreignKeys[0]).toMatchObject({
          name: 'fk_posts_user',
          columns: ['user_id'],
          refTable: 'users',
          refColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        })
      })

      it('handles composite keys, missing keys, unique-only tables and views', async () => {
        expect((await db.describeTable(ns, 'composite_pk')).primaryKey).toEqual(['a', 'b'])
        const noPk = await db.describeTable(ns, 'no_pk')
        expect(noPk.primaryKey).toEqual([])
        expect(noPk.comment).toBe('table without primary key')
        const uniqueOnly = await db.describeTable(ns, 'unique_only')
        expect(uniqueOnly.primaryKey).toEqual([])
        expect(uniqueOnly.indexes.some((i) => i.unique && i.columns.join() === 'code')).toBe(true)
        expect((await db.describeTable(ns, 'active_users')).kind).toBe('view')
      })

      it('rejects with NOT_FOUND for an unknown table', async () => {
        await expect(db.describeTable(ns, 'does_not_exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('listRoutines', () => {
      it('lists the fixture procedure and function', async () => {
        const routines = await db.listRoutines(ns)
        const proc = routines.find((r) => r.name === 'count_users')
        const fn = routines.find((r) => r.name === 'user_label')
        expect(proc?.kind).toBe('procedure')
        expect(fn?.kind).toBe('function')
        expect(fn?.returns?.toLowerCase()).toMatch(/varchar|text/)
        expect(fn?.parameters.toLowerCase()).toContain('uid')
      })
    })

    describe('routineDefinition', () => {
      it('returns the CREATE statement per routine and NOT_FOUND for unknown names', async () => {
        const fn = await db.routineDefinition(ns, 'user_label', 'function')
        expect(fn?.toUpperCase()).toContain('CREATE')
        expect(fn).toContain('user_label')
        expect((await db.routineDefinition(ns, 'count_users', 'procedure'))?.toUpperCase()).toContain('CREATE')
        await expect(db.routineDefinition(ns, 'does_not_exist', 'function')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
        // Wrong kind for an existing name is not a match either.
        await expect(db.routineDefinition(ns, 'user_label', 'procedure')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('listTriggers', () => {
      it('lists the fixture trigger and filters by table', async () => {
        const all = await db.listTriggers(ns)
        const trg = all.find((t) => t.name === 'posts_before_insert')
        expect(trg).toMatchObject({ table: 'posts', timing: 'BEFORE', events: 'INSERT', orientation: 'ROW' })
        expect(trg?.definition).toBeTruthy()
        expect((await db.listTriggers(ns, 'posts')).map((t) => t.name)).toContain('posts_before_insert')
        expect(await db.listTriggers(ns, 'users')).toEqual([])
      })
    })

    describe('listEvents', () => {
      it('lists scheduled events on MySQL and returns [] on PostgreSQL', async () => {
        const events = await db.listEvents(ns)
        if (dialect === 'postgres') {
          expect(events).toEqual([])
          return
        }
        const ev = events.find((e) => e.name === 'purge_old_posts')
        expect(ev).toMatchObject({
          status: 'DISABLED',
          type: 'RECURRING',
          schedule: 'EVERY 1 DAY',
          comment: 'remove posts older than a year',
        })
        expect(ev?.definition).toContain('DELETE FROM posts')
        try {
          await runDdl({ op: 'enableEvent', name: 'purge_old_posts' })
          expect((await db.listEvents(ns)).find((e) => e.name === 'purge_old_posts')?.status).toBe('ENABLED')
        } finally {
          await runDdl({ op: 'disableEvent', name: 'purge_old_posts' })
        }
        expect((await db.listEvents(ns)).find((e) => e.name === 'purge_old_posts')?.status).toBe('DISABLED')
      })
    })

    describe('browseRows', () => {
      it('returns rows as arrays with column metadata and total', async () => {
        const r = await browseAll('users')
        expect(r.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'age', 'created_at'])
        expect(r.rows).toHaveLength(5)
        expect(r.total).toBe(5)
        expect(r.approximate).toBe(false)
        expect(r.truncated).toBe(false)
        expect(r.keyKind).toBe('pk')
        expect(r.keyColumns).toEqual(['id'])
        expect(r.columns.every((c) => typeof c.dataType === 'string' && c.dataType.length > 0)).toBe(true)
      })

      it('exposes outgoing foreign keys for linking', async () => {
        const r = await browseAll('posts')
        expect(r.foreignKeys).toHaveLength(1)
        expect(r.foreignKeys[0]).toMatchObject({ columns: ['user_id'], refTable: 'users', refColumns: ['id'] })
        expect((await browseAll('users')).foreignKeys).toEqual([])
      })

      it('sorts, paginates and keeps total independent of the page', async () => {
        const desc = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 2,
          sort: [{ column: 'name', direction: 'desc' }],
          filters: [],
        })
        expect(desc.rows.map((r) => r[1])).toEqual(['Eve', 'Dave'])
        expect(desc.total).toBe(5)
        const page = await db.browseRows(ns, 'users', {
          offset: 2,
          limit: 2,
          sort: [{ column: 'id', direction: 'asc' }],
          filters: [],
        })
        expect(page.rows.map((r) => r[1])).toEqual(['Carol', 'Dave'])
      })

      it('applies filters (comparison, like, null checks) with parameters', async () => {
        const gt = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [{ column: 'id', direction: 'asc' }],
          filters: [{ column: 'age', op: 'gt', value: 30 }],
        })
        expect(gt.rows.map((r) => r[1])).toEqual(['Carol', 'Eve'])
        expect(gt.total).toBe(2)
        const isNull = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'age', op: 'is_null' }],
        })
        expect(isNull.rows.map((r) => r[1])).toEqual(['Bob'])
        const like = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'name', op: 'like', value: 'A%' }],
        })
        expect(like.rows.map((r) => r[1])).toEqual(['Alice'])
        const injection = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'name', op: 'eq', value: "' OR 1=1 --" }],
        })
        expect(injection.rows).toHaveLength(0)
      })

      it('matches contains / starts_with literally (LIKE metacharacters escaped)', async () => {
        const t = `${scratch}_like`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, s VARCHAR(30) NULL)`)
        await execOk(
          `INSERT INTO ${t} (id, s) VALUES (1, '100%'), (2, 'a_b'), (3, 'axb'), (4, 'bang!here'), (5, 'xx100%yy')`
        )
        const find = async (op: 'contains' | 'starts_with', value: string) =>
          (
            await db.browseRows(ns, t, {
              offset: 0,
              limit: 10,
              sort: [{ column: 'id', direction: 'asc' }],
              filters: [{ column: 's', op, value }],
            })
          ).rows.map((r) => r[0])
        expect(await find('contains', '100%')).toEqual([1, 5])
        expect(await find('starts_with', '100%')).toEqual([1])
        expect(await find('contains', 'a_b')).toEqual([2])
        expect(await find('contains', '!')).toEqual([4])
        expect(await find('starts_with', 'a')).toEqual([2, 3])
        await execOk(`DROP TABLE ${t}`)
      })

      it('rejects unknown sort/filter columns', async () => {
        await expect(
          db.browseRows(ns, 'users', { offset: 0, limit: 1, sort: [{ column: 'nope', direction: 'asc' }], filters: [] })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('returns lossless wire values for every fixture type', async () => {
        const r = await db.browseRows(ns, 'types_all', {
          offset: 0,
          limit: 10,
          sort: [{ column: 'id', direction: 'asc' }],
          filters: [],
        })
        const row1 = byName(r.columns, r.rows[0] ?? [])
        for (const [column, expected] of Object.entries(ctx.typesRow1)) {
          expect(row1[column], `types_all.${column}`).toEqual(expected)
        }
        const row2 = byName(r.columns, r.rows[1] ?? [])
        for (const column of Object.keys(ctx.typesRow1)) expect(row2[column], `types_all.${column} NULL`).toBeNull()
        // BIGINT within the safe range is a number on both dialects (row 3 holds -1); beyond it a string (row 1).
        const row3 = byName(r.columns, r.rows[2] ?? [])
        expect(row3.big_col).toBe(-1)
        expect(row3.dec_col).toBe('0.000001')
      })

      it('reports the row-identity strategy per table', async () => {
        expect((await browseAll('unique_only')).keyKind).toBe('pk')
        expect((await browseAll('unique_only')).keyColumns).toEqual(['code'])
        expect((await browseAll('active_users')).keyKind).toBe('none')
        const noPk = await browseAll('no_pk')
        if (dialect === 'postgres') {
          expect(noPk.keyKind).toBe('ctid')
          expect(noPk.keyColumns).toEqual(['ctid'])
          expect(noPk.columns.at(-1)?.name).toBe('ctid')
          expect(typeof noPk.rows[0]?.at(-1)).toBe('string')
        } else {
          expect(noPk.keyKind).toBe('all-columns')
          expect(noPk.keyColumns).toEqual(['a', 'b'])
        }
      })
    })

    describe('insertRow', () => {
      it('inserts values including NULL and binary', async () => {
        const r = await db.insertRow(ns, scratch, { id: 1, name: 'first', n: null })
        expect(r.affectedRows).toBe(1)
        await db.insertRow(ns, scratch, { id: 2, name: "quote ' here", n: 42 })
        const rows = await browseAll(scratch)
        expect(rows.total).toBe(2)
        expect(rows.rows.map((x) => x[1])).toEqual(['first', "quote ' here"])
        expect(rows.rows[0]?.[2]).toBeNull()
      })

      it('surfaces constraint violations as QUERY_FAILED', async () => {
        await expect(db.insertRow(ns, scratch, { id: 1, name: 'dup' })).rejects.toMatchObject({ code: 'QUERY_FAILED' })
      })
    })

    describe('insertRows', () => {
      it('bulk-inserts in chunks inside one transaction', async () => {
        const rows = Array.from({ length: 1203 }, (_, i) => [1000 + i, `bulk ${i}`, i % 3 === 0 ? null : i])
        const r = await db.insertRows(ns, scratch, ['id', 'name', 'n'], rows)
        expect(r.affectedRows).toBe(1203)
        const after = await db.browseRows(ns, scratch, {
          offset: 0,
          limit: 5,
          sort: [{ column: 'id', direction: 'desc' }],
          filters: [{ column: 'id', op: 'gte', value: 1000 }],
        })
        expect(after.total).toBe(1203)
        expect(after.rows[0]?.[1]).toBe('bulk 1202')
        await execOk(`DELETE FROM ${scratch} WHERE id >= 1000`)
      })

      it('rolls everything back when one row fails', async () => {
        const before = (await browseAll(scratch)).total
        await expect(
          db.insertRows(
            ns,
            scratch,
            ['id', 'name'],
            [
              [5000, 'ok'],
              [1, 'duplicate pk'],
            ]
          )
        ).rejects.toMatchObject({ code: 'QUERY_FAILED' })
        expect((await browseAll(scratch)).total).toBe(before)
      })

      it('returns 0 for no rows and rejects an empty column list', async () => {
        expect(await db.insertRows(ns, scratch, ['id'], [])).toEqual({ affectedRows: 0 })
        await expect(db.insertRows(ns, scratch, [], [[1]])).rejects.toMatchObject({ code: 'QUERY_FAILED' })
      })
    })

    describe('updateRow', () => {
      it('updates exactly one row by primary key', async () => {
        const r = await db.updateRow(ns, scratch, { kind: 'pk', values: { id: 2 } }, { name: 'second', n: 43 })
        expect(r.affectedRows).toBe(1)
        const rows = await db.browseRows(ns, scratch, {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'id', op: 'eq', value: 2 }],
        })
        expect(rows.rows[0]?.slice(1)).toEqual(['second', 43])
      })

      it('rolls back and reports KEY_MISMATCH when the key matches no row', async () => {
        await expect(
          db.updateRow(ns, scratch, { kind: 'pk', values: { id: 999 } }, { name: 'ghost' })
        ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
        expect((await browseAll(scratch)).total).toBe(2)
      })

      it('updates a single row of a table without primary key', async () => {
        const before = await browseAll(scratchNoPk)
        let key: RowKey
        if (dialect === 'postgres') {
          const target = before.rows.find((r) => r[0] === 1 && r[1] === 'one')
          key = { kind: 'ctid', value: String(target?.at(-1)) }
        } else {
          key = { kind: 'all-columns', values: { a: 1, b: 'one' } }
        }
        const r = await db.updateRow(ns, scratchNoPk, key, { b: 'uno' })
        expect(r.affectedRows).toBe(1)
        const after = await browseAll(scratchNoPk)
        expect(after.rows.filter((x) => x[1] === 'uno')).toHaveLength(1)
        expect(after.rows.filter((x) => x[1] === 'one')).toHaveLength(1)
      })

      it.skipIf(dialect !== 'postgres')('rejects a stale ctid after the row moved (PostgreSQL)', async () => {
        const before = await browseAll(scratchNoPk)
        const target = before.rows.find((r) => r[0] === 2 && r[1] === 'two')
        const stale = String(target?.at(-1))
        expect(await db.updateRow(ns, scratchNoPk, { kind: 'ctid', value: stale }, { b: 'dos' })).toEqual({
          affectedRows: 1,
        })
        // The UPDATE wrote a new tuple version, so the captured ctid no longer addresses a live row.
        await expect(
          db.updateRow(ns, scratchNoPk, { kind: 'ctid', value: stale }, { b: 'tres' })
        ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
        await expect(db.deleteRows(ns, scratchNoPk, [{ kind: 'ctid', value: stale }])).rejects.toMatchObject({
          code: 'KEY_MISMATCH',
        })
        const after = await browseAll(scratchNoPk)
        expect(after.rows.filter((x) => x[1] === 'dos')).toHaveLength(1)
        expect(after.rows.filter((x) => x[1] === 'tres')).toHaveLength(0)
      })

      it.skipIf(dialect !== 'mysql')('matches NULL values in all-columns keys (MySQL)', async () => {
        const r = await db.updateRow(
          ns,
          scratchNoPk,
          { kind: 'all-columns', values: { a: null, b: null } },
          { b: 'was null' }
        )
        expect(r.affectedRows).toBe(1)
      })
    })

    describe('deleteRows', () => {
      it('deletes each key inside one transaction', async () => {
        await db.insertRow(ns, scratch, { id: 3, name: 'three' })
        const r = await db.deleteRows(ns, scratch, [
          { kind: 'pk', values: { id: 2 } },
          { kind: 'pk', values: { id: 3 } },
        ])
        expect(r.affectedRows).toBe(2)
        expect((await browseAll(scratch)).rows.map((x) => x[0])).toEqual([1])
      })

      it('rolls back the whole batch when one key mismatches', async () => {
        await db.insertRow(ns, scratch, { id: 4, name: 'four' })
        await expect(
          db.deleteRows(ns, scratch, [
            { kind: 'pk', values: { id: 4 } },
            { kind: 'pk', values: { id: 999 } },
          ])
        ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
        expect((await browseAll(scratch)).rows.map((x) => x[0])).toEqual([1, 4])
      })
    })

    describe('executeSql', () => {
      it('runs multiple statements and returns one result per statement', async () => {
        const results = await exec('SELECT 1 AS one; SELECT 2 AS two')
        expect(results).toHaveLength(2)
        expect(results[0]).toMatchObject({ kind: 'rows', sql: 'SELECT 1 AS one' })
        if (results[0]?.kind === 'rows') {
          expect(results[0].result.columns.map((c) => c.name)).toEqual(['one'])
          expect(results[0].result.rows).toEqual([[1]])
        }
        if (results[1]?.kind === 'rows') expect(results[1].result.rows).toEqual([[2]])
        expect(results.every((r) => r.kind !== 'error' && r.durationMs >= 0)).toBe(true)
      })

      it('does not leak session state set by a script into the next borrower of the connection', async () => {
        // Pools hand out the most recently released connection first, so the follow-up call sees the same
        // physical connection the script mutated.
        if (dialect === 'mysql') {
          await execOk("SET SESSION autocommit = 0; SET SESSION sql_mode = 'ANSI_QUOTES'; SET @leak = 1")
          const after = await execOk('SELECT @@autocommit, @@sql_mode, @leak')
          const row = after[0]?.kind === 'rows' ? after[0].result.rows[0] : undefined
          expect(row?.[0]).toBe(1)
          expect(String(row?.[1])).not.toContain('ANSI_QUOTES')
          expect(row?.[2]).toBeNull()
        } else {
          await execOk("SET lock_timeout = '5s'; SET application_name = 'leak'")
          const after = await execOk('SHOW lock_timeout; SHOW application_name')
          expect(after[0]?.kind === 'rows' ? after[0].result.rows[0]?.[0] : null).toBe('0')
          expect(after[1]?.kind === 'rows' ? after[1].result.rows[0]?.[0] : null).not.toBe('leak')
        }
      })

      it.skipIf(dialect !== 'mysql')('keeps MySQL version comments (/*! ... */) as executable statements', async () => {
        const results = await execOk('/*!40014 SET @tsmy_vc = 7 */; SELECT @tsmy_vc')
        expect(results).toHaveLength(2)
        expect(results[1]?.kind === 'rows' ? results[1].result.rows[0]?.[0] : null).toBe(7)
      })

      it.skipIf(dialect !== 'mysql')('reports UNSIGNED on DECIMAL result columns (MySQL)', async () => {
        const t = `${scratch}_uns`
        await execOk(`CREATE TABLE ${t} (d DECIMAL(10,2) UNSIGNED NULL, f FLOAT UNSIGNED NULL, i INT UNSIGNED NULL)`)
        const r = await execOk(`SELECT d, f, i FROM ${t}`)
        expect(r[0]?.kind === 'rows' ? r[0].result.columns.map((c) => c.dataType) : []).toEqual([
          'decimal unsigned',
          'float unsigned',
          'int unsigned',
        ])
        await execOk(`DROP TABLE ${t}`)
      })

      it('streams each statement result through onResult in order, before the next statement runs', async () => {
        const seen: string[] = []
        const results = await db.executeSql(ns, 'SELECT 1 AS a; SELECT 2 AS b; SELECT * FROM nope_nope; SELECT 4', {
          ...EXEC,
          stopOnError: false,
          onResult: (r, i) => {
            seen.push(`${i}:${r.kind}`)
          },
        })
        expect(seen).toEqual(['0:rows', '1:rows', '2:error', '3:rows'])
        expect(results).toHaveLength(4)
      })

      it('reports affected rows for DML', async () => {
        const results = await exec(`UPDATE ${scratch} SET n = 1 WHERE id = 1; SELECT n FROM ${scratch} WHERE id = 1`)
        expect(results[0]).toMatchObject({ kind: 'affected', affectedRows: 1 })
        expect(results[1]).toMatchObject({ kind: 'rows' })
      })

      it('attributes errors to the failing statement and honours stopOnError', async () => {
        const script = 'SELECT 1; SELECT * FROM table_that_does_not_exist_xyz; SELECT 3'
        const stop = await exec(script, { stopOnError: true })
        expect(stop).toHaveLength(2)
        expect(stop[1]).toMatchObject({
          kind: 'error',
          code: 'NOT_FOUND',
          sql: 'SELECT * FROM table_that_does_not_exist_xyz',
        })
        if (stop[1]?.kind === 'error') expect(stop[1].message.length).toBeGreaterThan(0)
        const go = await exec(script, { stopOnError: false })
        expect(go).toHaveLength(3)
        expect(go[2]).toMatchObject({ kind: 'rows' })
      })

      it('truncates result sets at maxRows', async () => {
        const results = await exec('SELECT id FROM users ORDER BY id', { maxRows: 2 })
        expect(results[0]).toMatchObject({ kind: 'rows' })
        if (results[0]?.kind === 'rows') {
          expect(results[0].result.rows).toHaveLength(2)
          expect(results[0].result.truncated).toBe(true)
        }
      })

      it('applies the statement timeout', async () => {
        const started = Date.now()
        const results = await exec(ctx.slowSql, { timeoutMs: 500 })
        // The per-call timeout must win over the cached default (the slow statement takes seconds otherwise).
        expect(Date.now() - started).toBeLessThan(2500)
        expect(results[0]).toMatchObject({
          kind: 'error',
          nativeCode: dialect === 'mysql' ? 'ER_QUERY_TIMEOUT' : '57014',
        })
      })

      it('caps a plain SELECT at maxRows + 1 rows server-side and marks it truncated', async () => {
        // 5^8 = 390,625 rows on MySQL (cross join of the 5-row fixture); a series on PostgreSQL.
        const big =
          dialect === 'mysql'
            ? `SELECT u1.id FROM ${Array.from({ length: 8 }, (_, i) => `users u${i + 1}`).join(', ')}`
            : 'SELECT i FROM generate_series(1, 200000) AS g(i)'
        const started = Date.now()
        const results = await exec(big, { maxRows: 5 })
        expect(Date.now() - started).toBeLessThan(2000)
        expect(results[0]).toMatchObject({ kind: 'rows', result: { truncated: true } })
        if (results[0]?.kind === 'rows') expect(results[0].result.rows).toHaveLength(5)
        // Statements that cannot be wrapped run as written (duplicate names on MySQL, FOR UPDATE, INTO).
        const dup = await exec('SELECT 1 AS a, 2 AS a', { maxRows: 5 })
        if (dup[0]?.kind === 'rows') expect(dup[0].result.rows).toEqual([[1, 2]])
        expect(dup[0]?.kind).toBe('rows')
        const lock = await exec('SELECT id FROM users WHERE id = 1 FOR UPDATE')
        expect(lock[0]?.kind).toBe('rows')
        // A syntax error position refers to the statement as typed, not to the wrapper.
        const bad = await exec('SELECT id FROM users WHERE ORDER', { stopOnError: false })
        expect(bad[0]?.kind).toBe('error')
        if (bad[0]?.kind === 'error' && bad[0].position !== undefined) {
          expect(bad[0].position).toBeLessThanOrEqual('SELECT id FROM users WHERE ORDER'.length)
        }
        // Joins with duplicate column names still return rows (MySQL cannot wrap those; PostgreSQL can).
        const dupJoin = await exec('SELECT * FROM users u JOIN posts p ON p.user_id = u.id', { maxRows: 2 })
        expect(dupJoin[0]).toMatchObject({ kind: 'rows', result: { truncated: true } })
      })

      it('stops the remaining statements of a cancelled script even with stopOnError=false', async () => {
        const queryId = crypto.randomUUID()
        const run = db.executeSql(ns, `${ctx.slowSql}; SELECT 42 AS after`, {
          ...EXEC,
          stopOnError: false,
          timeoutMs: 60_000,
          queryId,
        })
        expect(await db.cancelQuery(queryId)).toBe(true)
        const results = await run
        expect(results).toHaveLength(1)
        expect(results[0]?.kind).toBe('error')
      })

      it('re-applies the namespace after a script changed it', async () => {
        await execOk(
          dialect === 'mysql' ? 'USE information_schema; SELECT 1' : 'SET search_path TO pg_catalog; SELECT 1'
        )
        expect((await browseAll('users')).rows.length).toBeGreaterThan(0)
      })

      it.skipIf(dialect !== 'mysql')('keeps the utf8mb4 session charset across the connection reset', async () => {
        const before = await execOk('SELECT @@character_set_client, @@character_set_results')
        await execOk('SELECT 1')
        const after = await execOk('SELECT @@character_set_client, @@character_set_results')
        const row = (r: StatementResult[]) => (r[0]?.kind === 'rows' ? r[0].result.rows[0] : undefined)
        expect(row(after)).toEqual(row(before))
        expect(row(after)?.[0]).toBe('utf8mb4')
      })

      it.skipIf(dialect !== 'postgres')('keeps NaN / Infinity floats as text instead of NULL', async () => {
        const r = await execOk("SELECT 'NaN'::float8, 'Infinity'::float4, 1.5::float8")
        expect(r[0]?.kind === 'rows' ? r[0].result.rows[0] : null).toEqual(['NaN', 'Infinity', 1.5])
      })

      it('ignores comment-only scripts', async () => {
        expect(await exec('-- nothing here\n/* or here */')).toEqual([])
      })

      it('rolls back a transaction the script left open', async () => {
        const begin = dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
        await exec(`${begin}; INSERT INTO ${scratch} (id, name) VALUES (7777, 'uncommitted'); SELECT * FROM nope_nope`)
        const rows = await db.browseRows(ns, scratch, {
          offset: 0,
          limit: 1,
          sort: [],
          filters: [{ column: 'id', op: 'eq', value: 7777 }],
        })
        expect(rows.total).toBe(0)
        const ok = await exec('SELECT 1 AS x')
        expect(ok[0]).toMatchObject({ kind: 'rows' })
      })

      it('keeps working after an error (no poisoned connection)', async () => {
        await exec('SELECT * FROM nope_nope')
        const ok = await exec('SELECT 1 AS x')
        expect(ok[0]).toMatchObject({ kind: 'rows' })
      })
    })

    describe('cancelQuery', () => {
      it('interrupts a running script from another connection and keeps the pool usable', async () => {
        const queryId = crypto.randomUUID()
        const run = db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
        // Registration is synchronous: a cancel issued immediately waits for the backend id and succeeds.
        expect(await db.cancelQuery(queryId)).toBe(true)
        const results = await run
        expect(results[0]?.kind).toBe('error')
        // KILL QUERY / pg_cancel_backend end the statement, not the connection: it must stay in the pool.
        if (results[0]?.kind === 'error') expect(results[0].code).not.toBe('CONNECTION_FAILED')
        expect(await db.cancelQuery(queryId)).toBe(false)
        const ok = await exec('SELECT 1 AS x')
        expect(ok[0]).toMatchObject({ kind: 'rows' })
      })

      it('returns false for unknown ids and for ids whose script already completed', async () => {
        expect(await db.cancelQuery(crypto.randomUUID())).toBe(false)
        const queryId = crypto.randomUUID()
        const results = await db.executeSql(ns, 'SELECT 1 AS x', { ...EXEC, queryId })
        expect(results[0]).toMatchObject({ kind: 'rows' })
        // The registration is removed on the success path too, so a late cancel is a no-op.
        expect(await db.cancelQuery(queryId)).toBe(false)
      })
    })

    describe('showCreateTable', () => {
      it('returns DDL that names the table, and a view definition for views', async () => {
        const users = await db.showCreateTable(ns, 'users')
        expect(users.length).toBeGreaterThan(0)
        expect(users[0]).toMatch(/CREATE TABLE/i)
        expect(users.join('\n')).toContain('users')
        const view = await db.showCreateTable(ns, 'active_users')
        expect(view.join('\n')).toMatch(/CREATE( OR REPLACE)?[^;]*VIEW/i)
      })

      it('rejects unknown tables', async () => {
        await expect(db.showCreateTable(ns, 'nope_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it.skipIf(dialect !== 'postgres')(
        'keeps partial-index predicates and materialized views (PostgreSQL)',
        async () => {
          const t = `${scratch}_partial`
          const mv = `${t}_mv`
          await execOk(
            `CREATE TABLE ${t} (id INT PRIMARY KEY, email TEXT, deleted_at TIMESTAMP NULL);
           CREATE UNIQUE INDEX ${t}_email_live ON ${t} (email) WHERE deleted_at IS NULL;
           CREATE MATERIALIZED VIEW ${mv} AS SELECT id FROM ${t}`
          )
          try {
            const idx = (await db.describeTable(ns, t)).indexes.find((i) => i.name === `${t}_email_live`)
            expect(idx).toMatchObject({ unique: true, predicate: 'deleted_at IS NULL' })
            expect((await db.showCreateTable(ns, t)).join('\n')).toMatch(
              /UNIQUE INDEX .* WHERE \(?deleted_at IS NULL\)?/
            )
            const info = (await db.listTables(ns)).find((x) => x.name === mv)
            expect(info?.kind).toBe('materialized_view')
            expect((await db.describeTable(ns, mv)).kind).toBe('materialized_view')
            expect((await db.showCreateTable(ns, mv))[0]).toMatch(/^CREATE MATERIALIZED VIEW/)
            expect((await browseAll(mv)).keyKind).toBe('none')
          } finally {
            await exec(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`, { stopOnError: false })
          }
        }
      )
    })

    describe('iterateRows', () => {
      it('streams every row in primary-key order across batches', async () => {
        const batches: number[][] = []
        for await (const b of db.iterateRows(ns, 'users', { batchSize: 2 }))
          batches.push(b.rows.map((r) => Number(r[0])))
        expect(batches).toEqual([[1, 2], [3, 4], [5]])
      })

      it('pages a composite key with keyset comparisons and never repeats or skips rows', async () => {
        const t = `${scratch}_keyset`
        await execOk(`CREATE TABLE ${t} (a INT NOT NULL, b VARCHAR(10) NOT NULL, v INT NULL, PRIMARY KEY (a, b))`)
        const values: string[] = []
        for (let a = 1; a <= 3; a++) for (const b of ['x', 'y', 'z']) values.push(`(${a}, '${b}', ${a * 10})`)
        await execOk(`INSERT INTO ${t} (a, b, v) VALUES ${values.join(', ')}`)
        const seen: string[] = []
        let batches = 0
        for await (const batch of db.iterateRows(ns, t, { batchSize: 4 })) {
          batches++
          for (const r of batch.rows) seen.push(`${r[0]}${r[1]}`)
          expect(batch.columns.map((c) => c.name)).toEqual(['a', 'b', 'v'])
        }
        expect(batches).toBe(3)
        expect(seen).toEqual(['1x', '1y', '1z', '2x', '2y', '2z', '3x', '3y', '3z'])
        await execOk(`DROP TABLE ${t}`)
      })

      it('iterates a view (no key: single batch on MySQL, ctid-less on PostgreSQL)', async () => {
        const batches: RowBatch[] = []
        for await (const b of db.iterateRows(ns, 'active_users', { batchSize: 2 })) batches.push(b)
        const rows = batches.flatMap((b) => b.rows)
        expect(rows.length).toBeGreaterThan(0)
        expect(batches[0]?.columns.some((c) => c.name === 'name')).toBe(true)
        const insert = db.exporter.insert(ns, 'active_users', batches[0]?.columns.map((c) => c.name) ?? [], rows)
        expect(insert).toMatch(/^INSERT INTO/)
      })

      it('handles tables without a key and empty tables', async () => {
        let total = 0
        for await (const b of db.iterateRows(ns, 'no_pk', { batchSize: 3 })) total += b.rows.length
        expect(total).toBe(4)
        const empty: { columns: { name: string }[]; rows: unknown[] }[] = []
        for await (const b of db.iterateRows(ns, `${scratch}_empty`, { batchSize: 10 })) empty.push(b)
        expect(empty).toHaveLength(1)
        expect(empty[0]?.rows).toEqual([])
        expect(empty[0]?.columns.map((c) => c.name)).toEqual(['id'])
      })
    })

    describe('row identity edge cases', () => {
      it('handles a mixed-case / quoted primary key column in browse, update, iterate and DDL', async () => {
        const t = `${scratch}_camel`
        const q = (c: string) => quoteIdent(dialect, c)
        await execOk(`CREATE TABLE ${t} (${q('userId')} INT PRIMARY KEY, ${q('Name')} VARCHAR(20) NULL)`)
        await execOk(`INSERT INTO ${t} (${q('userId')}, ${q('Name')}) VALUES (1, 'a'), (2, 'b')`)
        const schema = await db.describeTable(ns, t)
        expect(schema.primaryKey).toEqual(['userId'])
        const browsed = await browseAll(t)
        expect(browsed.keyColumns).toEqual(['userId'])
        expect(await db.updateRow(ns, t, { kind: 'pk', values: { userId: 2 } }, { Name: 'B' })).toEqual({
          affectedRows: 1,
        })
        const seen: unknown[] = []
        for await (const b of db.iterateRows(ns, t, { batchSize: 1 })) seen.push(...b.rows.map((r) => r[0]))
        expect(seen).toEqual([1, 2])
        const create = await db.showCreateTable(ns, t)
        await execOk(`DROP TABLE ${t}`)
        await execOk(create.map((c) => `${c};`).join('\n'))
        expect((await db.describeTable(ns, t)).primaryKey).toEqual(['userId'])
        await execOk(`DROP TABLE ${t}`)
      })

      it.skipIf(dialect !== 'postgres')('does not treat a partial unique index as a row key', async () => {
        const t = `${scratch}_pu`
        await execOk(
          `CREATE TABLE ${t} (email TEXT NOT NULL, deleted BOOLEAN NOT NULL);
           CREATE UNIQUE INDEX ${t}_live ON ${t} (email) WHERE NOT deleted;
           INSERT INTO ${t} VALUES ('x', true), ('x', true), ('x', false), ('y', false)`
        )
        expect((await browseAll(t)).keyKind).toBe('ctid')
        let n = 0
        for await (const b of db.iterateRows(ns, t, { batchSize: 2 })) n += b.rows.length
        expect(n).toBe(4)
        await execOk(`DROP TABLE ${t}`)
      })
    })

    describe('export', () => {
      it('dump of identity / auto-increment + generated columns restores over the existing table and keeps inserting', async () => {
        const t = `${scratch}_seq`
        const idCol =
          dialect === 'mysql' ? 'id INT AUTO_INCREMENT PRIMARY KEY' : 'id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
        const expr = dialect === 'mysql' ? 'CONCAT(a, b)' : 'a || b'
        await execOk(
          `CREATE TABLE ${t} (${idCol}, a VARCHAR(10) NOT NULL, b VARCHAR(10) NOT NULL, ab VARCHAR(21) GENERATED ALWAYS AS (${expr}) STORED)`
        )
        await execOk(`INSERT INTO ${t} (a, b) VALUES ('x', 'y'), ('p', 'q')`)
        const schema = await db.describeTable(ns, t)
        const generated = new Set(schema.columns.filter((c) => /generated/i.test(c.extra)).map((c) => c.name))
        expect(generated.has('ab')).toBe(true)
        const dump = [
          `${db.exporter.dropIfExists(ns, schema)};`,
          ...(await db.showCreateTable(ns, t, schema)).map((c) => `${c};`),
        ]
        for await (const b of db.iterateRows(ns, t, { batchSize: 10, schema })) {
          const keep = b.columns.map((c, i) => (generated.has(c.name) ? -1 : i)).filter((i) => i >= 0)
          dump.push(
            db.exporter.insert(
              ns,
              t,
              keep.map((i) => b.columns[i]?.name ?? ''),
              b.rows.map((r) => keep.map((i) => r[i] ?? null)),
              { overriding: schema.columns.some((c) => c.extra === 'identity always') }
            )
          )
        }
        dump.push(...db.exporter.afterData(ns, schema))
        await execOk(dump.join('\n'))
        // Sequence advanced past the restored ids: the next insert gets id 3, not a duplicate 1.
        await execOk(`INSERT INTO ${t} (a, b) VALUES ('m', 'n')`)
        const rows = await browseAll(t)
        expect(rows.rows.map((r) => [r[0], r[3]])).toEqual([
          [1, 'xy'],
          [2, 'pq'],
          [3, 'mn'],
        ])
        await execOk(`DROP TABLE ${t}`)
      })

      it('dump (showCreateTable + iterateRows + exporter.insert) recreates the table with identical rows', async () => {
        const src = `${scratch}_dump`
        await execOk(`CREATE TABLE ${src} (id INT PRIMARY KEY, s VARCHAR(50) NULL, n INT NULL, d DATE NULL)`)
        await execOk(
          `INSERT INTO ${src} (id, s, n, d) VALUES (1, 'it''s "quoted" \\ back', 10, '2024-01-02'), (2, NULL, NULL, NULL), (3, '', 0, '1970-01-01')`
        )
        const before = await browseAll(src)
        const create = await db.showCreateTable(ns, src)
        const inserts: string[] = []
        for await (const b of db.iterateRows(ns, src, { batchSize: 2 })) {
          inserts.push(
            db.exporter.insert(
              ns,
              src,
              b.columns.map((c) => c.name),
              b.rows
            )
          )
        }
        expect(inserts).toHaveLength(2)
        await execOk(`DROP TABLE ${src}`)
        await execOk([...create.map((c) => `${c};`), ...inserts].join('\n'))
        const after = await browseAll(src)
        expect(after.rows).toEqual(before.rows)
        expect(after.columns.map((c) => c.name)).toEqual(before.columns.map((c) => c.name))
        await execOk(`DROP TABLE ${src}`)
      })
    })

    describe('showCreateTable (generated columns)', () => {
      it('round-trips a STORED generated column through the reconstructed DDL', async () => {
        const t = `${scratch}_gen`
        // CONCAT() is only STABLE on PostgreSQL (generation expressions must be IMMUTABLE); || is OR on MySQL.
        const expr = dialect === 'mysql' ? 'CONCAT(a, b)' : 'a || b'
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY, a VARCHAR(20) NOT NULL, b VARCHAR(20) NOT NULL, ab VARCHAR(41) GENERATED ALWAYS AS (${expr}) STORED)`
        )
        const create = await db.showCreateTable(ns, t)
        expect(create.join('\n')).toMatch(/GENERATED ALWAYS AS \(.*\) STORED/i)
        await execOk(`DROP TABLE ${t}`)
        await execOk(create.map((c) => `${c};`).join('\n'))
        await execOk(`INSERT INTO ${t} (id, a, b) VALUES (1, 'x', 'y')`)
        const rows = await browseAll(t)
        expect(rows.rows[0]?.[3]).toBe('xy')
        const ab = (await db.describeTable(ns, t)).columns.find((c) => c.name === 'ab')
        expect(ab?.extra.toLowerCase()).toContain('generated')
        await execOk(`DROP TABLE ${t}`)
      })
    })

    describe('listTriggers (statement-level)', () => {
      it.skipIf(dialect !== 'postgres')('decodes TRUNCATE triggers on PostgreSQL', async () => {
        const fn = `${scratch}_trg_fn`
        await execOk(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
           CREATE TRIGGER ${scratch}_trunc BEFORE TRUNCATE ON ${scratch} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`
        )
        try {
          const trg = (await db.listTriggers(ns, scratch)).find((t) => t.name === `${scratch}_trunc`)
          expect(trg).toMatchObject({ timing: 'BEFORE', events: 'TRUNCATE', orientation: 'STATEMENT' })
        } finally {
          await exec(`DROP TRIGGER IF EXISTS ${scratch}_trunc ON ${scratch}; DROP FUNCTION IF EXISTS ${fn}()`, {
            stopOnError: false,
          })
        }
      })
    })

    describe('serverInfo', () => {
      it('reports version, uptime and the connected user', async () => {
        const info = await db.serverInfo()
        expect(info.dialect).toBe(dialect)
        expect(info.version).toMatch(/^\d+\./)
        expect(info.uptimeSec === null || info.uptimeSec >= 0).toBe(true)
        expect(info.currentUser).toContain('tsmyadmin')
      })
    })

    describe('listVariables', () => {
      it('includes max_connections', async () => {
        const vars = await db.listVariables()
        const mc = vars.find((v) => v.name === 'max_connections')
        expect(mc).toBeDefined()
        expect(Number(mc?.value)).toBeGreaterThan(0)
      })
    })

    describe('listStatus', () => {
      it('returns numeric counters', async () => {
        const status = await db.listStatus()
        expect(status.length).toBeGreaterThan(5)
        expect(status.every((s) => typeof s.name === 'string' && typeof s.value === 'string')).toBe(true)
      })
    })

    describe('listProcesses', () => {
      it('lists at least this connection', async () => {
        const procs = await db.listProcesses()
        expect(procs.length).toBeGreaterThan(0)
        expect(procs.every((p) => /^\d+$/.test(p.id))).toBe(true)
        expect(procs.some((p) => p.user?.includes('tsmyadmin'))).toBe(true)
      })
    })

    describe('killProcess', () => {
      it('terminates another connection running a slow query', async () => {
        const victim = ctx.create()
        const marker = `slow_${scratch}`
        const slow = victim.executeSql(ns, `${ctx.slowSql} /* ${marker} */`, { ...EXEC, timeoutMs: 60_000 })
        let target: string | undefined
        for (let i = 0; i < 40 && !target; i++) {
          await new Promise((r) => setTimeout(r, 100))
          target = (await db.listProcesses()).find((p) => p.query?.includes(marker))?.id
        }
        expect(target).toBeDefined()
        await db.killProcess(target as string)
        const results = await slow
        expect(results[0]?.kind).toBe('error')
        await victim.close()
      })

      it('rejects non-numeric ids and unknown backends', async () => {
        await expect(db.killProcess('1; DROP TABLE users')).rejects.toMatchObject({ name: 'AdapterError' })
        await expect(db.killProcess('999999999')).rejects.toMatchObject({ name: 'AdapterError' })
      })
    })

    describe('listUsers', () => {
      it('includes the connected account with attributes', async () => {
        const users = await db.listUsers()
        const me = users.find((u) => u.name === 'tsmyadmin')
        expect(me).toBeDefined()
        expect(me?.canLogin).toBe(true)
        expect(Array.isArray(me?.attributes)).toBe(true)
        expect(dialect === 'mysql' ? me?.host : me?.host === null).toBeTruthy()
      })
    })

    describe('showGrants', () => {
      it('returns grant statements for an account', async () => {
        const me = (await db.listUsers()).find((u) => u.name === 'tsmyadmin')
        const grants = await db.showGrants({ name: 'tsmyadmin', ...(me?.host ? { host: me.host } : {}) })
        expect(grants.length).toBeGreaterThan(0)
        expect(grants.join('\n')).toMatch(
          dialect === 'mysql' ? /GRANT .* ON \*\.\* TO/ : /ALTER ROLE "tsmyadmin" SUPERUSER/
        )
      })
    })

    describe('users', () => {
      it('create → grant → password → revoke → drop through the builder', async () => {
        const name = `u_${scratch}`
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
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
          password: "s3cret'!",
          attributes: { superuser: false, createdb: false, createrole: false },
        })
        expect((await db.listUsers()).some((u) => u.name === name)).toBe(true)
        await runOp({ op: 'grantAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
        const grants = await db.showGrants(user)
        // MySQL grants are per database; PostgreSQL grants are per schema/table inside the current database.
        expect(grants.join('\n')).toContain(dialect === 'mysql' ? ns.database : (ns.schema ?? 'public'))
        if (dialect === 'postgres') {
          // Table grants are read from pg_class.relacl, so every table the role can SELECT is listed.
          expect(grants.join('\n')).toMatch(
            new RegExp(`GRANT [A-Z, ]*SELECT[A-Z, ]* ON "${ns.schema ?? 'public'}"\\."users" TO`)
          )
        }
        await runOp({ op: 'setPassword', user, password: 'changed' })
        await runOp({ op: 'revokeAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
        await runOp({ op: 'dropUser', user })
        expect((await db.listUsers()).some((u) => u.name === name)).toBe(false)
      })
    })

    describe('ddl', () => {
      it('generated DDL executes and is reflected by describeTable', async () => {
        await runDdl({
          op: 'createTable',
          table: scratchDdl,
          columns: [
            col('id', 'INT', { nullable: false }),
            col('name', 'VARCHAR(50)', { default: { kind: 'literal', value: "it's" }, comment: 'the name' }),
          ],
          primaryKey: ['id'],
        })
        let s = await db.describeTable(ns, scratchDdl)
        expect(s.columns.map((c) => c.name)).toEqual(['id', 'name'])
        expect(s.primaryKey).toEqual(['id'])
        expect(s.columns[1]).toMatchObject({ nullable: true, comment: 'the name' })
        expect(s.columns[1]?.default).toContain('it')

        await runDdl({
          op: 'addColumn',
          table: scratchDdl,
          column: col('n', 'INT', { default: { kind: 'expression', sql: '0' } }),
        })
        s = await db.describeTable(ns, scratchDdl)
        expect(s.columns.map((c) => c.name)).toEqual(['id', 'name', 'n'])
        expect(s.columns[2]?.default).toBe('0')

        await runDdl({
          op: 'modifyColumn',
          table: scratchDdl,
          name: 'n',
          column: col('n2', 'BIGINT', { nullable: false, default: { kind: 'expression', sql: '1' } }),
        })
        s = await db.describeTable(ns, scratchDdl)
        expect(s.columns.map((c) => c.name)).toEqual(['id', 'name', 'n2'])
        expect(s.columns[2]).toMatchObject({ nullable: false })
        expect(s.columns[2]?.dataType.toLowerCase()).toContain('bigint')

        await runDdl({
          op: 'addIndex',
          table: scratchDdl,
          name: `${scratchDdl}_name_idx`,
          columns: ['name'],
          unique: true,
        })
        s = await db.describeTable(ns, scratchDdl)
        expect(s.indexes.find((i) => i.name === `${scratchDdl}_name_idx`)).toMatchObject({
          unique: true,
          columns: ['name'],
        })

        await runDdl({ op: 'dropIndex', table: scratchDdl, name: `${scratchDdl}_name_idx` })
        s = await db.describeTable(ns, scratchDdl)
        expect(s.indexes.some((i) => i.name === `${scratchDdl}_name_idx`)).toBe(false)

        await runDdl({ op: 'dropColumn', table: scratchDdl, name: 'n2' })
        s = await db.describeTable(ns, scratchDdl)
        expect(s.columns.map((c) => c.name)).toEqual(['id', 'name'])

        await db.insertRow(ns, scratchDdl, { id: 1, name: 'x' })
        expect((await browseAll(scratchDdl)).total).toBe(1)
        await runDdl({ op: 'truncateTable', table: scratchDdl })
        expect((await browseAll(scratchDdl)).total).toBe(0)

        const renamed = `${scratchDdl}_rn`
        await runDdl({ op: 'renameTable', table: scratchDdl, newName: renamed })
        expect((await db.describeTable(ns, renamed)).columns.map((c) => c.name)).toEqual(['id', 'name'])
        await expect(db.describeTable(ns, scratchDdl)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await runDdl({ op: 'renameTable', table: renamed, newName: scratchDdl })

        await runDdl({ op: 'dropTable', table: scratchDdl })
        await expect(db.describeTable(ns, scratchDdl)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('copies a table with and without data', async () => {
        const copy = `${scratch}_copy`
        await runDdl({ op: 'copyTable', table: scratch, newName: copy, withData: true })
        const src = await browseAll(scratch)
        const dst = await browseAll(copy)
        expect(dst.columns.map((c) => c.name)).toEqual(src.columns.map((c) => c.name))
        expect(dst.total).toBe(src.total)
        expect((await db.describeTable(ns, copy)).primaryKey).toEqual(['id'])
        await execOk(`DROP TABLE ${copy}`)
        await runDdl({ op: 'copyTable', table: scratch, newName: copy, withData: false })
        expect((await browseAll(copy)).total).toBe(0)
        await execOk(`DROP TABLE ${copy}`)
      })

      it('creates and drops a database, and a schema on PostgreSQL', async () => {
        const name = `${scratch}_tmpdb`
        await runDdl({ op: 'createDatabase', name })
        expect((await db.listDatabases()).map((d) => d.name)).toContain(name)
        await runDdl({ op: 'dropDatabase', name })
        expect((await db.listDatabases()).map((d) => d.name)).not.toContain(name)
        if (dialect === 'postgres') {
          const schemaName = `${scratch}_tmpschema`
          await runDdl({ op: 'createSchema', name: schemaName })
          expect(await db.listSchemas(ns.database)).toContain(schemaName)
          await execOk(`DROP SCHEMA ${schemaName}`)
        }
      })
    })

    describe('permission errors', () => {
      it('maps insufficient privileges to PERMISSION_DENIED for a read-only account', async () => {
        const name = `ro_${scratch}`
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
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
          expect((await ro.browseRows(ns, 'users', { offset: 0, limit: 1, sort: [], filters: [] })).rows).toHaveLength(
            1
          )
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

    describe('close', () => {
      it('is idempotent and releases the pool', async () => {
        const tmp = ctx.create()
        await tmp.ping()
        await expect(tmp.close()).resolves.toBeUndefined()
        await expect(tmp.close()).resolves.toBeUndefined()
      })
    })
  })
}
