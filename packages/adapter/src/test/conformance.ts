import type { Cell, ColumnSpec, DdlOp, Dialect, Namespace, RowKey, StatementResult } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mysqlAccount } from '../mysql/users.ts'
import { isGeneratedColumn } from '../sql/export.ts'
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
    `${scratch}_seq2`,
    `${scratch}_like`,
    `${scratch}_fk`,
    `${scratch}_typedkey`,
    `${scratch}_enumkey`,
    `${scratch}_bigkey`,
    `${scratch}_bitkey`,
    `${scratch}_trg`,
    `${scratch}_sqt`,
    `${scratch}_sq`,
    `${scratch}_cons_child`,
    `${scratch}_part`,
    `${scratch}_fkopts`,
    `${scratch}_inh_kid`,
    `${scratch}_parent`,
    `${scratch}_cons`,
    `${scratch}_dep_t`,
    `${scratch}_bulk_a`,
    `${scratch}_bulk_b`,
    `${scratch}_nokey`,
    `${scratch}_inh_child`,
    `${scratch}_inh`,
    `${scratch}_seqmin_copy`,
    `${scratch}_seqmin`,
    `${scratch}_ser`,
    `${scratch}_bin`,
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
      if (dialect === 'postgres') await exec(`DROP TYPE IF EXISTS ${scratch}_enumkey_e`, { stopOnError: false })
      // The users test creates this account; a failure half-way must not leave it behind.
      await exec(dialect === 'mysql' ? `DROP USER IF EXISTS 'u_${scratch}'@'%'` : `DROP ROLE IF EXISTS u_${scratch}`, {
        stopOnError: false,
      })
      await db.close()
    })

    /** MariaDB answers the MySQL adapter; a few server behaviours differ (see the MariaDB notes in adapter.md). */
    const isMariaDb = async () => dialect === 'mysql' && /mariadb/i.test((await db.serverInfo()).version)

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

    describe('listDependencies', () => {
      it('reports what a view reads from the catalog, or null where the server has none (MariaDB)', async () => {
        const t = `${scratch}_dep_t`
        const v1 = `${scratch}_dep_v1`
        const v2 = `${scratch}_dep_v2`
        try {
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
          // v1's alias equals v2's name: a text scan would see a dependency the wrong way round.
          await execOk(`CREATE VIEW ${v1} AS SELECT id AS ${v2} FROM ${t}`)
          await execOk(`CREATE VIEW ${v2} AS SELECT ${v2} FROM ${v1}`)
          const deps = await db.listDependencies(ns)
          if (deps === null) {
            expect(await isMariaDb()).toBe(true)
            return
          }
          const of = (name: string) => deps.find((d) => d.kind === 'view' && d.name === name)?.dependsOn ?? []
          expect(of(v2)).toContainEqual({ kind: 'view', name: v1 })
          expect(of(v2)).not.toContainEqual({ kind: 'view', name: v2 })
          expect(of(v1)).toContainEqual({ kind: 'table', name: t })
          expect(of(v1)).not.toContainEqual({ kind: 'view', name: v2 })
        } finally {
          await exec(`DROP VIEW IF EXISTS ${v2}; DROP VIEW IF EXISTS ${v1}; DROP TABLE IF EXISTS ${t}`, {
            stopOnError: false,
          })
        }
      })

      it.skipIf(dialect !== 'postgres')(
        'records what a SQL-standard-body routine reads and a row-type signature (PostgreSQL)',
        async () => {
          const t = `${scratch}_dep_t`
          const v = `${scratch}_dep_v1`
          const f = `${scratch}_dep_f`
          const g = `${scratch}_dep_g`
          try {
            await execOk(
              `CREATE TABLE ${t} (id INT PRIMARY KEY); CREATE VIEW ${v} AS SELECT id FROM ${t};
               CREATE FUNCTION ${f}() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM ${v}; END;
               CREATE FUNCTION ${g}(xs ${t}[]) RETURNS SETOF ${t} LANGUAGE sql AS $$ SELECT * FROM ${t} $$`
            )
            const deps = (await db.listDependencies(ns)) ?? []
            const of = (name: string) => deps.find((d) => d.kind === 'routine' && d.name === name)?.dependsOn
            expect(of(f)).toContainEqual({ kind: 'view', name: v })
            // A string body records nothing, but its signature depends on the table's row type (array included).
            expect(of(g)).toContainEqual({ kind: 'table', name: t })
          } finally {
            await exec(
              `DROP FUNCTION IF EXISTS ${g}(${t}[]); DROP FUNCTION IF EXISTS ${f}(); DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`,
              { stopOnError: false }
            )
          }
        }
      )
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

      it('applies text filters to non-text columns (numbers, dates) too', async () => {
        const r = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'id', op: 'starts_with', value: '1' }],
        })
        expect(r.rows.map((x) => x[0])).toEqual([1])
        const d = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'created_at', op: 'contains', value: '2024-01-02' }],
        })
        expect(d.rows).toHaveLength(1)
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

      it('matches keys typed FLOAT / DECIMAL / JSON as the column, not as a text or double literal', async () => {
        const t = `${scratch}_typedkey`
        const json = dialect === 'mysql' ? 'JSON' : 'JSONB'
        await execOk(`CREATE TABLE ${t} (f FLOAT NOT NULL, d DECIMAL(20, 4) NOT NULL, j ${json} NOT NULL, v INT NULL)`)
        await execOk(
          `INSERT INTO ${t} (f, d, j, v) VALUES (0.1, 1234567890123456.7891, '{"a": 1, "b": [true, null]}', 1)`
        )
        // Browse filters compare as the column type as well: the value the grid shows must match its own row.
        const filtered = await db.browseRows(ns, t, {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'f', op: 'eq', value: 0.1 }],
        })
        expect(filtered.rows).toHaveLength(1)
        // No primary key: PostgreSQL addresses the row by ctid, MySQL by every column (each one typed).
        const before = await browseAll(t)
        const row = before.rows[0]
        if (!row) throw new Error('row missing')
        const key: RowKey =
          dialect === 'postgres'
            ? { kind: 'ctid', value: String(row.at(-1)) }
            : { kind: 'all-columns', values: { f: row[0] ?? null, d: row[1] ?? null, j: row[2] ?? null, v: 1 } }
        expect(await db.updateRow(ns, t, key, { v: 2 })).toEqual({ affectedRows: 1 })
        // The same values as a composite "primary key" (FLOAT 0.1 ≠ DOUBLE 0.1 unless cast).
        await execOk(`ALTER TABLE ${t} ADD PRIMARY KEY (f, d)`)
        const pk: RowKey = { kind: 'pk', values: { f: row[0] ?? null, d: row[1] ?? null } }
        expect(await db.updateRow(ns, t, pk, { v: 3 })).toEqual({ affectedRows: 1 })
        expect((await browseAll(t)).rows[0]?.[3]).toBe(3)
        // Keyset paging over a FLOAT key must not re-read the last row of each batch.
        await execOk(`INSERT INTO ${t} (f, d, j, v) VALUES (0.2, 1, '{}', 4), (0.3, 1, '{}', 5)`)
        const seen: number[] = []
        for await (const b of db.iterateRows(ns, t, { batchSize: 1 })) for (const r of b.rows) seen.push(Number(r[3]))
        expect(seen).toEqual([3, 4, 5])
        expect(await db.deleteRows(ns, t, [pk])).toEqual({ affectedRows: 1 })
        await execOk(`DROP TABLE ${t}`)
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

      it.skipIf(dialect !== 'mysql')(
        'keeps placeholder values safe under a global NO_BACKSLASH_ESCAPES (MySQL)',
        async () => {
          // The driver escapes values with backslashes; a server running that mode would read them differently.
          // The adapter strips the flag from every session it sets up (including after a connection reset, which
          // reloads the global value), so a quote in a filter value still matches — and only matches.
          const original = await execOk('SELECT @@GLOBAL.sql_mode')
          const globalMode = String(original[0]?.kind === 'rows' ? original[0].result.rows[0]?.[0] : '')
          await execOk("SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',NO_BACKSLASH_ESCAPES')")
          try {
            await execOk('SELECT 1') // the finally-reset re-reads the global mode into this pooled session
            await execOk(`INSERT INTO ${scratch} (id, name) VALUES (77, 'o''brien')`)
            const hit = await db.browseRows(ns, scratch, {
              offset: 0,
              limit: 10,
              sort: [],
              filters: [{ column: 'name', op: 'eq', value: "o'brien" }],
            })
            expect(hit.rows.map((r) => r[0])).toEqual([77])
            const miss = await db.browseRows(ns, scratch, {
              offset: 0,
              limit: 10,
              sort: [],
              filters: [{ column: 'name', op: 'eq', value: "o\\'brien" }],
            })
            expect(miss.rows).toEqual([])
            expect(await db.deleteRows(ns, scratch, [{ kind: 'pk', values: { id: 77 } }])).toEqual({ affectedRows: 1 })
          } finally {
            await execOk(`SET GLOBAL sql_mode = '${globalMode}'`)
          }
        }
      )

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
          nativeCode:
            dialect === 'mysql' ? ((await isMariaDb()) ? 'ER_STATEMENT_TIMEOUT' : 'ER_QUERY_TIMEOUT') : '57014',
        })
      })

      it('caps a plain SELECT at maxRows + 1 rows server-side and marks it truncated', async () => {
        // Every row sleeps 50 ms: 1,000 rows take 50 s unless the server stops at the wrapper's LIMIT
        // (a client-side slice would time out). A leading comment (how pasted scripts usually start) must
        // not defeat the cap.
        const big = `-- leading comment\n${
          dialect === 'mysql'
            ? `SELECT u1.id, SLEEP(0.05) FROM ${Array.from({ length: 5 }, (_, i) => `users u${i + 1}`).join(', ')}`
            : 'SELECT i, pg_sleep(0.05) FROM generate_series(1, 1000) AS g(i)'
        }`
        const started = Date.now()
        const results = await exec(big, { maxRows: 5, timeoutMs: 5000 })
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
        // A syntax error refers to the statement as typed: the position (PostgreSQL) stays inside it and the
        // message (MySQL re-runs the bare statement) never mentions the wrapper.
        const bad = await exec('SELECT id FROM users WHERE ORDER', { stopOnError: false })
        expect(bad[0]?.kind).toBe('error')
        if (bad[0]?.kind === 'error') {
          expect(bad[0].message).not.toContain('_tsmyadmin')
          if (dialect === 'postgres') expect(bad[0].position).toBeDefined()
          if (bad[0].position !== undefined) {
            expect(bad[0].position).toBeLessThanOrEqual('SELECT id FROM users WHERE ORDER'.length)
          }
        }
        // ORDER BY of a plain read is kept under the cap (MariaDB drops it inside a merged derived table).
        const ordered = await exec('SELECT id FROM users ORDER BY id DESC', { maxRows: 3 })
        expect(ordered[0]).toMatchObject({ kind: 'rows', result: { rows: [[5], [4], [3]], truncated: true } })
        // A LIMIT above the cap does not lift it (MySQL's own LIMIT would override sql_select_limit), nor does a
        // script that resets the session cap itself; the order of an explicit LIMIT query survives the wrap.
        // MySQL materialises a derived table that has a LIMIT, so the guard there is about the process memory
        // (the server keeps the 390,625-row temp table, the API receives maxRows + 1), not about time.
        const bigLimit = await exec(
          dialect === 'mysql'
            ? `SELECT u1.id FROM ${Array.from({ length: 8 }, (_, i) => `users u${i + 1}`).join(', ')} LIMIT 1000000`
            : 'SELECT i, pg_sleep(0.05) FROM generate_series(1, 1000) AS g(i) LIMIT 1000',
          { maxRows: 5, timeoutMs: 5000 }
        )
        expect(bigLimit[0]).toMatchObject({ kind: 'rows', result: { truncated: true } })
        if (bigLimit[0]?.kind === 'rows') expect(bigLimit[0].result.rows).toHaveLength(5)
        if (dialect === 'mysql') {
          // Observable server-side: the bytes the connection sent for a wide LIMIT query stay small (the same
          // connection serves both statements of a script).
          const wide = await exec(
            `SELECT REPEAT('x', 4096) AS w FROM users u1, users u2, users u3, users u4, users u5, users u6 LIMIT 100000; SHOW SESSION STATUS LIKE 'Bytes_sent'`,
            { maxRows: 5, timeoutMs: 10_000 }
          )
          const sent = Number(wide[1]?.kind === 'rows' ? wide[1].result.rows[0]?.[1] : Number.NaN)
          expect(sent).toBeLessThan(1_000_000) // unwrapped: 15,625 rows × 4 KB ≈ 64 MB
        }
        const orderedLimit = await exec('SELECT id FROM users ORDER BY id DESC LIMIT 100', { maxRows: 3 })
        expect(orderedLimit[0]).toMatchObject({ kind: 'rows', result: { rows: [[5], [4], [3]], truncated: true } })
        if (dialect === 'mysql') {
          const reset = await exec(
            'SET SESSION sql_select_limit = DEFAULT; SELECT u1.id, SLEEP(0.05) FROM users u1, users u2, users u3, users u4, users u5',
            { maxRows: 5, timeoutMs: 5000 }
          )
          expect(reset[1]).toMatchObject({ kind: 'rows', result: { truncated: true } })
        }
        // A literal that merely mentions DML is still a read: the cap applies (unwrapped, 3,125 sleeping rows
        // would take minutes).
        const literal =
          dialect === 'mysql'
            ? `SELECT u1.id, SLEEP(0.05) FROM users u1, users u2, users u3, users u4, users u5 WHERE 'delete' <> 'update'`
            : "SELECT i, pg_sleep(0.05) FROM generate_series(1, 1000) AS g(i) WHERE 'delete' <> 'update'"
        const capped = await exec(literal, { maxRows: 5, timeoutMs: 5000 })
        expect(capped[0]).toMatchObject({ kind: 'rows', result: { truncated: true } })
        // MySQL modifiers valid only at the top level make the wrapper fall back to the bare statement.
        if (dialect === 'mysql') {
          const calc = await exec('SELECT SQL_CALC_FOUND_ROWS id FROM users LIMIT 1; SELECT FOUND_ROWS() AS n', {
            maxRows: 5,
          })
          expect(calc.map((r) => r.kind)).toEqual(['rows', 'rows'])
          if (calc[1]?.kind === 'rows') expect(Number(calc[1].result.rows[0]?.[0])).toBeGreaterThan(1)
        }
        // Joins with duplicate column names still return rows (MySQL cannot wrap those; PostgreSQL can).
        const dupJoin = await exec('SELECT * FROM users u JOIN posts p ON p.user_id = u.id', { maxRows: 2 })
        expect(dupJoin[0]).toMatchObject({ kind: 'rows', result: { truncated: true } })
      })

      it('runs reads with trailing comments and data-modifying CTEs unchanged', async () => {
        const tail = await execOk('SELECT id FROM users WHERE id = 1 -- all users')
        expect(tail[0]?.kind === 'rows' ? tail[0].result.rows : null).toEqual([[1]])
        // MariaDB has no WITH ... UPDATE form; a CTE inside the assignment exercises the same "not wrapped" path.
        const cte = await execOk(
          dialect === 'postgres'
            ? 'WITH d AS (UPDATE users SET name = name WHERE id = -1 RETURNING id) SELECT count(*) FROM d'
            : (await isMariaDb())
              ? "UPDATE users SET name = (WITH c AS (SELECT 'x' AS n) SELECT n FROM c) WHERE id = -1"
              : 'WITH c AS (SELECT 1 AS one) UPDATE users, c SET name = name WHERE id = -1'
        )
        expect(cte[0]?.kind).not.toBe('error')
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

      it('shares one cancel between concurrent requests for the same run', async () => {
        const before = (await db.listProcesses()).length
        const queryId = crypto.randomUUID()
        const run = db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
        // A burst of cancel clicks must not become a burst of dedicated connections against the server:
        // sampled while the burst is in progress, the server sees at most one extra session.
        const burst = Array.from({ length: 25 }, () => db.cancelQuery(queryId))
        await new Promise((resolve) => setTimeout(resolve, 30))
        const during = (await db.listProcesses()).length
        const results = await Promise.all(burst)
        expect(results.every((r) => r)).toBe(true)
        expect(during).toBeLessThanOrEqual(before + 3)
        expect((await run)[0]?.kind).toBe('error')
        // The cancel connection is closed again: the server sees no lingering sessions from the burst.
        expect((await db.listProcesses()).length).toBeLessThanOrEqual(before + 2)
      })

      it('cancels reliably even when the cancel reaches the server before the statement does', async () => {
        // The backend id is known before the statement is sent; a cancel landing on the idle connection is a
        // no-op on every server, so cancelQuery must keep re-sending it while the statement is in flight.
        for (let i = 0; i < 8; i++) {
          const queryId = crypto.randomUUID()
          const started = Date.now()
          const run = db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
          expect(await db.cancelQuery(queryId)).toBe(true)
          const results = await run
          expect(results[0]?.kind).toBe('error')
          expect(Date.now() - started).toBeLessThan(10_000)
        }
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
        'keeps CHECK / UNIQUE constraints, deferrable keys, collations, identity options and matview indexes (PostgreSQL)',
        async () => {
          const t = `${scratch}_cons`
          const c = `${scratch}_cons_child`
          const mv = `${scratch}_cons_mv`
          await execOk(
            `CREATE TABLE ${t} (id INT GENERATED BY DEFAULT AS IDENTITY (START WITH 1000 INCREMENT BY 10 CACHE 5) PRIMARY KEY,
               code TEXT COLLATE "C" NOT NULL, n INT CHECK (n BETWEEN 1 AND 100), CONSTRAINT ${t}_code_key UNIQUE (code));
             CREATE TABLE ${c} (id INT PRIMARY KEY, parent INT REFERENCES ${t} (id) DEFERRABLE INITIALLY DEFERRED);
             CREATE MATERIALIZED VIEW ${mv} AS SELECT id FROM ${t}; CREATE UNIQUE INDEX ${mv}_idx ON ${mv} (id)`
          )
          try {
            const parent = (await db.showCreateTable(ns, t)).join('\n')
            expect(parent).toContain('GENERATED BY DEFAULT AS IDENTITY (START WITH 1000 INCREMENT BY 10 CACHE 5)')
            expect(parent).toContain('COLLATE "C"')
            expect(parent).toMatch(/ADD CONSTRAINT "[^"]+" CHECK \(+n >= 1\)+ AND \(+n <= 100\)+/)
            expect(parent).toContain(`ADD CONSTRAINT "${t}_code_key" UNIQUE (code)`)
            // The constraint creates its index: no separate CREATE UNIQUE INDEX for it.
            expect(parent).not.toContain(`CREATE UNIQUE INDEX "${t}_code_key"`)
            const child = (await db.showCreateTable(ns, c)).join('\n')
            // pg_get_constraintdef text: unquoted plain names, MATCH / actions / DEFERRABLE / NOT VALID kept.
            expect(child).toMatch(/FOREIGN KEY \(parent\) REFERENCES [^\n]* DEFERRABLE INITIALLY DEFERRED$/m)
            const view = (await db.showCreateTable(ns, mv)).join('\n')
            expect(view).toContain(`CREATE UNIQUE INDEX ${mv}_idx ON`)
          } finally {
            await execOk(`DROP MATERIALIZED VIEW ${mv}; DROP TABLE ${c}; DROP TABLE ${t}`)
          }
        }
      )

      it.skipIf(dialect !== 'postgres')(
        'keeps FK options, UNLOGGED / storage parameters, inheritance and partitions (PostgreSQL)',
        async () => {
          const p = `${scratch}_parent`
          const ch = `${scratch}_inh_kid`
          const fk = `${scratch}_fkopts`
          const part = `${scratch}_part`
          await execOk(
            `CREATE UNLOGGED TABLE ${p} (a INT, b INT, PRIMARY KEY (a, b), CHECK (a > 0)) WITH (fillfactor = 70);
             CREATE TABLE ${ch} (extra TEXT) INHERITS (${p});
             CREATE UNLOGGED TABLE ${fk} (id INT PRIMARY KEY, a INT DEFAULT 1, b INT DEFAULT 1);
             ALTER TABLE ${fk} ADD CONSTRAINT ${fk}_ab FOREIGN KEY (a, b) REFERENCES ${p} (a, b) MATCH FULL ON DELETE SET DEFAULT ON UPDATE SET NULL NOT VALID;
             CREATE TABLE ${part} (id INT, d DATE) PARTITION BY RANGE (d);
             CREATE TABLE ${part}_2024 PARTITION OF ${part} FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
             CREATE TABLE ${part}_rest PARTITION OF ${part} DEFAULT`
          )
          try {
            const parent = (await db.showCreateTable(ns, p)).join('\n')
            expect(parent).toContain(`CREATE UNLOGGED TABLE "public"."${p}"`)
            expect(parent).toContain("WITH (fillfactor='70')")
            expect((await db.describeTable(ns, ch)).inherits).toEqual([p])
            const child = (await db.showCreateTable(ns, ch)).join('\n')
            expect(child).toContain(`INHERITS (public.${p})`)
            // The inherited CHECK belongs to the parent: not repeated on the child.
            expect(child).not.toContain('CHECK')
            const opts = (await db.showCreateTable(ns, fk)).join('\n')
            expect(opts).toContain('MATCH FULL ON UPDATE SET NULL ON DELETE SET DEFAULT NOT VALID')
            const partitioned = await db.showCreateTable(ns, part)
            expect(partitioned[0]).toContain('PARTITION BY RANGE (d)')
            expect(partitioned).toContainEqual(
              `CREATE TABLE "public"."${part}_2024" PARTITION OF "public"."${part}" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`
            )
            expect(partitioned).toContainEqual(
              `CREATE TABLE "public"."${part}_rest" PARTITION OF "public"."${part}" DEFAULT`
            )
            // Partitions are not tables of their own in the listing (their rows come through the parent).
            expect((await db.listTables(ns)).map((x) => x.name)).not.toContain(`${part}_2024`)
          } finally {
            await execOk(`DROP TABLE ${part}; DROP TABLE ${fk}; DROP TABLE ${ch}; DROP TABLE ${p}`)
          }
        }
      )

      it.skipIf(dialect !== 'mysql')('dumps a MariaDB package as its specification and body', async () => {
        if (!(await isMariaDb())) return
        const p = `${scratch}_pkg`
        // Package bodies hold `;`: created through a DELIMITER block, as a dump would.
        await execOk(
          [
            'SET SESSION sql_mode = ORACLE;',
            'DELIMITER $$',
            `CREATE OR REPLACE PACKAGE ${p} AS FUNCTION f RETURN INT; END$$`,
            `CREATE OR REPLACE PACKAGE BODY ${p} AS FUNCTION f RETURN INT AS BEGIN RETURN 1; END; END$$`,
            'DELIMITER ;',
          ].join('\n')
        )
        try {
          const kinds = (await db.listRoutines(ns)).filter((r) => r.name === p).map((r) => r.kind)
          expect(kinds).toEqual(['package', 'package body'])
          expect(await db.routineDefinition(ns, p, 'package')).toMatch(/^CREATE .*PACKAGE/)
          expect(await db.routineDefinition(ns, p, 'package body')).toMatch(/^CREATE .*PACKAGE BODY/)
        } finally {
          await execOk(`DROP PACKAGE ${p}`)
        }
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

      it.skipIf(dialect !== 'mysql')(
        'dumps a MariaDB sequence as a sequence and keeps table defaults database-relative',
        async () => {
          if (!(await isMariaDb())) return
          const seq = `${scratch}_sq`
          const t = `${scratch}_sqt`
          await execOk(
            `CREATE SEQUENCE ${seq} START WITH 100; CREATE TABLE ${t} (id INT NOT NULL DEFAULT NEXTVAL(${seq}) PRIMARY KEY)`
          )
          await execOk(`INSERT INTO ${t} () VALUES ()`)
          const listed = await db.listTables(ns)
          expect(listed.find((x) => x.name === seq)?.kind).toBe('sequence')
          const create = await db.showCreateTable(ns, seq)
          expect(create[0]).toMatch(/^CREATE SEQUENCE/)
          // next_not_cached_value: past the value handed out (the cache size decides by how far).
          expect(Number(/RESTART WITH (\d+)$/.exec(create[1] ?? '')?.[1])).toBeGreaterThanOrEqual(101)
          // The table default names the sequence without the database, so the dump restores anywhere.
          expect((await db.showCreateTable(ns, t)).join('\n')).not.toContain(`nextval(\`${ns.database}\``)
          await execOk(`DROP TABLE ${t}; DROP SEQUENCE ${seq}`)
        }
      )

      it.skipIf(dialect !== 'mysql')(
        'lists triggers in execution order so a dump recreates FOLLOWS / PRECEDES',
        async () => {
          const t = `${scratch}_trg`
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, n INT NOT NULL DEFAULT 0)`)
          await execOk(`CREATE TRIGGER ${t}_a BEFORE INSERT ON ${t} FOR EACH ROW SET NEW.n = NEW.n + 1`)
          await execOk(
            `CREATE TRIGGER ${t}_0 BEFORE INSERT ON ${t} FOR EACH ROW PRECEDES ${t}_a SET NEW.n = NEW.n * 10`
          )
          const names = (await db.listTriggers(ns, t)).map((x) => x.name)
          expect(names).toEqual([`${t}_0`, `${t}_a`])
          await execOk(`DROP TABLE ${t}`)
        }
      )

      it.skipIf(dialect !== 'mysql')('pages, updates and filters a BIT-keyed table (MySQL / MariaDB)', async () => {
        const t = `${scratch}_bitkey`
        await execOk(`CREATE TABLE ${t} (b BIT(8) NOT NULL PRIMARY KEY, v INT NOT NULL)`)
        await execOk(
          `INSERT INTO ${t} (b, v) VALUES (b'00000000', 0), (b'00000001', 1), (b'00100111', 39), (b'10000000', 128)`
        )
        const seen: number[] = []
        for await (const batch of db.iterateRows(ns, t, { batchSize: 1 }))
          for (const r of batch.rows) seen.push(Number(r[1]))
        expect(seen).toEqual([0, 1, 39, 128])
        const rows = await browseAll(t)
        const key = rows.rows.find((r) => r[1] === 128)?.[0] ?? null
        expect(await db.updateRow(ns, t, { kind: 'pk', values: { b: key } }, { v: 129 })).toEqual({ affectedRows: 1 })
        const hit = await db.browseRows(ns, t, {
          offset: 0,
          limit: 10,
          sort: [],
          filters: [{ column: 'b', op: 'eq', value: key }],
        })
        expect(hit.rows.map((r) => r[1])).toEqual([129])
        await execOk(`DROP TABLE ${t}`)
      })

      it('pages a composite key with BIGINT values beyond 2^53 exactly', async () => {
        const t = `${scratch}_bigkey`
        await execOk(`CREATE TABLE ${t} (id BIGINT NOT NULL, n INT NOT NULL, PRIMARY KEY (id, n))`)
        await execOk(
          `INSERT INTO ${t} (id, n) VALUES (9223372036854775806, 1), (9223372036854775807, 1), (9223372036854775806, 2), (9007199254740993, 1), (9007199254740992, 1)`
        )
        const seen: string[] = []
        for await (const b of db.iterateRows(ns, t, { batchSize: 1 }))
          for (const r of b.rows) seen.push(`${r[0]}/${r[1]}`)
        expect(seen).toEqual([
          '9007199254740992/1',
          '9007199254740993/1',
          '9223372036854775806/1',
          '9223372036854775806/2',
          '9223372036854775807/1',
        ])
        await execOk(`DROP TABLE ${t}`)
      })

      it('pages an ENUM key in a total order that agrees with the keyset comparison', async () => {
        // Labels that differ only by case: a case-insensitive comparison would make them tie and skip one.
        const t = `${scratch}_enumkey`
        if (dialect === 'postgres') await execOk(`CREATE TYPE ${t}_e AS ENUM ('zeta', 'alpha', 'Alpha', 'mid')`)
        const type = dialect === 'mysql' ? "ENUM('zeta', 'alpha', 'Alpha', 'mid') COLLATE utf8mb4_bin" : `${t}_e`
        await execOk(`CREATE TABLE ${t} (e ${type} NOT NULL PRIMARY KEY, n INT NOT NULL)`)
        await execOk(`INSERT INTO ${t} (e, n) VALUES ('zeta', 1), ('alpha', 2), ('Alpha', 4), ('mid', 3)`)
        const seen: string[] = []
        for await (const b of db.iterateRows(ns, t, { batchSize: 1 })) for (const r of b.rows) seen.push(String(r[0]))
        expect([...seen].sort()).toEqual(['Alpha', 'alpha', 'mid', 'zeta'])
        expect(seen).toHaveLength(4)
        await execOk(`DROP TABLE ${t}`)
        if (dialect === 'postgres') await execOk(`DROP TYPE ${t}_e`)
      })

      it('leaves the connection clean when the consumer stops early', async () => {
        const it = db.iterateRows(ns, 'users', { batchSize: 2 })[Symbol.asyncIterator]()
        expect((await it.next()).done).toBe(false)
        await it.return?.(undefined)
        // The same pooled connection must serve a full export afterwards (no open cursor / transaction).
        let total = 0
        for await (const b of db.iterateRows(ns, 'users', { batchSize: 2 })) total += b.rows.length
        expect(total).toBe(5)
        if (dialect === 'postgres') {
          // A leaked transaction is stale; an export in flight elsewhere (between FETCHes) is fresh.
          const idle = await execOk(
            "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND xact_start < now() - interval '2 seconds'"
          )
          expect(Number(idle[0]?.kind === 'rows' ? idle[0].result.rows[0]?.[0] : -1)).toBe(0)
        }
      })

      it('exports every row of a key-less table exactly once across many batches', async () => {
        const t = `${scratch}_nokey`
        await execOk(`CREATE TABLE ${t} (a INT NOT NULL, b VARCHAR(10) NULL)`)
        const values = Array.from({ length: 1200 }, (_, i) => `(${i}, 'v${i}')`)
        await execOk(`INSERT INTO ${t} (a, b) VALUES ${values.join(', ')}`)
        const seen: number[] = []
        for await (const batch of db.iterateRows(ns, t, { batchSize: 7 }))
          for (const r of batch.rows) seen.push(Number(r[0]))
        expect(seen).toHaveLength(1200)
        expect(new Set(seen).size).toBe(1200)
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

    describe.skipIf(dialect !== 'postgres')('partitioned tables', () => {
      it('is read-only without a key and exports every row exactly once', async () => {
        const t = `${scratch}_part`
        await execOk(
          `CREATE TABLE ${t} (id INT NOT NULL, region TEXT NOT NULL) PARTITION BY LIST (region);
           CREATE TABLE ${t}_a PARTITION OF ${t} FOR VALUES IN ('a');
           CREATE TABLE ${t}_b PARTITION OF ${t} FOR VALUES IN ('b');
           INSERT INTO ${t} SELECT i, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END FROM generate_series(1, 10) i`
        )
        try {
          expect((await db.describeTable(ns, t)).partitioned).toBe(true)
          expect((await browseAll(t)).keyKind).toBe('none')
          let n = 0
          for await (const b of db.iterateRows(ns, t, { batchSize: 3 })) n += b.rows.length
          expect(n).toBe(10)
          // Partitions are implementation detail: not listed (and therefore not dumped twice).
          expect((await db.listTables(ns)).map((x) => x.name)).not.toContain(`${t}_a`)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })
    })

    describe('binary values', () => {
      it('caps binaries when browsing but exports them whole', async () => {
        const t = `${scratch}_bin`
        const binType = dialect === 'mysql' ? 'LONGBLOB' : 'BYTEA'
        const big = dialect === 'mysql' ? "REPEAT('x', 70000)" : "decode(repeat('78', 70000), 'hex')"
        const bytes = (cell: Cell): number => (isBinaryCell(cell) ? Buffer.from(cell.$bin, 'base64').length : -1)
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, b ${binType} NULL)`)
        await execOk(`INSERT INTO ${t} (id, b) VALUES (1, ${big})`)
        expect(bytes((await browseAll(t)).rows[0]?.[1] ?? null)).toBe(64 * 1024)
        let exported: Cell = null
        for await (const b of db.iterateRows(ns, t, { batchSize: 10 })) exported = b.rows[0]?.[1] ?? null
        expect(bytes(exported)).toBe(70000)
        await execOk(`DROP TABLE ${t}`)
      })
    })

    describe('export', () => {
      it('dump of identity / auto-increment + generated columns restores over the existing table and keeps inserting', async () => {
        const t = `${scratch}_seq`
        const idCol =
          dialect === 'mysql' ? 'id INT AUTO_INCREMENT PRIMARY KEY' : 'id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
        const expr = dialect === 'mysql' ? 'CONCAT(a, b)' : 'a || b'
        // `at` has an expression default (MySQL reports it as EXTRA = DEFAULT_GENERATED): a regular column whose
        // stored values must survive the dump, unlike the generated `ab`.
        await execOk(
          `CREATE TABLE ${t} (${idCol}, a VARCHAR(10) NOT NULL, b VARCHAR(10) NOT NULL, ab VARCHAR(21) GENERATED ALWAYS AS (${expr}) STORED, at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`
        )
        await execOk(
          `INSERT INTO ${t} (a, b, at) VALUES ('x', 'y', '2001-02-03 04:05:06'), ('p', 'q', '2002-03-04 05:06:07')`
        )
        const schema = await db.describeTable(ns, t)
        const generated = new Set(schema.columns.filter((c) => isGeneratedColumn(c.extra)).map((c) => c.name))
        expect([...generated]).toEqual(['ab'])
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
        expect(rows.rows.slice(0, 2).map((r) => String(r[4]).slice(0, 19))).toEqual([
          '2001-02-03 04:05:06',
          '2002-03-04 05:06:07',
        ])
        await execOk(`DROP TABLE ${t}`)
      })

      it.skipIf(dialect !== 'postgres')(
        'dumps an inheritance parent without its children and pages it by key',
        async () => {
          const p = `${scratch}_inh`
          const c = `${scratch}_inh_child`
          await execOk(
            `CREATE TABLE ${p} (id INT PRIMARY KEY, b TEXT); CREATE TABLE ${c} (PRIMARY KEY (id)) INHERITS (${p})`
          )
          await execOk(
            `INSERT INTO ${p} VALUES (1, 'p1'), (2, 'p2'), (3, 'p3'); INSERT INTO ${c} VALUES (1, 'c1'), (2, 'c2')`
          )
          const schema = await db.describeTable(ns, p)
          expect(schema).toMatchObject({ partitioned: false, hasChildren: true })
          // Batches smaller than the row count: a keyset over the parent would skip the children's duplicate ids.
          for (const batchSize of [1, 100]) {
            const seen: string[] = []
            for await (const b of db.iterateRows(ns, p, { batchSize, schema }))
              for (const r of b.rows) seen.push(String(r[1]))
            expect(seen).toEqual(['p1', 'p2', 'p3'])
          }
          // Browsing keeps SQL semantics (children included); a PK edit through the parent that would touch a
          // child row as well fails the exactly-one-row check instead of silently updating both.
          const all = await browseAll(p)
          expect(all.total).toBe(5)
          await expect(db.updateRow(ns, p, { kind: 'pk', values: { id: 1 } }, { b: 'x' })).rejects.toMatchObject({
            code: 'KEY_MISMATCH',
          })
          await execOk(`DROP TABLE ${c}; DROP TABLE ${p}`)
        }
      )

      it.skipIf(dialect !== 'postgres')(
        'advances sequences within their bounds and gives a serial copy its own',
        async () => {
          const t = `${scratch}_seqmin`
          await execOk(
            `CREATE TABLE ${t} (id INT GENERATED BY DEFAULT AS IDENTITY (START WITH 1000 MINVALUE 1000) PRIMARY KEY, s SERIAL, v INT)`
          )
          // Empty table: afterData must not try to set the sequence below its minimum.
          const empty = await db.describeTable(ns, t)
          await execOk(db.exporter.afterData(ns, empty).join('\n'))
          expect(await db.insertRow(ns, t, { v: 1 })).toEqual({ affectedRows: 1 })
          expect((await browseAll(t)).rows[0]?.[0]).toBe(1000)
          const copy = `${scratch}_seqmin_copy`
          await runDdl({
            op: 'copyTable',
            table: t,
            newName: copy,
            withData: true,
            columns: ['id', 's', 'v'],
            identityColumns: ['id'],
            serialColumns: ['s'],
          })
          expect(await db.insertRow(ns, copy, { v: 2 })).toEqual({ affectedRows: 1 })
          expect((await browseAll(copy)).rows.map((r) => [r[0], r[1]])).toEqual([
            [1000, 1],
            [1001, 2],
          ])
          // The copy no longer depends on the source's serial sequence: the source can be dropped.
          await execOk(`DROP TABLE ${t}`)
          expect(await db.insertRow(ns, copy, { v: 3 })).toEqual({ affectedRows: 1 })
          await execOk(`DROP TABLE ${copy}`)
        }
      )

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
        // MySQL grants are per database (printed as a LIKE pattern, `_` escaped); PostgreSQL grants are per
        // schema/table inside the current database.
        if (dialect === 'mysql') expect(grants.join('\n')).toContain(`\`${ns.database.replaceAll('_', '\\_')}\`.*`)
        else expect(grants.join('\n')).toContain(ns.schema ?? 'public')
        // MariaDB prints the password hash inside SHOW GRANTS; it never reaches the privileges screen.
        expect(grants.join('\n')).not.toMatch(/IDENTIFIED (?:BY|VIA)/i)
        if (dialect === 'postgres') {
          // Table grants are read from pg_class.relacl, so every table the role can SELECT is listed.
          expect(grants.join('\n')).toMatch(
            new RegExp(`GRANT [A-Z, ]*SELECT[A-Z, ]* ON "${ns.schema ?? 'public'}"\\."users" TO`)
          )
          // ACLs are per database: inspecting another database does not show this one's table grants.
          const elsewhere = await db.showGrants(user, { database: 'postgres' })
          expect(elsewhere.join('\n')).not.toContain('"users"')
          expect((await db.showGrants(user, ns)).join('\n')).toContain('"users"')
        }
        await runOp({ op: 'setPassword', user, password: 'changed' })
        await runOp({ op: 'revokeAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
        await runOp({ op: 'dropUser', user })
        expect((await db.listUsers()).some((u) => u.name === name)).toBe(false)
      })
    })

    describe('ddl', () => {
      it.skipIf(dialect !== 'postgres')('modifyColumn keeps a serial / identity generator', async () => {
        const t = `${scratch}_ser`
        await execOk(`CREATE TABLE ${t} (sid SERIAL PRIMARY KEY, iid INT GENERATED ALWAYS AS IDENTITY, x INT NULL)`)
        try {
          await runDdl({
            op: 'modifyColumn',
            table: t,
            name: 'sid',
            column: col('sid', 'INT', { nullable: false, autoIncrement: true, comment: 'renumbered' }),
          })
          await runDdl({
            op: 'modifyColumn',
            table: t,
            name: 'iid',
            column: col('iid', 'INT', { nullable: false, autoIncrement: true }),
          })
          await execOk(`INSERT INTO ${t} (x) VALUES (1), (2)`)
          const rows = await browseAll(t)
          expect(rows.rows.map((r) => [r[0], r[1]])).toEqual([
            [1, 1],
            [2, 2],
          ])
          expect((await db.describeTable(ns, t)).columns[0]?.comment).toBe('renumbered')
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it('adds and drops a foreign key that describeTable reports', async () => {
        const t = `${scratch}_fk`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, user_id INT NULL)`)
        try {
          await runDdl({
            op: 'addForeignKey',
            table: t,
            name: `${t}_user`,
            columns: ['user_id'],
            refTable: 'users',
            refColumns: ['id'],
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          })
          const fk = (await db.describeTable(ns, t)).foreignKeys.find((f) => f.name === `${t}_user`)
          expect(fk).toMatchObject({
            columns: ['user_id'],
            refTable: 'users',
            refColumns: ['id'],
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          })
          expect((await db.describeTable(ns, 'users')).referencedBy.some((r) => r.fromTable === t)).toBe(true)
          await runDdl({ op: 'dropForeignKey', table: t, name: `${t}_user` })
          expect((await db.describeTable(ns, t)).foreignKeys).toEqual([])
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

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

        await runDdl({ op: 'dropTable', table: scratchDdl, kind: 'table' })
        await expect(db.describeTable(ns, scratchDdl)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('sets a table comment, runs maintenance and bulk-drops / truncates tables', async () => {
        const a = `${scratch}_bulk_a`
        const b = `${scratch}_bulk_b`
        await execOk(`CREATE TABLE ${a} (id INT PRIMARY KEY); CREATE TABLE ${b} (id INT PRIMARY KEY)`)
        await execOk(`INSERT INTO ${a} (id) VALUES (1); INSERT INTO ${b} (id) VALUES (1)`)
        await runDdl({ op: 'setTableOptions', table: a, comment: "bulk 'a'" })
        expect((await db.describeTable(ns, a)).comment).toBe("bulk 'a'")
        await runDdl({ op: 'maintainTable', table: a, action: 'analyze' })
        if (dialect === 'mysql') await runDdl({ op: 'maintainTable', table: a, action: 'check' })
        else await runDdl({ op: 'maintainTable', table: a, action: 'vacuum' })
        await runDdl({ op: 'truncateTables', tables: [a, b] })
        expect((await browseAll(a)).total).toBe(0)
        expect((await browseAll(b)).total).toBe(0)
        await runDdl({ op: 'dropTables', tables: [a, b] })
        await expect(db.describeTable(ns, a)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(db.describeTable(ns, b)).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
        // A copy of an auto-increment / identity table keeps inserting after the copied ids.
        const src2 = `${scratch}_seq2`
        const idCol =
          dialect === 'mysql' ? 'id INT AUTO_INCREMENT PRIMARY KEY' : 'id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
        await execOk(`CREATE TABLE ${src2} (${idCol}, v INT NOT NULL)`)
        await execOk(`INSERT INTO ${src2} (v) VALUES (1), (2), (3)`)
        const identity = (await db.describeTable(ns, src2)).columns
          .filter((c) => c.extra.startsWith('identity'))
          .map((c) => c.name)
        await runDdl({
          op: 'copyTable',
          table: src2,
          newName: copy,
          withData: true,
          columns: ['id', 'v'],
          identityColumns: identity,
        })
        expect(await db.insertRow(ns, copy, { v: 4 })).toEqual({ affectedRows: 1 })
        expect((await browseAll(copy)).rows.map((r) => r[0])).toEqual([1, 2, 3, 4])
        await execOk(`DROP TABLE ${copy}`)
        await execOk(`DROP TABLE ${src2}`)
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
