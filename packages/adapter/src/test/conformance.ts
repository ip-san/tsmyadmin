import { createHash } from 'node:crypto'
import type {
  Cell,
  ColumnSpec,
  DdlOp,
  Dialect,
  Filter,
  Namespace,
  RowKey,
  StatementResult,
  TriggerInfo,
} from '@tsmyadmin/shared'
import {
  COLUMN_PRIVILEGES,
  EXACT_COUNT_MAX_ROWS,
  type InputCell,
  isBinaryCell,
  isGeneratedColumn,
  isInputCell,
  isTruncatedCell,
  MAX_TEXT_CHARS,
  sqlScript,
} from '@tsmyadmin/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mysqlAccount } from '../mysql/users.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type DatabaseAdapter, type ExecuteOptions, type RowBatch } from '../types.ts'

/** A browsed value handed back as a key / filter value (fails loudly if the server cut it). */
function input(cell: Cell | undefined): InputCell {
  if (cell === undefined || !isInputCell(cell)) throw new Error('not a writable cell')
  return cell
}

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
  return {
    name,
    dataType,
    nullable: true,
    default: null,
    autoIncrement: false,
    comment: null,
    collation: null,
    onUpdate: null,
    check: null,
    generated: null,
    ...extra,
  }
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
    `${scratch}_qtrg`,
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
    `${scratch}_slowt`,
    `${scratch}_big`,
    `${scratch}_seed`,
    `${scratch}_pseqt`,
    `${scratch}_serialt`,
    `${scratch}_inh_child`,
    `${scratch}_inh`,
    `${scratch}_seqmin_copy`,
    `${scratch}_seqmin`,
    `${scratch}_ser`,
    `${scratch}_bin`,
    `${scratch}_txt`,
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

      it('leaves out the sizes and table counts when asked not to count them', async () => {
        const counted = await db.listDatabases()
        const bare = await db.listDatabases({ stats: false })
        expect(bare.map((d) => d.name)).toEqual(counted.map((d) => d.name))
        for (const d of bare) {
          expect(d.sizeBytes).toBeNull()
          expect(d.tableCount).toBeNull()
        }
        // The fixture database has tables, so the counted list is not all nulls.
        expect(counted.find((d) => d.name === ns.database)?.sizeBytes).not.toBeNull()
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
        // `DEFAULT CURRENT_TIMESTAMP` is an expression on both dialects; a literal here would be re-quoted on
        // the next column edit and stop being a default at all.
        expect(createdAt?.defaultIsExpression).toBe(true)
        expect(createdAt?.default ?? '').toMatch(
          dialect === 'mysql' ? /^current_timestamp(\(\))?$/i : /^(?:now\(\)|CURRENT_TIMESTAMP)$/i
        )
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

    describe('searchTable', () => {
      it('reads the term as any word, every word, a regular expression, within columns named like', async () => {
        const total = async (term: string, options: Parameters<typeof db.searchTable>[3]) =>
          (await db.searchTable(ns, 'users', term, options)).total
        expect(await total('alice bob', { mode: 'any' })).toBe(2)
        expect(await total('alice example', { mode: 'all' })).toBe(1)
        expect(await total('alice bob', { mode: 'all' })).toBe(0)
        expect(await total('alice bob', { mode: 'phrase' })).toBe(0)
        expect(await total('^(al|bo)', { mode: 'regexp' })).toBe(2)
        expect(await total('example', { column: 'name' })).toBe(0)
        const inEmail = await db.searchTable(ns, 'users', 'example', { column: 'MAIL' })
        expect(inEmail.columns).toEqual(['email'])
        expect(inEmail.total).toBe(5)
        // The SELECT for the SQL tab finds the same rows.
        const any = await db.searchTable(ns, 'users', 'alice bob', { mode: 'any' })
        const [r] = await exec(any.sql)
        expect(r?.kind === 'rows' ? r.result.rows.length : -1).toBe(2)
      })

      it('offers the same match as a DELETE that removes exactly the rows found', async () => {
        const t = `${scratch}_sdel`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, note VARCHAR(40))`)
        try {
          await execOk(`INSERT INTO ${t} VALUES (1, 'it''s zap'), (2, 'keep'), (3, 'ZAP too')`)
          const found = await db.searchTable(ns, t, "it's zap", { mode: 'any' })
          expect(found.total).toBe(2)
          expect(found.deleteSql).toMatch(/^DELETE FROM /)
          await execOk(found.deleteSql)
          const [left] = await exec(`SELECT id FROM ${t}`)
          expect(left?.kind === 'rows' ? left.result.rows : []).toEqual([[2]])
        } finally {
          await execOk(`DROP TABLE IF EXISTS ${t}`)
        }
      })

      it('counts rows containing the term in any column, ignoring case', async () => {
        // "alice" is in both the name (Alice) and the email of the same row: one row, not two.
        expect(await db.searchTable(ns, 'users', 'ALICE')).toMatchObject({ total: 1, count: 'exact' })
        expect((await db.searchTable(ns, 'posts', 'alice')).total).toBe(0)
      })

      it('matches LIKE metacharacters literally', async () => {
        // Unescaped, % and _ would match every row.
        expect((await db.searchTable(ns, 'users', '%')).total).toBe(0)
        expect((await db.searchTable(ns, 'users', '_')).total).toBe(0)
      })

      it('skips binary and bit columns instead of failing on them', async () => {
        const r = await db.searchTable(ns, 'types_all', 'x')
        expect(r.columns).not.toContain('blob_col')
        expect(r.columns).not.toContain(dialect === 'mysql' ? 'varbinary_col' : 'blob_col')
        if (dialect === 'mysql') expect(r.columns).not.toContain('bit_col')
        expect(r.columns).toContain('text_col')
      })

      it('searches the text form of numbers, dates, JSON and enums', async () => {
        // Each term appears only in types_all's first row, and only in a column of that type.
        for (const term of ['901234.5678', '2024-03-04', 'true, null', dialect === 'mysql' ? 'beta' : 'sad'])
          expect((await db.searchTable(ns, 'types_all', term)).total, term).toBe(1)
      })

      it('gives a SELECT for the SQL tab that finds the same rows', async () => {
        // A backslash before a quote: on MySQL the literal must escape the backslash as well, or the quote ends
        // the string early. Nothing matches; the point is that the SELECT parses and agrees with the count.
        const escaped = await db.searchTable(ns, 'posts', "x\\'y")
        expect(escaped.total).toBe(0)
        const none = (await exec(escaped.sql))[0]
        expect(none?.kind).toBe('rows')
        expect(none?.kind === 'rows' && none.result.rows.length).toBe(0)
        // A quote in the term (posts has "Bob's post"): the SELECT must still parse and find that row.
        const found = await db.searchTable(ns, 'posts', "bob's")
        expect(found.total).toBe(1)
        const results = await exec(found.sql)
        const rows = results[0]
        expect(rows?.kind).toBe('rows')
        expect(rows?.kind === 'rows' && rows.result.rows.length).toBe(found.total)
      })
    })

    describe('listForeignKeys', () => {
      it('adds a foreign key to a table in another database (MySQL) or schema (PostgreSQL) and reads it back', async () => {
        const t = `${scratch}_xfk`
        const other = dialect === 'mysql' ? { database: 'tsmyadmin_other' } : { database: ns.database, schema: 'app' }
        const ref = dialect === 'mysql' ? 'marker' : `${scratch}_xref`
        try {
          if (dialect === 'postgres') await execOk(`CREATE TABLE app.${ref} (id INT PRIMARY KEY)`)
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, ref_id INT)`)
          await runDdl({
            op: 'addForeignKey',
            table: t,
            name: `${t}_fk`,
            columns: ['ref_id'],
            refTable: ref,
            ...(dialect === 'mysql' ? { refDatabase: 'tsmyadmin_other' } : { refSchema: 'app' }),
            refColumns: ['id'],
          })
          const fk = (await db.describeTable(ns, t)).foreignKeys.find((k) => k.name === `${t}_fk`)
          expect(fk).toMatchObject({ refTable: ref, refNamespace: other, refColumns: ['id'] })
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
          if (dialect === 'postgres') await exec(`DROP TABLE IF EXISTS app.${ref}`, { stopOnError: false })
        }
      })

      it('lists every key of the namespace, as describeTable reports them, ordered by table', async () => {
        const t = `${scratch}_fk`
        await execOk(`DROP TABLE IF EXISTS ${t}`)
        // Key columns in a different order from the referenced ones: they must stay paired, not sorted.
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY, y INT NULL, x INT NULL, CONSTRAINT ${t}_c FOREIGN KEY (y, x) REFERENCES composite_pk (a, b))`
        )
        try {
          const keys = await db.listForeignKeys(ns)
          expect(keys).toContainEqual({
            table: 'posts',
            name: 'fk_posts_user',
            columns: ['user_id'],
            refNamespace: ns.schema ? { database: ns.database, schema: ns.schema } : { database: ns.database },
            refTable: 'users',
            refColumns: ['id'],
            onUpdate: 'RESTRICT',
            onDelete: 'CASCADE',
          })
          expect(keys.find((k) => k.table === t)).toMatchObject({ columns: ['y', 'x'], refColumns: ['a', 'b'] })
          const tables = keys.map((k) => k.table)
          expect(tables).toEqual([...tables].sort())
          for (const table of new Set(tables)) {
            const described = (await db.describeTable(ns, table)).foreignKeys
            expect(
              keys.filter((k) => k.table === table).map(({ table: _, ...key }) => key),
              table
            ).toEqual(described)
          }
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'postgres')(
        'lists a key to a partitioned table once, not once per partition (PostgreSQL)',
        async () => {
          const parent = `${scratch}_part`
          const child = `${scratch}_ref`
          await execOk(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
          await execOk(
            `CREATE TABLE ${parent} (id INT PRIMARY KEY) PARTITION BY RANGE (id); CREATE TABLE ${parent}_1 PARTITION OF ${parent} FOR VALUES FROM (0) TO (100); CREATE TABLE ${parent}_2 PARTITION OF ${parent} FOR VALUES FROM (100) TO (200); CREATE TABLE ${child} (id INT PRIMARY KEY, p INT REFERENCES ${parent} (id))`
          )
          try {
            expect((await db.describeTable(ns, child)).foreignKeys.map((k) => k.refTable)).toEqual([parent])
            const listed = (await db.listForeignKeys(ns)).filter((k) => k.table === child || k.table.startsWith(parent))
            expect(listed.map((k) => [k.table, k.refTable])).toEqual([[child, parent]])
          } finally {
            await exec(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`, { stopOnError: false })
          }
        }
      )
    })

    describe('buildQuery', () => {
      const rowsOf = async (sql: string) => {
        const [r] = await exec(sql)
        if (r?.kind !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(r)}`)
        return r
      }
      const shown = (table: string, column: string, extra: { alias?: string; sort?: 'asc' | 'desc' } = {}) => ({
        table,
        column,
        alias: extra.alias ?? '',
        show: true,
        sort: extra.sort ?? null,
      })

      it('joins along a foreign key from either side, with OR groups and quoted values', async () => {
        const where = [
          // A quote in the value (posts has "Bob's post"); matched as literal text.
          [{ table: 'posts', column: 'title', op: 'contains' as const, value: "b's p" }],
          [
            { table: 'users', column: 'name', op: 'eq' as const, value: 'Alice' },
            { table: 'posts', column: 'title', op: 'starts_with' as const, value: 'Sec' },
          ],
          // A backslash before a quote: MySQL's literal must escape the backslash too, or the string ends early.
          [{ table: 'posts', column: 'title', op: 'eq' as const, value: "x\\'y" }],
        ]
        const columns = [
          shown('users', 'name', { sort: 'asc' }),
          shown('posts', 'title', { alias: 'post', sort: 'asc' }),
        ]
        const expected = [
          ['Alice', 'Second'],
          ['Bob', "Bob's post"],
        ]
        for (const tables of [
          ['users', 'posts'],
          ['posts', 'users'],
        ]) {
          const { sql } = await db.buildQuery(ns, { tables, columns, where })
          const r = await rowsOf(sql)
          expect(
            r.result.columns.map((c) => c.name),
            sql
          ).toEqual(['name', 'post'])
          expect(r.result.rows, sql).toEqual(expected)
        }
      })

      it('joins the way it is told: the kind and the columns, not only along a foreign key', async () => {
        const plan = (kind: 'inner' | 'left' | 'right', on: { from: string; to: string }) =>
          db.buildQuery(ns, {
            tables: ['users', 'posts'],
            columns: [shown('users', 'name', { sort: 'asc' }), shown('posts', 'id')],
            where: [],
            joins: [
              {
                table: 'posts',
                kind,
                on: [{ from: { table: 'posts', column: on.from }, to: { table: 'users', column: on.to } }],
              },
            ],
          })
        // INNER along user_id: only users with posts (Alice twice, Bob once).
        const inner = await plan('inner', { from: 'user_id', to: 'id' })
        expect(inner.sql).toMatch(/INNER JOIN/)
        expect((await rowsOf(inner.sql)).result.rows.map((r) => r[0])).toEqual(['Alice', 'Alice', 'Bob'])
        // LEFT keeps every user.
        expect((await rowsOf((await plan('left', { from: 'user_id', to: 'id' })).sql)).result.rows).toHaveLength(6)
        // Any columns, not only a key: posts.id = users.id.
        expect((await rowsOf((await plan('inner', { from: 'id', to: 'id' })).sql)).result.rows).toHaveLength(3)
        await expect(plan('inner', { from: 'nope', to: 'id' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('writes DISTINCT, typed conditions kept apart from the built ones, and LIMIT', async () => {
        const { sql } = await db.buildQuery(ns, {
          tables: ['posts'],
          columns: [shown('posts', 'user_id', { sort: 'asc' })],
          // Two groups OR-ed, then a typed condition with its own OR: neither may widen the other.
          where: [
            [{ table: 'posts', column: 'user_id', op: 'eq', value: '1' }],
            [{ table: 'posts', column: 'user_id', op: 'eq', value: '2' }],
          ],
          distinct: true,
          whereSql: `${quoteIdent(dialect, 'user_id')} = 1 OR 1 = 0`,
          limit: 5,
        })
        expect(sql).toMatch(/^SELECT DISTINCT /)
        expect(sql).toMatch(/LIMIT 5$/)
        expect((await rowsOf(sql)).result.rows).toEqual([[1]])
      })

      it('compares against the column type and handles IS NULL without a value', async () => {
        const columns = [shown('users', 'name', { sort: 'asc' })]
        const older = await db.buildQuery(ns, {
          tables: ['users'],
          columns,
          where: [[{ table: 'users', column: 'age', op: 'gt', value: '34' }]],
        })
        expect((await rowsOf(older.sql)).result.rows).toEqual([['Carol'], ['Eve']])
        const unknownAge = await db.buildQuery(ns, {
          tables: ['users'],
          columns,
          where: [[{ table: 'users', column: 'age', op: 'is_null' }]],
        })
        expect((await rowsOf(unknownAge.sql)).result.rows).toEqual([['Bob']])
        // Keys in another order: equal only when compared as JSON, which on MySQL takes an explicit cast. MariaDB's
        // JSON is LONGTEXT underneath and compares as text, so there the value is the text as stored.
        const jsonValue = (await isMariaDb()) ? '{"a": 1, "b": [true, null]}' : '{"b": [true, null], "a": 1}'
        const json = await db.buildQuery(ns, {
          tables: ['types_all'],
          columns: [shown('types_all', 'id')],
          where: [[{ table: 'types_all', column: 'json_col', op: 'eq', value: jsonValue }]],
        })
        expect((await rowsOf(json.sql)).result.rows).toEqual([[1]])
        // BIT typed as a number: on MySQL a quoted '170' would be compared as the bytes of the text.
        if (dialect === 'mysql') {
          const bit = await db.buildQuery(ns, {
            tables: ['types_all'],
            columns: [shown('types_all', 'id')],
            where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: '170' }]],
          })
          expect((await rowsOf(bit.sql)).result.rows).toEqual([[1]])
          await expect(
            db.buildQuery(ns, {
              tables: ['types_all'],
              columns: [],
              where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: 'x' }]],
            })
          ).rejects.toMatchObject({ code: 'VALIDATION' })
          // One past BIT(64): MySQL would clamp it to the maximum and match that instead.
          await expect(
            db.buildQuery(ns, {
              tables: ['types_all'],
              columns: [],
              where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: '18446744073709551616' }]],
            })
          ).rejects.toMatchObject({ code: 'VALIDATION' })
        }
      })

      it('refuses tables that no foreign key connects, and unknown columns', async () => {
        await expect(
          db.buildQuery(ns, { tables: ['users', 'types_all'], columns: [], where: [] })
        ).rejects.toMatchObject({ code: 'VALIDATION' })
        await expect(
          db.buildQuery(ns, { tables: ['users'], columns: [shown('users', 'nope')], where: [] })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(
          db.buildQuery(ns, { tables: ['users'], columns: [shown('posts', 'title')], where: [] })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('browseRows', () => {
      it('returns rows as arrays with column metadata and total', async () => {
        const r = await browseAll('users')
        expect(r.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'age', 'created_at'])
        expect(r.rows).toHaveLength(5)
        expect(r.total).toBe(5)
        expect(r.count).toBe('exact')
        expect(r.truncated).toBe(false)
        expect(r.keyKind).toBe('pk')
        expect(r.keyColumns).toEqual(['id'])
        expect(r.columns.every((c) => typeof c.dataType === 'string' && c.dataType.length > 0)).toBe(true)
      })

      it('reports the statement it ran, with values bound and never spliced into the text', async () => {
        // A value that would break the SQL if it were ever interpolated rather than bound.
        const needle = "o'hara; --"
        const r = await db.browseRows(ns, 'users', {
          offset: 0,
          limit: 7,
          sort: [{ column: 'age', direction: 'desc' }],
          filters: [{ column: 'name', op: 'eq', value: needle }],
        })
        expect(r.statement.sql).toMatch(/^SELECT /)
        expect(r.statement.sql).not.toContain(needle)
        expect(r.statement.sql).toContain('ORDER BY')
        // The filter value and the paging figures are all among the bound values, in placeholder order.
        expect(r.statement.params).toEqual([needle, 7, 0])
        const placeholders = dialect === 'mysql' ? r.statement.sql.match(/\?/g) : r.statement.sql.match(/\$\d+/g)
        expect(placeholders?.length).toBe(r.statement.params.length)
        expect(r.statement.durationMs).toBeGreaterThanOrEqual(0)
      })

      it('stops a filtered count at the threshold and reports it as a floor', async () => {
        const t = `${scratch}_big`
        const seed = `${scratch}_seed`
        await execOk(`CREATE TABLE ${seed} (n INT NOT NULL)`)
        await execOk(`INSERT INTO ${seed} (n) VALUES ${Array.from({ length: 47 }, (_, i) => `(${i + 1})`).join(', ')}`)
        // 47³ = 103,823 rows: just past EXACT_COUNT_MAX_ROWS.
        await execOk(`CREATE TABLE ${t} (v INT NOT NULL)`)
        await execOk(`INSERT INTO ${t} (v) SELECT a.n FROM ${seed} a, ${seed} b, ${seed} c`)
        try {
          const many = await db.browseRows(ns, t, {
            offset: 0,
            limit: 5,
            sort: [],
            filters: [{ column: 'v', op: 'gte', value: 1 }],
          })
          expect(many.rows).toHaveLength(5)
          expect({ total: many.total, count: many.count }).toEqual({
            total: EXACT_COUNT_MAX_ROWS,
            count: 'lower_bound',
          })
          const few = await db.browseRows(ns, t, {
            offset: 0,
            limit: 5,
            sort: [],
            filters: [{ column: 'v', op: 'eq', value: 1 }],
          })
          expect({ total: few.total, count: few.count }).toEqual({ total: 47 * 47, count: 'exact' })
        } finally {
          await execOk(`DROP TABLE ${t}; DROP TABLE ${seed}`)
        }
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

      it('filters with IN / BETWEEN lists, regular expressions and the empty string', async () => {
        const t = `${scratch}_ops`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, n INT NULL, s VARCHAR(30) NULL)`)
        try {
          await execOk(
            `INSERT INTO ${t} (id, n, s) VALUES (1, 0, ''), (2, 5, 'abc'), (3, 10, 'Abd'), (4, NULL, NULL), (5, 7, 'x1')`
          )
          const find = async (filter: Filter) =>
            (
              await db.browseRows(ns, t, {
                offset: 0,
                limit: 10,
                sort: [{ column: 'id', direction: 'asc' }],
                filters: [filter],
              })
            ).rows.map((r) => r[0])
          expect(await find({ column: 'n', op: 'in', values: ['5', 10] })).toEqual([2, 3])
          // NULL is neither in nor out of a list.
          expect(await find({ column: 'n', op: 'not_in', values: [5] })).toEqual([1, 3, 5])
          expect(await find({ column: 'n', op: 'between', values: ['5', '7'] })).toEqual([2, 5])
          expect(await find({ column: 'n', op: 'not_between', values: [5, 7] })).toEqual([1, 3])
          expect(await find({ column: 's', op: 'regexp', value: '^ab' })).toEqual(
            // MySQL's REGEXP follows the column's case-insensitive collation; PostgreSQL's ~ is case-sensitive.
            dialect === 'mysql' ? [2, 3] : [2]
          )
          expect(await find({ column: 's', op: 'not_regexp', value: '[0-9]' })).toEqual([1, 2, 3])
          expect(await find({ column: 'n', op: 'regexp', value: '^1' })).toEqual([3])
          expect(await find({ column: 's', op: 'empty' })).toEqual([1])
          expect(await find({ column: 's', op: 'not_empty' })).toEqual([2, 3, 5])
          // An INT 0 is not the empty string (MySQL would convert '' to 0 in a plain comparison).
          expect(await find({ column: 'n', op: 'empty' })).toEqual([])
          await expect(find({ column: 'n', op: 'between', values: [1] })).rejects.toMatchObject({ code: 'VALIDATION' })
          await expect(find({ column: 'n', op: 'in', values: [] })).rejects.toMatchObject({ code: 'VALIDATION' })

          const { sql } = await db.buildQuery(ns, {
            tables: [t],
            columns: [],
            where: [[{ table: t, column: 'n', op: 'in', values: ['5', '7'] }]],
          })
          const [r] = await exec(`${sql} ORDER BY 1`)
          expect(r?.kind === 'rows' ? r.result.rows.map((x) => x[0]) : r).toEqual([2, 5])
        } finally {
          await execOk(`DROP TABLE ${t}`)
        }
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

      it('writes through an allowed function, the value bound as its argument', async () => {
        const t = `${scratch}_fn`
        try {
          await exec(`CREATE TABLE ${t} (id INT PRIMARY KEY, h VARCHAR(64), u VARCHAR(64), at VARCHAR(40))`)
          await db.insertRow(ns, t, {
            id: 1,
            h: { $fn: 'md5', arg: "abc' --" },
            u: { $fn: 'uuid' },
            at: { $fn: 'upper', arg: 'mixed' },
          })
          const [row] = (await browseAll(t)).rows
          // The argument is data, not SQL: the quote and the comment are hashed with the rest.
          expect(row?.[1]).toBe(createHash('md5').update("abc' --").digest('hex'))
          expect(String(row?.[2])).toMatch(/^[0-9a-f-]{36}$/)
          expect(row?.[3]).toBe('MIXED')
          await db.updateRow(ns, t, { kind: 'pk', values: { id: 1 } }, { h: { $fn: 'sha256', arg: 'x' } })
          expect((await browseAll(t)).rows[0]?.[1]).toBe(createHash('sha256').update('x').digest('hex'))
          if (dialect === 'postgres') {
            await expect(db.insertRow(ns, t, { id: 2, h: { $fn: 'sha1', arg: 'x' } })).rejects.toMatchObject({
              code: 'UNSUPPORTED',
            })
          }
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
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

      it('under "ignore" hands back what INSERT IGNORE let pass besides the duplicate keys (MySQL)', async () => {
        // PostgreSQL refuses a value that is too long instead of cutting it, and has no such warnings.
        if (dialect !== 'mysql') return
        const table = `${scratch}_ign`
        await execOk(`CREATE TABLE ${table} (id INT PRIMARY KEY, s VARCHAR(3))`)
        try {
          await execOk(`INSERT INTO ${table} VALUES (1, 'a')`)
          const r = await db.insertRows(
            ns,
            table,
            ['id', 's'],
            [
              [1, 'dup'],
              [2, 'toolong'],
              [3, 'ok'],
            ],
            { onDuplicate: 'ignore', keyColumns: ['id'] }
          )
          // The duplicate is left out and is not a warning; the value cut to fit is, and the row still went in.
          expect(r.affectedRows).toBe(2)
          expect(r.warnings).toEqual([expect.stringMatching(/truncated/i)])
        } finally {
          await execOk(`DROP TABLE IF EXISTS ${table}`)
        }
      })

      it('returns 0 for no rows and rejects an empty column list', async () => {
        expect(await db.insertRows(ns, scratch, ['id'], [])).toEqual({ affectedRows: 0 })
        await expect(db.insertRows(ns, scratch, [], [[1]])).rejects.toMatchObject({ code: 'QUERY_FAILED' })
      })
    })

    describe('modifyColumn to a narrower type', () => {
      it('turns a text column of integers into INT, keeping the values (PostgreSQL needs the cast spelled out)', async () => {
        const t = `${scratch}_narrow`
        try {
          await runDdl({
            op: 'createTable',
            table: t,
            columns: [col('id', 'INT', { nullable: false }), col('code', 'VARCHAR(255)')],
            primaryKey: ['id'],
          })
          await execOk(`INSERT INTO ${t} VALUES (1, '10'), (2, '200'), (3, NULL)`)
          await runDdl({
            op: 'modifyColumn',
            table: t,
            name: 'code',
            column: col('code', 'INT'),
            previous: col('code', 'VARCHAR(255)'),
          })
          const described = await db.describeTable(ns, t)
          expect(described.columns.find((c) => c.name === 'code')?.dataType).toMatch(/^(int|integer)/i)
          const [r] = await exec(`SELECT code FROM ${t} ORDER BY id`)
          expect(r?.kind === 'rows' ? r.result.rows : []).toEqual([[10], [200], [null]])
        } finally {
          await execOk(`DROP TABLE IF EXISTS ${t}`)
        }
      })
    })

    describe('routineDetail', () => {
      it('reads a routine back as the create form takes it, body escapes intact, and replaces it', async () => {
        const name = `${scratch}_rd`
        const body =
          dialect === 'mysql' ? "RETURN CONCAT('a\\'b', \"c\\\\d\", n)" : "BEGIN RETURN 'a''b' || n::text; END"
        const create = {
          op: 'createRoutine' as const,
          kind: 'function' as const,
          name,
          params: [{ mode: 'IN' as const, name: 'n', type: dialect === 'mysql' ? 'INT' : 'integer' }],
          returns: dialect === 'mysql' ? 'VARCHAR(30)' : 'text',
          body,
          language: dialect === 'mysql' ? 'sql' : 'plpgsql',
          deterministic: true,
          comment: "it's a note",
        }
        try {
          await runDdl(create)
          const detail = await db.routineDetail(ns, name, 'function')
          expect(detail).toMatchObject({ kind: 'function', name, comment: "it's a note", deterministic: true })
          expect(detail?.body.trim().replace(/;$/, '')).toBe(body.replace(/;$/, ''))
          expect(detail?.params.map((p) => [p.mode, p.name])).toEqual([['IN', 'n']])
          // Edit: change the body through replaceRoutine, from what was read back.
          if (!detail) throw new Error('no detail')
          const info = (await db.listRoutines(ns)).find((r) => r.name === name)
          await runDdl({
            op: 'replaceRoutine',
            ...detail,
            body: dialect === 'mysql' ? 'RETURN n + 1' : 'BEGIN RETURN (n + 1)::text; END',
            replaces: {
              kind: 'function',
              name,
              ...(dialect === 'postgres' ? { parameters: info?.parameters ?? '' } : {}),
            },
          })
          const after = await db.routineDetail(ns, name, 'function')
          expect(after?.body).toContain('n + 1')
          expect(after?.comment).toBe("it's a note")
        } finally {
          const info = (await db.listRoutines(ns)).find((r) => r.name === name)
          await exec(
            db.ddl
              .build(ns, {
                op: 'dropRoutine',
                kind: 'function',
                name,
                ...(dialect === 'postgres' ? { parameters: info?.parameters ?? '' } : {}),
              })
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })
    })

    describe('triggerDetail', () => {
      it('reads a trigger back as the create form takes it, and replaces it with another event', async () => {
        const table = `${scratch}_trt`
        const trigger = `${scratch}_trg`
        const body =
          dialect === 'mysql' ? "SET NEW.s = CONCAT('x\\'y', \"z\\\\w\")" : "BEGIN NEW.s := 'x''y'; RETURN NEW; END"
        try {
          await execOk(`CREATE TABLE ${table} (id INT PRIMARY KEY, s VARCHAR(30))`)
          await runDdl({ op: 'createTrigger', name: trigger, table, timing: 'BEFORE', event: 'INSERT', body })
          const detail = await db.triggerDetail(ns, table, trigger)
          expect(detail).toMatchObject({ name: trigger, table, timing: 'BEFORE', event: 'INSERT' })
          expect(detail?.body.trim()).toBe(body)
          if (!detail) throw new Error('no detail')
          await runDdl({
            op: 'replaceTrigger',
            ...detail,
            event: 'UPDATE',
            replaces: { name: trigger, table },
          })
          expect(await db.triggerDetail(ns, table, trigger)).toMatchObject({ timing: 'BEFORE', event: 'UPDATE' })
        } finally {
          await execOk(`DROP TABLE IF EXISTS ${table}`)
          if (dialect === 'postgres') await exec(`DROP FUNCTION IF EXISTS ${trigger}_fn()`, { stopOnError: false })
        }
      })
    })

    describe('eventDetail', () => {
      it('reads an event back (MySQL) and replaces its schedule; PostgreSQL has none', async () => {
        const name = `${scratch}_evd`
        if (dialect === 'postgres') {
          expect(await db.eventDetail(ns, name)).toBeNull()
          return
        }
        const body = "INSERT INTO users_log_none VALUES (1, 'q\\'r')"
        try {
          await execOk('CREATE TABLE IF NOT EXISTS users_log_none (id INT, s VARCHAR(20))')
          await runDdl({
            op: 'createEvent',
            name,
            schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2031-01-01 00:00:00' },
            body,
            enabled: false,
            comment: 'c',
          })
          const detail = await db.eventDetail(ns, name)
          expect(detail).toMatchObject({
            name,
            schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2031-01-01 00:00:00' },
            enabled: false,
            comment: 'c',
            preserve: false,
          })
          expect(detail?.body).toBe(body)
          if (!detail) throw new Error('no detail')
          await runDdl({
            op: 'replaceEvent',
            ...detail,
            schedule: { kind: 'every', interval: 2, unit: 'HOUR' },
            replaces: name,
          })
          expect((await db.eventDetail(ns, name))?.schedule).toMatchObject({ kind: 'every', interval: 2, unit: 'HOUR' })
        } finally {
          await exec(`DROP EVENT IF EXISTS \`${name}\``, { stopOnError: false })
          await exec('DROP TABLE IF EXISTS users_log_none', { stopOnError: false })
        }
      })
    })

    describe('createTable options', () => {
      it('creates a table with its comment, and with its engine and collation on MySQL', async () => {
        const t = `${scratch}_copt`
        try {
          await runDdl({
            op: 'createTable',
            table: t,
            columns: [col('id', 'INT', { nullable: false })],
            primaryKey: ['id'],
            comment: "made 'with' options",
            ...(dialect === 'mysql' ? { engine: 'InnoDB', collation: 'utf8mb4_bin' } : {}),
          })
          const described = await db.describeTable(ns, t)
          expect(described.comment).toBe("made 'with' options")
          if (dialect === 'mysql') {
            expect(described.engine).toBe('InnoDB')
            expect(described.collation).toBe('utf8mb4_bin')
          }
        } finally {
          await execOk(`DROP TABLE IF EXISTS ${t}`)
        }
      })
    })

    describe('listPartitions', () => {
      it('partitions a table, adds, empties, analyses and removes partitions, and reads them back', async () => {
        const t = `${scratch}_part`
        const count = async () => {
          const [r] = await exec(`SELECT COUNT(*) FROM ${t}`)
          return r?.kind === 'rows' ? Number(r.result.rows[0]?.[0]) : -1
        }
        try {
          expect((await db.listPartitions(ns, 'users')).method).toBeNull()
          if (dialect === 'mysql') {
            await execOk(`CREATE TABLE ${t} (id INT NOT NULL, n INT)`)
            await runDdl({
              op: 'partitionTable',
              table: t,
              method: 'range',
              expression: 'id',
              partitions: [
                { name: 'p0', bound: 'VALUES LESS THAN (10)' },
                { name: 'p1', bound: 'VALUES LESS THAN (20)' },
              ],
            })
            await runDdl({ op: 'addPartition', table: t, partition: { name: 'p2', bound: 'VALUES LESS THAN (30)' } })
          } else {
            await runDdl({
              op: 'createTable',
              table: t,
              columns: [col('id', 'INT', { nullable: false }), col('n', 'INT')],
              primaryKey: [],
              partitionBy: { method: 'range', expression: 'id' },
            })
            await runDdl({
              op: 'addPartition',
              table: t,
              partition: { name: `${t}_p0`, bound: 'FOR VALUES FROM (0) TO (10)' },
            })
            await runDdl({
              op: 'addPartition',
              table: t,
              partition: { name: `${t}_p1`, bound: 'FOR VALUES FROM (10) TO (20)' },
            })
            await runDdl({ op: 'addPartition', table: t, partition: { name: `${t}_p2`, bound: 'DEFAULT' } })
          }
          const [p0, p1, p2] = dialect === 'mysql' ? ['p0', 'p1', 'p2'] : [`${t}_p0`, `${t}_p1`, `${t}_p2`]
          await execOk(`INSERT INTO ${t} (id, n) VALUES (1, 1), (15, 2), (25, 3)`)
          const parts = await db.listPartitions(ns, t)
          expect(parts.method).toBe('range')
          expect(parts.expression?.replaceAll('`', '')).toBe('id')
          expect(parts.partitions.map((p) => p.name)).toEqual([p0, p1, p2])
          expect(parts.partitions[0]?.bound).toBe(
            dialect === 'mysql' ? 'VALUES LESS THAN (10)' : 'FOR VALUES FROM (0) TO (10)'
          )
          if (dialect === 'postgres') expect(parts.partitions[2]?.bound).toBe('DEFAULT')

          await runDdl({ op: 'truncatePartition', table: t, name: p0 ?? '' })
          expect(await count()).toBe(2)
          await runDdl({ op: 'maintainPartition', table: t, name: p1 ?? '', action: 'analyze' })
          if (dialect === 'postgres') {
            // Detached, the partition is a table of its own with its rows.
            await runDdl({ op: 'detachPartition', table: t, name: p1 ?? '' })
            expect(await count()).toBe(1)
            await execOk(`DROP TABLE ${p1}`)
          }
          await runDdl({ op: 'dropPartition', table: t, name: p2 ?? '' })
          expect((await db.listPartitions(ns, t)).partitions.map((p) => p.name)).toEqual(
            dialect === 'mysql' ? [p0, p1] : [p0]
          )
          if (dialect === 'mysql') {
            await runDdl({ op: 'removePartitioning', table: t })
            expect(await db.listPartitions(ns, t)).toEqual({ method: null, expression: null, partitions: [] })
            expect(await count()).toBe(1)
          }
          await expect(db.listPartitions(ns, `${t}_missing`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })
    })

    describe('databaseGrants', () => {
      it('lists the accounts’ database-level privileges (MySQL), and none on PostgreSQL', async () => {
        const grants = await db.databaseGrants(ns.database)
        expect(Array.isArray(grants)).toBe(true)
        if (dialect === 'postgres') expect(grants).toEqual([])
        // Every entry names an account and only privileges a GRANT can carry.
        for (const g of grants) {
          expect(g.user).toEqual(expect.any(String))
          expect(g.privileges.every((p) => /^[A-Z][A-Z ]*$/.test(p))).toBe(true)
        }
        // A database nobody was granted anything on.
        expect(await db.databaseGrants(`${scratch}_nobody`)).toEqual([])
      })
    })

    describe('countRows', () => {
      it('counts every row exactly, and lists MySQL tables with their collation and creation time', async () => {
        expect(await db.countRows(ns, 'users')).toBe(5)
        await expect(db.countRows(ns, `${scratch}_none`)).rejects.toMatchObject({ code: expect.any(String) })
        const users = (await db.listTables(ns)).find((x) => x.name === 'users')
        if (dialect === 'mysql') {
          expect(users?.collation).toMatch(/^utf8mb4_/)
          expect(users?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
        }
      })
    })

    describe('tableStats', () => {
      it('reports the space a table uses and its rows; a view has no sizes', async () => {
        const t = `${scratch}_stats`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, s VARCHAR(100))`)
        try {
          // A secondary index: InnoDB counts the clustered primary key as data, not index.
          await execOk(`CREATE INDEX ${t}_s ON ${t} (s)`)
          await execOk(`INSERT INTO ${t} (id, s) VALUES (1, 'a'), (2, 'b'), (3, 'c')`)
          // The catalog's figures are as of its last update: have it look now.
          await execOk(dialect === 'mysql' ? `ANALYZE TABLE ${t}` : `ANALYZE ${t}`)
          const st = await db.tableStats(ns, t)
          expect(st.dataBytes).toBeGreaterThan(0)
          expect(st.indexBytes).toBeGreaterThan(0)
          expect(st.totalBytes).toBeGreaterThanOrEqual((st.dataBytes ?? 0) + (st.indexBytes ?? 0))
          expect(st.rowEstimate).toBe(3)
          if (dialect === 'mysql') {
            expect(st.rowFormat).toBeTruthy()
            expect(st.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
            expect(st.toastBytes).toBeNull()
          } else {
            expect(st.freeBytes).toBeNull()
            // Before PostgreSQL 15 the statistics collector reports a moment later: not yet there is fine.
            expect(st.lastAnalyze === null || /^\d{4}-\d{2}-\d{2}/.test(st.lastAnalyze)).toBe(true)
            expect([null, 0]).toContain(st.deadRows)
          }
          const view = await db.tableStats(ns, 'active_users')
          expect([view.dataBytes, view.indexBytes, view.totalBytes, view.rowEstimate]).toEqual([null, null, null, null])
          await expect(db.tableStats(ns, `${t}_missing`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        } finally {
          await execOk(`DROP TABLE ${t}`)
        }
      })
    })

    describe('readCell', () => {
      it('reads one value whole, past the cut a browse page makes, for exactly one row', async () => {
        const t = `${scratch}_cell`
        const blob = dialect === 'mysql' ? 'MEDIUMBLOB' : 'BYTEA'
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, b ${blob} NULL, s TEXT NULL)`)
        try {
          const bytes = Buffer.alloc(70_000, 7)
          bytes[69_999] = 9
          await db.insertRow(ns, t, { id: 1, b: { $bin: bytes.toString('base64') }, s: 'x'.repeat(5) })
          await db.insertRow(ns, t, { id: 2, b: null, s: null })
          const page = await db.browseRows(ns, t, { offset: 0, limit: 1, sort: [], filters: [] })
          const cut = page.rows[0]?.[1]
          expect(cut && typeof cut === 'object' && '$bin' in cut ? Buffer.from(cut.$bin, 'base64').length : 0).toBe(
            65_536
          )

          const whole = await db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'b')
          expect(
            whole && typeof whole === 'object' && '$bin' in whole ? Buffer.from(whole.$bin, 'base64') : null
          ).toEqual(bytes)
          expect(await db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 's')).toBe('xxxxx')
          // Any type, not only text and binary (PostgreSQL's octet_length has no integer form).
          expect(await db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'id')).toBe(1)
          expect(await db.readCell(ns, t, { kind: 'pk', values: { id: 2 } }, 'b')).toBeNull()
          await expect(db.readCell(ns, t, { kind: 'pk', values: { id: 3 } }, 'b')).rejects.toMatchObject({
            code: 'KEY_MISMATCH',
          })
          await expect(db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'nope')).rejects.toMatchObject({
            code: 'NOT_FOUND',
          })
        } finally {
          await execOk(`DROP TABLE ${t}`)
        }
      })
    })

    describe('updateRow', () => {
      it.skipIf(dialect !== 'mysql')(
        'addresses the row the caller named, not one the collation calls equal',
        async () => {
          // Without a key every column is the key. Compared in the column's own collation, rows differing only by
          // case, accent or a trailing space tie, and the LIMIT 1 that follows would edit whichever came first.
          for (const [collation, a, b] of [
            ['utf8mb4_0900_ai_ci', 'cafe', 'café'],
            ['utf8mb4_general_ci', 'a', 'A'],
            ['utf8mb4_general_ci', 'b ', 'b'],
            ['latin1_swedish_ci', 'cafe', 'café'],
          ] as const) {
            const t = `${scratch}_ci`
            await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
            // MariaDB has no utf8mb4_0900_* collations; its default ai_ci behaves the same way.
            const coll = collation === 'utf8mb4_0900_ai_ci' && (await isMariaDb()) ? 'utf8mb4_general_ci' : collation
            await execOk(`CREATE TABLE ${t} (s VARCHAR(10) COLLATE ${coll}, n INT)`)
            try {
              // Both rows carry the same n, so only `s` tells them apart — and the collation says it does not.
              await execOk(`INSERT INTO ${t} (s, n) VALUES ('${a}', 1), ('${b}', 1)`)
              await db.updateRow(ns, t, { kind: 'all-columns', values: { s: b, n: 1 } }, { n: '99' })
              // Compared by bytes: only the row the caller named may carry the new value.
              const after = await exec(`SELECT HEX(CONVERT(s USING utf8mb4)) h, n FROM ${t} ORDER BY n`)
              const r = after[0]
              const pairs = r?.kind === 'rows' ? r.result.rows.map((x) => [String(x[0]), Number(x[1])]) : []
              const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex').toUpperCase()
              expect(pairs).toEqual([
                [hex(a), 1],
                [hex(b), 99],
              ])

              await execOk(`UPDATE ${t} SET n = 1 WHERE n = 99`)
              await db.deleteRows(ns, t, [{ kind: 'all-columns', values: { s: b, n: 1 } }])
              const left = await exec(`SELECT s FROM ${t}`)
              const l = left[0]
              expect(l?.kind === 'rows' ? l.result.rows.map((x) => String(x[0])) : []).toEqual([a])
            } finally {
              await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
            }
          }
        }
      )

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
            : { kind: 'all-columns', values: { f: input(row[0]), d: input(row[1]), j: input(row[2]), v: 1 } }
        expect(await db.updateRow(ns, t, key, { v: 2 })).toEqual({ affectedRows: 1 })
        // The same values as a composite "primary key" (FLOAT 0.1 ≠ DOUBLE 0.1 unless cast).
        await execOk(`ALTER TABLE ${t} ADD PRIMARY KEY (f, d)`)
        const pk: RowKey = { kind: 'pk', values: { f: input(row[0]), d: input(row[1]) } }
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
      it('times each statement by stage when profiling is asked for (MySQL / MariaDB only)', async () => {
        const results = await exec('SELECT 1; SELECT COUNT(*) FROM users', { profile: true })
        expect(results.map((r) => r.kind)).toEqual(['rows', 'rows'])
        for (const r of results) {
          const profile = r.kind === 'rows' ? r.profile : undefined
          if (dialect === 'postgres') expect(profile).toBeUndefined()
          else {
            expect(profile?.length).toBeGreaterThan(0)
            expect(profile?.every((p) => p.state.length > 0 && p.seconds >= 0)).toBe(true)
          }
        }
        // Profiling is session state: the next run on the pooled connection is not profiled.
        const plain = await exec('SELECT 1')
        expect(plain[0]?.kind === 'rows' ? plain[0].profile : 'x').toBeUndefined()
      })

      it('asks the server whether the script left a transaction open', async () => {
        // The answer has to come from the server: MySQL's implicit commits depend on how far a statement got
        // (a DDL the parser rejected never committed), which reading the script cannot reproduce.
        const t = `${scratch}_tx`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
        const begin = dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
        const open = async (sql: string, opts: Partial<ExecuteOptions> = {}) => {
          let reported: boolean | null = null
          await exec(sql, { ...opts, onTransactionOpen: (o) => (reported = o) })
          return reported
        }
        try {
          expect(await open(`SELECT 1;`)).toBe(false)
          expect(await open(`${begin};\nINSERT INTO ${t} VALUES (1);`)).toBe(true)
          expect(await open(`${begin};\nINSERT INTO ${t} VALUES (2);\nCOMMIT;`)).toBe(false)
          expect(await open(`${begin};\nINSERT INTO ${t} VALUES (3);\nROLLBACK;`)).toBe(false)
          // A statement the server rejected before its implicit commit leaves the transaction open.
          expect(
            await open(`${begin};\nINSERT INTO ${t} VALUES (4);\nCREATE TABLE ${t}_x (a INT`, { stopOnError: false })
          ).toBe(true)
          // The cases that motivated asking the server: MySQL rejects these before the implicit commit, so the
          // transaction is still open — no reading of the script can know that.
          expect(
            await open(`${begin};\nINSERT INTO ${t} VALUES (9);\nCREATE TABLE ${t}_z (a DECIMAL(2,5));`, {
              stopOnError: false,
            })
          ).toBe(true)
          // `COMMIT AND CHAIN` closes one transaction and opens the next in the same statement.
          expect(await open(`${begin};\nINSERT INTO ${t} VALUES (10);\nCOMMIT AND CHAIN;`)).toBe(true)
          if (dialect === 'mysql') {
            // MySQL excludes temporary tables from the implicit commit.
            expect(
              await open(`${begin};\nINSERT INTO ${t} VALUES (5);\nCREATE TEMPORARY TABLE ${t}_tmp (a INT);`)
            ).toBe(true)
            // An ordinary DDL does commit, so nothing is left open.
            expect(await open(`${begin};\nINSERT INTO ${t} VALUES (6);\nCREATE TABLE ${t}_y (a INT);`)).toBe(false)
            await execOk(`DROP TABLE IF EXISTS ${t}_y`)
            expect(await open(`SET autocommit = 0;\nINSERT INTO ${t} VALUES (7);`)).toBe(true)
          } else {
            // PostgreSQL keeps a failed transaction open until it is rolled back; its work is lost either way.
            expect(await open(`${begin};\nINSERT INTO ${t} VALUES (8);\nSELECT 1 / 0;`, { stopOnError: false })).toBe(
              true
            )
            // END is COMMIT and ABORT is ROLLBACK; both are easy to miss when reading the script instead.
            expect(await open(`${begin};\nINSERT INTO ${t} VALUES (11);\nEND;`)).toBe(false)
            expect(await open(`${begin};\nINSERT INTO ${t} VALUES (12);\nABORT;`)).toBe(false)
          }
          // What survived proves the reported flag matched reality: only the explicitly committed row, plus
          // on MySQL the one an ordinary DDL implicitly committed. Everything reported as open was rolled back.
          const rows = await exec(`SELECT id FROM ${t} ORDER BY id`)
          const first = rows[0]
          const ids = first?.kind === 'rows' ? first.result.rows.map((r) => Number(r[0])) : []
          // Row 10 survived: COMMIT AND CHAIN committed it before opening the next transaction.
          expect(ids).toEqual(dialect === 'mysql' ? [2, 6, 10] : [2, 10, 11])
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it('runs multiple statements and returns one result per statement', async () => {
        const results = await exec('SELECT 1 AS one; SELECT 2 AS two')
        expect(results).toHaveLength(2)
        // Every result names its statement: the wrapper / progress logic of an import counts statements.
        expect(results.map((r) => r.statement)).toEqual([0, 1])
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
      it.skipIf(dialect !== 'mysql')('gives every result set of a CALL the statement index of the CALL', async () => {
        const p = `${scratch}_multi`
        await execOk(`DROP PROCEDURE IF EXISTS ${p}`)
        await execOk(`DELIMITER $$\nCREATE PROCEDURE ${p}() BEGIN SELECT 1 AS a; SELECT 2 AS b; END$$`)
        try {
          const results = await exec(`SELECT 0 AS z; CALL ${p}(); SELECT 3 AS c`)
          // CALL: two result sets plus the final OK packet, all statement #1.
          expect(results.map((r) => r.statement)).toEqual([0, 1, 1, 1, 2])
        } finally {
          await execOk(`DROP PROCEDURE ${p}`)
        }
      })

      it('answers what the cancel did once the script loop reaches its next boundary', async () => {
        // The loop is idle inside onResult for a while (a slow consumer): the cancel waits for it, then reports
        // that the script was stopped there — it must neither answer early nor hang.
        const queryId = crypto.randomUUID()
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const run = db.executeSql(ns, 'SELECT 1 AS a; SELECT 2 AS b', {
          ...EXEC,
          queryId,
          onResult: async (_r, index) => {
            if (index === 0) await gate
          },
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        const cancelling = db.cancelQuery(queryId)
        await new Promise((resolve) => setTimeout(resolve, 300))
        release()
        expect(await cancelling).toBe(true)
        // Stopped between the statements: only the first ran.
        expect((await run).map((r) => r.kind)).toEqual(['rows'])
        expect((await exec('SELECT 1 AS x'))[0]).toMatchObject({ kind: 'rows' })
      })

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
             CREATE TABLE ${ch} (extra TEXT, b INT NOT NULL DEFAULT 5) INHERITS (${p});
             ALTER TABLE ${ch} ALTER COLUMN a SET DEFAULT 9;
             CREATE UNLOGGED TABLE ${fk} (id INT PRIMARY KEY, a INT DEFAULT 1, b INT DEFAULT 1);
             ALTER TABLE ${fk} ADD CONSTRAINT ${fk}_ab FOREIGN KEY (a, b) REFERENCES ${p} (a, b) MATCH FULL ON DELETE SET DEFAULT ON UPDATE SET NULL NOT VALID;
             CREATE TABLE ${part} (id INT, d DATE) PARTITION BY RANGE (d);
             CREATE TABLE ${part}_2024 PARTITION OF ${part} FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
             CREATE UNLOGGED TABLE ${part}_rest PARTITION OF ${part} DEFAULT WITH (fillfactor = 60);
             COMMENT ON TABLE ${part}_rest IS 'the rest';
             CREATE INDEX ${part}_d_idx ON ${part} (d);
             CREATE INDEX "${part} spaced" ON ${part} (d);
             CREATE INDEX ${part}_2024_id_idx ON ${part}_2024 (id);
             ALTER TABLE ${part}_2024 ADD CONSTRAINT ${part}_2024_chk CHECK (id > 0);
             ALTER TABLE ${part}_2024 ADD PRIMARY KEY (id, d)`
          )
          try {
            const parent = (await db.showCreateTable(ns, p)).join('\n')
            expect(parent).toContain(`CREATE UNLOGGED TABLE "public"."${p}"`)
            expect(parent).toContain("WITH (fillfactor='70')")
            expect((await db.describeTable(ns, ch)).inherits).toEqual([p])
            const child = (await db.showCreateTable(ns, ch)).join('\n')
            expect(child).toContain(`INHERITS (public.${p})`)
            // The inherited CHECK belongs to the parent: not repeated on the child. Only columns the child declares
            // itself are listed (`b` is redeclared, `a` is not); an inherited column's own default is set afterwards.
            expect(child).not.toContain('CHECK')
            expect(child).not.toMatch(/^\s+"a" integer/m)
            expect(child).toMatch(/^\s+"b" integer NOT NULL DEFAULT 5/m)
            expect(child).toContain(`ALTER TABLE ONLY "public"."${ch}" ALTER COLUMN "a" SET DEFAULT 9`)
            const opts = (await db.showCreateTable(ns, fk)).join('\n')
            expect(opts).toContain('MATCH FULL ON UPDATE SET NULL ON DELETE SET DEFAULT NOT VALID')
            const partitioned = await db.showCreateTable(ns, part)
            expect(partitioned[0]).toContain('PARTITION BY RANGE (d)')
            expect(partitioned).toContainEqual(
              `CREATE TABLE "public"."${part}_2024" PARTITION OF "public"."${part}" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`
            )
            // Leaf attributes: UNLOGGED, storage parameters and the comment live on the partition.
            expect(partitioned).toContainEqual(
              `CREATE UNLOGGED TABLE "public"."${part}_rest" PARTITION OF "public"."${part}" DEFAULT WITH (fillfactor='60')`
            )
            expect(partitioned).toContainEqual(`COMMENT ON TABLE "public"."${part}_rest" IS 'the rest'`)
            expect(partitioned.join('\n')).toMatch(
              new RegExp(`^CREATE INDEX "${part} spaced" ON (?:public\\.)?${part} USING btree \\(d\\)$`, 'm')
            )
            // The parent's index is created without ONLY (so it reaches the partitions); a partition keeps its own
            // index and constraint, but not the ones it inherits from the parent.
            expect(partitioned.join('\n')).toMatch(
              new RegExp(`^CREATE INDEX ${part}_d_idx ON (?:public\\.)?${part} USING btree \\(d\\)$`, 'm')
            )
            expect(partitioned.join('\n')).not.toContain('ON ONLY')
            expect(partitioned).toContainEqual(
              `CREATE INDEX ${part}_2024_id_idx ON public.${part}_2024 USING btree (id)`
            )
            expect(partitioned).toContainEqual(
              `ALTER TABLE "public"."${part}_2024" ADD CONSTRAINT "${part}_2024_chk" CHECK ((id > 0))`
            )
            expect(partitioned.join('\n')).not.toContain(`${part}_2024_d_idx`)
            expect(partitioned).toContainEqual(
              `ALTER TABLE "public"."${part}_2024" ADD CONSTRAINT "${part}_2024_pkey" PRIMARY KEY (id, d)`
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
          // Each run resets the session, and MariaDB 10.11 parses DROP PACKAGE only in Oracle mode.
          await execOk(`SET SESSION sql_mode = ORACLE;\nDROP PACKAGE ${p}`)
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

      it('scans a key-less table in batches and survives a consumer that stops early', async () => {
        const t = `${scratch}_nokey`
        await execOk(`CREATE TABLE ${t} (v INT NULL, s VARCHAR(10) NULL)`)
        const values = Array.from({ length: 11 }, (_, i) => `(${i}, 'r${i}')`)
        await execOk(`INSERT INTO ${t} (v, s) VALUES ${values.join(', ')}`)
        const sizes: number[] = []
        const seen = new Set<number>()
        for await (const batch of db.iterateRows(ns, t, { batchSize: 4 })) {
          expect(batch.columns.map((c) => c.name)).toEqual(['v', 's'])
          sizes.push(batch.rows.length)
          for (const r of batch.rows) seen.add(Number(r[0]))
        }
        expect(seen.size).toBe(11)
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(11)
        // A caller that gives up mid-scan (a client closing an export) must not poison the pool.
        for await (const batch of db.iterateRows(ns, t, { batchSize: 4 })) {
          expect(batch.rows.length).toBeGreaterThan(0)
          break
        }
        expect((await browseAll(t)).rows).toHaveLength(11)
        // A connection that dies mid-scan ends the iteration with an error instead of hanging it (MySQL streams
        // the scan; PostgreSQL pages with a cursor).
        if (dialect === 'mysql') {
          const slow = `${scratch}_slowv`
          const big = `${scratch}_slowt`
          // 1,331 rows at 10 ms each from a plain scan; the 8 KB padding overflows the server's 16 KB net buffer so
          // rows reach the client while the query is still running (small rows would be flushed only at the end).
          await execOk(`CREATE TABLE ${big} (v INT NULL)`)
          await execOk(`INSERT INTO ${big} (v) SELECT a.v FROM ${t} a, ${t} b, ${t} c`)
          await execOk(`CREATE VIEW ${slow} AS SELECT v, REPEAT('x', 8000) AS pad, SLEEP(0.01) AS z FROM ${big}`)
          try {
            const scan = db.iterateRows(ns, slow, { batchSize: 2 })[Symbol.asyncIterator]()
            try {
              await scan.next()
              // Found by its text: MariaDB has no connection attributes, so `self` is not set there.
              const me = (await db.listProcesses()).find((p) => (p.query ?? '').includes(slow))
              expect(me).toBeDefined()
              if (me) await db.killProcess(me.id)
              // Batches already buffered on the client may still come through; the kill surfaces right after.
              const drain = async (): Promise<string> => {
                for (let i = 0; i < 50; i++) {
                  const next = await scan.next().then(
                    (r) => (r.done ? 'ended' : 'batch'),
                    (err: unknown) => (err instanceof AdapterError ? err.code : 'other')
                  )
                  if (next !== 'batch') return next
                }
                return 'still-flowing'
              }
              const outcome = await Promise.race([
                drain(),
                new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 8000)),
              ])
              expect(['CONNECTION_FAILED', 'QUERY_FAILED']).toContain(outcome)
              expect((await browseAll(t)).rows).toHaveLength(11)
            } finally {
              await Promise.race([scan.return?.(undefined), new Promise((r) => setTimeout(r, 2000))])
            }
          } finally {
            await execOk(`DROP VIEW ${slow}; DROP TABLE ${big}`)
          }
        }
        // An empty table still reports its columns.
        await execOk(`DELETE FROM ${t}`)
        const empty: RowBatch[] = []
        for await (const batch of db.iterateRows(ns, t, { batchSize: 4 })) empty.push(batch)
        expect(empty.map((b) => [b.columns.length, b.rows.length])).toEqual([[2, 0]])
        await execOk(`DROP TABLE ${t}`)
      })

      it.skipIf(dialect !== 'mysql')(
        'keeps a trigger written with database-qualified names database-relative',
        async () => {
          const t = `${scratch}_qtrg`
          const dbq = quoteIdent('mysql', ns.database)
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, v VARCHAR(10))`)
          await execOk(`CREATE TRIGGER ${dbq}.${t}_bi BEFORE INSERT ON ${dbq}.${t} FOR EACH ROW SET NEW.v = 'x'`)
          try {
            const trigger = (await db.listTriggers(ns, t)).find((x) => x.name === `${t}_bi`)
            expect(trigger).toBeDefined()
            const sql = db.exporter.trigger(ns, trigger as TriggerInfo, true).sql
            // MariaDB keeps the statement as typed (MySQL normalises it): the dump must not name the database.
            expect(sql).not.toContain(`${ns.database}.`)
            expect(sql).toMatch(/TRIGGER `?\w+_qtrg_bi`? BEFORE INSERT ON `?\w+_qtrg`? FOR EACH ROW/)
          } finally {
            await execOk(`DROP TABLE ${t}`)
          }
        }
      )

      it.skipIf(dialect !== 'postgres')(
        'lists a standalone sequence (not the one behind a serial) and dumps it with its owner and position',
        async () => {
          const seq = `${scratch}_pseq`
          const t = `${scratch}_pseqt`
          const serial = `${scratch}_serialt`
          await execOk(
            `CREATE SEQUENCE ${seq} START 100 INCREMENT 5;
             CREATE TABLE ${t} (id bigint DEFAULT nextval('${seq}') PRIMARY KEY, v text);
             ALTER SEQUENCE ${seq} OWNED BY ${t}.id;
             CREATE TABLE ${serial} (id serial PRIMARY KEY);
             INSERT INTO ${t} (v) VALUES ('a'), ('b')`
          )
          try {
            const listed = await db.listTables(ns)
            expect(listed.find((x) => x.name === seq)?.kind).toBe('sequence')
            // A serial's own sequence belongs to its column and is not an object of the listing.
            expect(listed.some((x) => x.name === `${serial}_id_seq`)).toBe(false)
            const schema = await db.describeTable(ns, t)
            expect(schema.columns[0]).toMatchObject({ name: 'id', extra: '', default: `nextval('${seq}'::regclass)` })
            expect((await db.describeTable(ns, serial)).columns[0]?.extra).toBe('serial')
            expect((await db.describeTable(ns, seq)).kind).toBe('sequence')
            const created = await db.showCreateTable(ns, seq)
            expect(created[0]).toBe(
              `CREATE SEQUENCE "public"."${seq}" AS bigint INCREMENT BY 5 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100 CACHE 1`
            )
            expect(created[1]).toBe(`ALTER SEQUENCE "public"."${seq}" OWNED BY "public"."${t}"."id"`)
            expect(created[2]).toBe(`SELECT pg_catalog.setval('"public"."${seq}"', 105, true)`)
            // The table keeps its default as written, so the dump restores against the recreated sequence.
            expect((await db.showCreateTable(ns, t, schema)).join('\n')).toContain(
              `DEFAULT nextval('${seq}'::regclass)`
            )
            // A serial column that owns a second sequence keeps the options of the one its default calls.
            await execOk(
              `ALTER SEQUENCE ${serial}_id_seq INCREMENT BY 3; CREATE SEQUENCE ${seq}_2 INCREMENT BY 10 OWNED BY ${serial}.id`
            )
            expect((await db.showCreateTable(ns, serial)).join('\n')).toContain('AS IDENTITY (INCREMENT BY 3)')
            const advance = db.exporter.afterData(ns, await db.describeTable(ns, serial))
            expect(advance.join('\n')).toContain(`'${serial}_id_seq'::regclass`)
            // An identity column owning an extra sequence keeps its own options; a serial column whose default was
            // repointed elsewhere is a plain default again, and the sequence it no longer uses is listed.
            await execOk(
              `CREATE TABLE ${t}_ident (id int GENERATED ALWAYS AS IDENTITY (INCREMENT BY 5) PRIMARY KEY);
               CREATE SEQUENCE ${seq}_3 INCREMENT BY 10 MINVALUE 7 OWNED BY ${t}_ident.id;
               ALTER TABLE ${serial} ALTER COLUMN id SET DEFAULT nextval('${seq}')`
            )
            expect((await db.showCreateTable(ns, `${t}_ident`)).join('\n')).toContain('AS IDENTITY (INCREMENT BY 5)')
            const repointed = await db.describeTable(ns, serial)
            expect(repointed.columns[0]).toMatchObject({ extra: '', default: `nextval('${seq}'::regclass)` })
            expect((await db.listTables(ns)).some((x) => x.name === `${serial}_id_seq`)).toBe(true)
          } finally {
            await execOk(
              `DROP TABLE IF EXISTS ${t}_ident; DROP TABLE ${serial}; DROP TABLE ${t}; DROP SEQUENCE IF EXISTS ${seq}`
            )
          }
        }
      )

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
        const key = input(rows.rows.find((r) => r[1] === 128)?.[0])
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

      it('caps long text when browsing (with its full length) but exports it whole', async () => {
        const t = `${scratch}_txt`
        const long = `REPEAT('y', ${MAX_TEXT_CHARS + 5})`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, s ${dialect === 'mysql' ? 'MEDIUMTEXT' : 'TEXT'} NULL)`)
        await execOk(`INSERT INTO ${t} (id, s) VALUES (1, ${long}), (2, 'short')`)
        const browsed = (await browseAll(t)).rows.map((r) => r[1] ?? null)
        expect(browsed[1]).toBe('short')
        const cut = browsed[0] ?? null
        expect(isTruncatedCell(cut)).toBe(true)
        expect(isTruncatedCell(cut) ? { chars: cut.$text.length, length: cut.length } : null).toEqual({
          chars: MAX_TEXT_CHARS,
          length: MAX_TEXT_CHARS + 5,
        })
        // The SQL console applies the same cap; a cut value can never be written back through a row key.
        const [viaSql] = await execOk(`SELECT s FROM ${t} WHERE id = 1`)
        expect(viaSql?.kind === 'rows' && isTruncatedCell(viaSql.result.rows[0]?.[0] ?? null)).toBe(true)
        await expect(
          db.updateRow(ns, t, { kind: 'pk', values: { id: 1 } }, { s: cut as unknown as InputCell })
        ).rejects.toMatchObject({ code: 'VALIDATION' })
        let exported: Cell = null
        for await (const b of db.iterateRows(ns, t, { batchSize: 10 })) exported = b.rows[0]?.[1] ?? null
        expect(typeof exported === 'string' ? exported.length : -1).toBe(MAX_TEXT_CHARS + 5)
        await execOk(`DROP TABLE ${t}`)
      })

      it('reads catalog text (a view definition, a routine body) whole however long it is', async () => {
        const v = `${scratch}_bigview`
        const fn = `${scratch}_bigfn`
        const literal = 'y'.repeat(MAX_TEXT_CHARS + 100)
        await execOk(`CREATE VIEW ${v} AS SELECT '${literal}' AS s`)
        await execOk(
          dialect === 'mysql'
            ? `CREATE FUNCTION ${fn}() RETURNS TEXT DETERMINISTIC RETURN '${literal}'`
            : `CREATE FUNCTION ${fn}() RETURNS text LANGUAGE sql AS $$ SELECT '${literal}' $$`
        )
        try {
          expect((await db.showCreateTable(ns, v)).join('\n')).toContain(literal)
          expect(await db.routineDefinition(ns, fn, 'function')).toContain(literal)
          // The same text through the console is capped: display and catalog are different reads.
          const [shown] = await execOk(`SELECT s FROM ${v}`)
          expect(shown?.kind === 'rows' && isTruncatedCell(shown.result.rows[0]?.[0] ?? null)).toBe(true)
        } finally {
          await execOk(`DROP VIEW ${v}`)
          await execOk(dialect === 'mysql' ? `DROP FUNCTION ${fn}` : `DROP FUNCTION ${fn}()`)
        }
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

    describe('serverCatalog', () => {
      it('lists collations, engines (access methods) and plugins (extensions), row by row as wide as the columns', async () => {
        const find = async (kind: 'collations' | 'engines' | 'plugins', column: string) => {
          const catalog = await db.serverCatalog(kind)
          for (const row of catalog.rows) expect(row).toHaveLength(catalog.columns.length)
          const at = catalog.columns.indexOf(column as never)
          expect(at, `${kind} has ${column}`).toBeGreaterThanOrEqual(0)
          return catalog.rows.map((r) => r[at])
        }
        // Something every server of the dialect has.
        expect(await find('collations', 'collation')).toContain(dialect === 'mysql' ? 'utf8mb4_bin' : 'C')
        expect(await find('engines', 'name')).toContain(dialect === 'mysql' ? 'InnoDB' : 'btree')
        expect(await find('plugins', 'name')).toContain(dialect === 'mysql' ? 'InnoDB' : 'plpgsql')
      })
    })

    describe('diagnostics', () => {
      it('answers with a status instead of an error for what this server lacks or the account may not read', async () => {
        if (dialect === 'postgres') {
          // pg_stat_statements is not installed in the compose server; everything else is MySQL's.
          expect(['ok', 'noExtension', 'denied']).toContain((await db.diagnostics('statements')).status)
          for (const kind of ['slowLog', 'generalLog', 'engineStatus', 'binlogEvents'] as const)
            expect((await db.diagnostics(kind)).status).toBe('unsupported')
          return
        }
        expect((await db.diagnostics('statements')).status).toBe('unsupported')
        const engine = await db.diagnostics('engineStatus')
        expect(['ok', 'denied']).toContain(engine.status)
        if (engine.status === 'ok') expect(engine.text).toMatch(/INNODB/i)

        // MariaDB keeps no binary log until asked; MySQL 8 does.
        const events = await db.diagnostics('binlogEvents')
        expect(['ok', 'disabled', 'denied']).toContain(events.status)
        if (events.status === 'ok') {
          expect(events.columns).toEqual(['logName', 'position', 'eventType', 'serverId', 'endPosition', 'info'])
          expect(events.rows.length).toBeGreaterThan(0)
          // The file name is only taken from what SHOW BINARY LOGS lists.
          await expect(db.diagnostics('binlogEvents', { file: "nope'; SELECT 1 -- " })).rejects.toThrow(
            /Unknown binary log/
          )
        }

        // A log that is off, or goes to a file, says so.
        expect(['ok', 'disabled', 'notTable', 'denied']).toContain((await db.diagnostics('slowLog')).status)
        expect(['ok', 'disabled', 'notTable', 'denied']).toContain((await db.diagnostics('generalLog')).status)
      })

      it('groups the statements of the slow log table when it is switched on', async () => {
        if (dialect !== 'mysql') return
        const value = async (sql: string) => {
          const first = (await exec(sql))[0]
          return first?.kind === 'rows' ? first.result.rows[0]?.[0] : undefined
        }
        const on = await value('SELECT @@GLOBAL.slow_query_log')
        const output = await value('SELECT @@GLOBAL.log_output')
        const marker = `slowmark_${scratch}`
        const set = await exec("SET GLOBAL log_output = 'TABLE'; SET GLOBAL slow_query_log = 1", { stopOnError: false })
        // The account may not change server variables (the CI MariaDB user): nothing to enable, nothing to check.
        if (set.some((r) => r.kind === 'error')) return
        try {
          await exec(`SET SESSION long_query_time = 0; SELECT '${marker}'`, { stopOnError: false })
          const report = await db.diagnostics('slowLog')
          expect(report.status).toBe('ok')
          expect(report.columns).toEqual(['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rowsExamined'])
          expect(report.rows.some((r) => r[0]?.includes(marker) && Number(r[1]) >= 1)).toBe(true)
        } finally {
          await exec(
            `SET GLOBAL slow_query_log = ${on === 1 || on === '1' ? 1 : 0}; SET GLOBAL log_output = '${String(output).replaceAll("'", '')}'`,
            {
              stopOnError: false,
            }
          )
        }
      })
    })

    describe('replicationInfo', () => {
      it('reports a lone server as standalone, with its logs, and hides what an account may not read', async () => {
        const info = await db.replicationInfo()
        // The compose servers replicate nothing.
        expect(info.role).toBe('standalone')
        expect(info.source ?? []).toEqual([])
        expect(info.replicas ?? []).toEqual([])
        // MySQL 8 keeps binary logs by default (MariaDB does not: null there); PostgreSQL always has WAL.
        if (dialect === 'postgres' || !(await isMariaDb())) {
          expect(info.logs?.length ?? 0).toBeGreaterThan(0)
          expect(info.logs?.[0]?.name).toMatch(dialect === 'mysql' ? /\.\d+$/ : /^[0-9A-F]{24}$/)
        }
        // An account without the privilege gets the parts it cannot read as null, not an error.
        const name = `rep_${scratch}`
        if (dialect === 'mysql') {
          await execOk(
            `CREATE USER ${mysqlAccount({ name, host: '%' })} IDENTIFIED BY 'rp-pw'; GRANT SELECT ON ${quoteIdent(dialect, ns.database)}.* TO ${mysqlAccount({ name, host: '%' })}`
          )
        } else {
          await execOk(
            `CREATE ROLE ${quoteIdent(dialect, name)} LOGIN PASSWORD 'rp-pw'; GRANT CONNECT ON DATABASE ${quoteIdent(dialect, ns.database)} TO ${quoteIdent(dialect, name)}`
          )
        }
        const plain = ctx.createAs(name, 'rp-pw')
        try {
          const limited = await plain.replicationInfo()
          // MySQL keeps the replication state from such an account, so its role cannot be told (PostgreSQL shows
          // the views to anyone, with the details blanked, and the role stays known).
          expect(limited.role).toBe(dialect === 'mysql' ? 'unknown' : 'standalone')
          expect(limited.logs).toBeNull()
        } finally {
          await plain.close()
          if (dialect === 'mysql') await exec(`DROP USER IF EXISTS ${mysqlAccount({ name, host: '%' })}`)
          else
            await exec(`DROP OWNED BY ${quoteIdent(dialect, name)}; DROP ROLE IF EXISTS ${quoteIdent(dialect, name)}`)
        }
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

      it("cancels only the statement in 'query' mode, leaving the connection usable", async () => {
        const victim = ctx.create()
        const marker = `cancel_${scratch}`
        const slow = victim.executeSql(ns, `${ctx.slowSql} /* ${marker} */`, { ...EXEC, timeoutMs: 60_000 })
        let target: string | undefined
        for (let i = 0; i < 40 && !target; i++) {
          await new Promise((r) => setTimeout(r, 100))
          target = (await db.listProcesses()).find((p) => p.query?.includes(marker))?.id
        }
        expect(target).toBeDefined()
        await db.killProcess(target as string, 'query')
        await slow
        // The connection itself is still there — that is the whole difference from a connection kill.
        const alive = async () => (await db.listProcesses()).some((p) => p.id === target)
        expect(await alive()).toBe(true)

        // ...and killing the connection does remove it.
        await db.killProcess(target as string, 'connection')
        let gone = false
        for (let i = 0; i < 40 && !gone; i++) {
          await new Promise((r) => setTimeout(r, 100))
          gone = !(await alive())
        }
        expect(gone).toBe(true)
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

    describe('canManageAccount', () => {
      const q = (n: string) => quoteIdent(dialect, n)
      /** A login account of its own, created and dropped around each case. */
      const account = async (name: string, extra = '') => {
        // Reading the fixture database is only there so the connection opens; it grants no say over accounts.
        if (dialect === 'mysql')
          await execOk(
            `CREATE USER ${mysqlAccount({ name, host: '%' })} IDENTIFIED BY 'cm-pw'; GRANT SELECT ON ${q(ns.database)}.* TO ${mysqlAccount({ name, host: '%' })}`
          )
        else
          await execOk(
            `CREATE ROLE ${q(name)} LOGIN PASSWORD 'cm-pw' ${extra}; GRANT CONNECT ON DATABASE ${q(ns.database)} TO ${q(name)}`
          )
        return ctx.createAs(name, 'cm-pw')
      }
      const drop = async (...names: string[]) => {
        for (const name of names) {
          if (dialect === 'mysql') await exec(`DROP USER IF EXISTS ${mysqlAccount({ name, host: '%' })}`)
          else await exec(`DROP OWNED BY ${q(name)}; DROP ROLE IF EXISTS ${q(name)}`, { stopOnError: false })
        }
      }

      it('is true for the fixture account, and false for one without the authority', async () => {
        expect(await db.canManageAccount('tsmyadmin')).toBe(true)
        const name = `cm_${scratch}`
        const plain = await account(name)
        try {
          expect(await plain.canManageAccount('tsmyadmin')).toBe(false)
          expect(await plain.canManageAccount(name)).toBe(false)
        } finally {
          await plain.close()
          await drop(name)
        }
      })

      it('follows what the database itself would let that account alter', async () => {
        const name = `cm2_${scratch}`
        const other = `cm3_${scratch}`
        if (dialect === 'mysql') {
          const admin = await account(name)
          try {
            await execOk(`GRANT CREATE USER ON *.* TO ${mysqlAccount({ name, host: '%' })}`)
            // MySQL 8 protects SYSTEM_USER accounts from those without it; MariaDB has no such privilege.
            const mariadb = await isMariaDb()
            expect(await admin.canManageAccount('tsmyadmin')).toBe(mariadb)
            if (!mariadb) {
              await execOk(`GRANT SYSTEM_USER ON *.* TO ${mysqlAccount({ name, host: '%' })}`)
              expect(await admin.canManageAccount('tsmyadmin')).toBe(true)
            }
          } finally {
            await admin.close()
            await drop(name)
          }
          return
        }
        const admin = await account(name, 'CREATEROLE')
        const version = await exec('SHOW server_version_num')
        const numeric = version[0]?.kind === 'rows' ? Number(version[0].result.rows[0]?.[0]) : 0
        try {
          // Never a superuser, whatever else it may alter.
          expect(await admin.canManageAccount('tsmyadmin')).toBe(false)
          // A role it created itself: its own to manage on every version.
          const made = await admin.executeSql(ns, `CREATE ROLE ${q(other)} LOGIN`, EXEC)
          expect(made[0]?.kind).toBe('affected')
          expect(await admin.canManageAccount(other)).toBe(true)
          // One someone else created: from 16 on, CREATEROLE alone no longer reaches it.
          await execOk(`CREATE ROLE ${q(`${other}x`)} LOGIN`)
          expect(await admin.canManageAccount(`${other}x`)).toBe(numeric < 160000)
          // No role by that name: left to superusers.
          expect(await admin.canManageAccount(`${other}_missing`)).toBe(false)
        } finally {
          await admin.close()
          await drop(other, `${other}x`, name)
        }
      })
    })

    describe('users', () => {
      it('locks, limits, renames and copies an account, and edits its global and routine privileges', async () => {
        const name = `acc_${scratch}`
        const renamed = `${name}_rn`
        const copied = `${name}_cp`
        const fn = `${scratch}_accfn`
        const ref = (n: string) => (dialect === 'mysql' ? { name: n, host: '%' } : { name: n })
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
              .build(op)
              .map((x) => x.sql)
              .join(';\n'),
            EXEC
          )
          for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
        }
        const find = async (n: string) => (await db.listUsers()).find((u) => u.name === n)
        try {
          await runOp({
            op: 'createUser',
            user: ref(name),
            password: 'acc-pw-1',
            attributes: { superuser: false, createdb: false, createrole: false },
          })
          // Locked accounts cannot log in; unlocked ones can again.
          await runOp({ op: 'lockUser', user: ref(name), locked: true })
          expect((await find(name))?.canLogin).toBe(false)
          await runOp({ op: 'lockUser', user: ref(name), locked: false })
          expect((await find(name))?.canLogin).toBe(true)

          // Limits: MySQL's whole set, PostgreSQL's connection limit only (which refuses the rest).
          if (dialect === 'mysql') {
            await runOp({
              op: 'setAccountLimits',
              user: ref(name),
              require: 'SSL',
              maxQueries: 100,
              maxUserConnections: 3,
            })
            expect((await find(name))?.limits).toMatchObject({ require: 'SSL', maxQueries: 100, maxUserConnections: 3 })
            await runOp({
              op: 'setAccountLimits',
              user: ref(name),
              require: 'NONE',
              maxQueries: 0,
              maxUserConnections: 0,
            })
            expect((await find(name))?.limits).toMatchObject({ require: 'NONE', maxQueries: 0, maxUserConnections: 0 })
          } else {
            await runOp({ op: 'setAccountLimits', user: ref(name), maxUserConnections: 3 })
            expect((await find(name))?.limits?.maxUserConnections).toBe(3)
            expect(() => db.users.build({ op: 'setAccountLimits', user: ref(name), maxQueries: 5 })).toThrow(
              /limits only/
            )
          }

          // Global privileges (MySQL) / role attributes (PostgreSQL), one at a time.
          if (dialect === 'mysql') {
            await runOp({ op: 'changeGlobalPrivileges', user: ref(name), grant: ['PROCESS', 'RELOAD'], revoke: [] })
            const granted = (await db.showGrants(ref(name))).join('\n')
            expect(granted).toMatch(/PROCESS/)
            await runOp({ op: 'changeGlobalPrivileges', user: ref(name), grant: [], revoke: ['RELOAD'] })
            expect((await db.showGrants(ref(name))).join('\n')).not.toMatch(/RELOAD/)
          } else {
            await runOp({ op: 'alterRole', user: ref(name), createdb: true })
            expect((await find(name))?.attributes).toContain('CREATEDB')
            await runOp({ op: 'alterRole', user: ref(name), createdb: false })
            expect((await find(name))?.attributes).not.toContain('CREATEDB')
          }

          // Privileges on one routine.
          await execOk(
            dialect === 'mysql'
              ? `CREATE FUNCTION ${fn}(n INT) RETURNS INT DETERMINISTIC RETURN n`
              : `CREATE FUNCTION ${fn}(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n'`
          )
          const routine = {
            user: ref(name),
            privileges: ['EXECUTE' as const],
            database: ns.database,
            ...(ns.schema ? { schema: ns.schema } : {}),
            routine: fn,
            kind: 'FUNCTION' as const,
            ...(dialect === 'postgres' ? { parameters: 'n integer' } : {}),
          }
          await runOp({ op: 'grantRoutinePrivileges', ...routine })
          const acl = async () =>
            dialect === 'mysql'
              ? (await db.showGrants(ref(name))).join('\n')
              : String(
                  (await exec(`SELECT proacl::text FROM pg_proc WHERE proname = '${fn}'`).then((r) => {
                    const first = r[0]
                    return first?.kind === 'rows' ? first.result.rows[0]?.[0] : ''
                  })) ?? ''
                )
          expect(await acl()).toMatch(dialect === 'mysql' ? /EXECUTE ON FUNCTION/ : new RegExp(`${name}=X/`))
          await runOp({ op: 'revokeRoutinePrivileges', ...routine })
          expect(await acl()).not.toMatch(dialect === 'mysql' ? /EXECUTE ON FUNCTION/ : new RegExp(`${name}=X/`))

          // Renamed, then copied with what it holds.
          await runOp({ op: 'renameUser', user: ref(name), newUser: ref(renamed) })
          expect(await find(name)).toBeUndefined()
          expect(await find(renamed)).toBeDefined()
          await runOp({
            op: 'copyUser',
            user: ref(renamed),
            newUser: ref(copied),
            password: 'acc-pw-2',
            grants: await db.showGrants(ref(renamed)),
          })
          const copy = await find(copied)
          expect(copy).toBeDefined()
          expect(copy?.canLogin).toBe(true)
          if (dialect === 'mysql') expect((await db.showGrants(ref(copied))).join('\n')).toMatch(/PROCESS/)
        } finally {
          await exec(`DROP FUNCTION IF EXISTS ${fn}`, { stopOnError: false })
          for (const n of [name, renamed, copied])
            await exec(
              [
                ...(dialect === 'postgres'
                  ? db.users.build({
                      op: 'revokeAll',
                      user: ref(n),
                      database: ns.database,
                      ...(ns.schema ? { schema: ns.schema } : {}),
                    })
                  : []),
                ...db.users.build({ op: 'dropUser', user: ref(n) }),
              ]
                .map((x) => x.sql)
                .join(';\n'),
              { stopOnError: false }
            )
        }
      })

      it('creates an account with a database of its own name and a wildcard grant (MySQL)', async () => {
        if (dialect !== 'mysql') return
        const name = `own_${scratch}`.slice(0, 30)
        const user = { name, host: '%' }
        const build = db.users.build({
          op: 'createUser',
          user,
          password: 'own-pw',
          attributes: { superuser: false, createdb: false, createrole: false },
          createDatabase: true,
          grantWildcard: true,
        })
        try {
          for (const statement of build) await execOk(statement.sql)
          expect((await db.listDatabases()).map((d) => d.name)).toContain(name)
          const grants = (await db.showGrants(user)).join('\n')
          // The database's own name, and the wildcard over `name_…` (underscores escaped in the pattern).
          expect(grants).toContain(`${name}`)
          expect(grants).toMatch(/\\_%/)
        } finally {
          for (const statement of db.ddl.build(ns, { op: 'dropDatabase', name }))
            await exec(statement, { stopOnError: false })
          for (const statement of db.users.build({ op: 'dropUser', user }))
            await exec(statement.sql, { stopOnError: false })
        }
      })

      it('drops several accounts at once, taking their privileges away first and their same-named databases with them', async () => {
        const one = `bd1_${scratch}`.slice(0, 28)
        const two = `bd2_${scratch}`.slice(0, 28)
        const refs = [one, two].map((n) => (dialect === 'mysql' ? { name: n, host: '%' } : { name: n }))
        const attributes = { superuser: false, createdb: false, createrole: false }
        const listed = async () => new Set((await db.listUsers()).map((u) => u.name))
        try {
          for (const user of refs)
            for (const st of db.users.build({ op: 'createUser', user, password: 'bulk-pw-1', attributes }))
              await execOk(st.sql)
          // Holding a privilege on a table is what stops PostgreSQL from dropping a role; MySQL drops it anyway.
          for (const user of refs)
            await execOk(
              db.users.build({
                op: 'grantPrivileges',
                user,
                privileges: ['SELECT'],
                database: ns.database,
                ...(ns.schema ? { schema: ns.schema } : {}),
                table: scratch,
              })[0]?.sql ?? ''
            )
          if (dialect === 'postgres') {
            const refused = await exec(db.users.build({ op: 'dropUsers', users: refs })[0]?.sql ?? '', {
              stopOnError: false,
            })
            expect(refused[0]?.kind).toBe('error')
            expect(await listed()).toContain(one)
          }
          for (const st of db.users.build({ op: 'dropUsers', users: refs, revokeFirst: true })) await execOk(st.sql)
          const after = await listed()
          expect(after.has(one)).toBe(false)
          expect(after.has(two)).toBe(false)
        } finally {
          for (const user of refs)
            for (const st of db.users.build({ op: 'dropUser', user })) await exec(st.sql, { stopOnError: false })
        }
      })

      it("drops the database that has an account's name along with it (MySQL)", async () => {
        if (dialect !== 'mysql') return
        const name = `bdd_${scratch}`.slice(0, 28)
        const user = { name, host: '%' }
        try {
          for (const st of db.users.build({
            op: 'createUser',
            user,
            password: 'bulk-pw-2',
            attributes: { superuser: false, createdb: false, createrole: false },
            createDatabase: true,
          }))
            await execOk(st.sql)
          expect((await db.listDatabases()).map((d) => d.name)).toContain(name)
          for (const st of db.users.build({ op: 'dropUsers', users: [user], dropSameNameDatabases: true }))
            await execOk(st.sql)
          expect((await db.listDatabases()).map((d) => d.name)).not.toContain(name)
        } finally {
          for (const st of db.ddl.build(ns, { op: 'dropDatabase', name })) await exec(st, { stopOnError: false })
          for (const st of db.users.build({ op: 'dropUser', user })) await exec(st.sql, { stopOnError: false })
        }
      })

      it('grants exactly the privileges asked for: a read-only account can select but not write', async () => {
        // The point of per-table grants is this account. Checked by connecting as it, not by reading the SQL.
        const name = `ro_${scratch}`
        const password = 'r3ad only!'
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
              .build(op)
              .map((x) => x.sql)
              .join(';\n'),
            EXEC
          )
          for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
        }
        await runOp({
          op: 'createUser',
          user,
          password,
          attributes: { superuser: false, createdb: false, createrole: false },
        })
        let reader: DatabaseAdapter | undefined
        try {
          await runOp({
            op: 'grantPrivileges',
            user,
            privileges: ['SELECT'],
            database: ns.database,
            ...(ns.schema ? { schema: ns.schema } : {}),
            table: 'users',
          })
          reader = ctx.createAs(name, password)
          // Refused either as a failed statement or, once the account loses the database entirely, as a
          // connection that cannot be opened — both mean "not allowed".
          const refused = async (sql: string) => {
            try {
              const r = await (reader as DatabaseAdapter).executeSql(ns, sql, { ...EXEC, stopOnError: false })
              return r.some((x) => x.kind === 'error')
            } catch {
              return true
            }
          }
          const rows = await reader.executeSql(ns, 'SELECT COUNT(*) FROM users', EXEC)
          expect(rows[0]?.kind).toBe('rows')
          // Only what was granted: writing that table, and reading a different one, are both refused.
          expect(await refused('UPDATE users SET name = name WHERE id = -1')).toBe(true)
          expect(await refused('SELECT COUNT(*) FROM posts')).toBe(true)

          // Revoking it takes the read away again.
          await runOp({
            op: 'revokePrivileges',
            user,
            privileges: ['SELECT'],
            database: ns.database,
            ...(ns.schema ? { schema: ns.schema } : {}),
            table: 'users',
          })
          expect(await refused('SELECT COUNT(*) FROM users')).toBe(true)
        } finally {
          await reader?.close()
          // PostgreSQL refuses to drop a role that still holds privileges, so they go first.
          await exec(
            [
              ...db.users.build({
                op: 'revokeAll',
                user,
                database: ns.database,
                ...(ns.schema ? { schema: ns.schema } : {}),
              }),
              ...db.users.build({ op: 'dropUser', user }),
            ]
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })

      it('creates an account a replica can connect with, and shows the replication right', async () => {
        const name = `repl_${scratch}`
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const op = {
          op: 'createUser',
          user,
          password: 'r3pl pw!',
          attributes: { superuser: false, createdb: false, createrole: false },
          replication: true,
        } as const
        try {
          const r = await db.executeSql(
            db.users.namespace(op, db.serverNamespace),
            db.users
              .build(op)
              .map((x) => x.sql)
              .join(';\n'),
            EXEC
          )
          for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
          expect((await db.showGrants(user)).join('\n')).toMatch(
            dialect === 'mysql' ? /GRANT .*REPLICATION (SLAVE|REPLICA)/i : /ALTER ROLE .* REPLICATION/
          )
        } finally {
          await exec(
            db.users
              .build({ op: 'dropUser', user })
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })

      it('grants WITH GRANT OPTION on a table, shows it, and takes only the grant option away again', async () => {
        const name = `gopt_${scratch}`
        const password = 'gr4nt opt!'
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
              .build(op)
              .map((x) => x.sql)
              .join(';\n'),
            EXEC
          )
          for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
        }
        const target = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), table: 'users' }
        await runOp({
          op: 'createUser',
          user,
          password,
          attributes: { superuser: false, createdb: false, createrole: false },
        })
        try {
          await runOp({ op: 'grantPrivileges', user, privileges: ['SELECT'], grantOption: true, ...target })
          const held = (await db.showGrants(user)).filter((g) => /users/.test(g))
          expect(held.join('\n')).toMatch(/GRANT SELECT ON .*users.* TO .* WITH GRANT OPTION/i)

          await runOp({ op: 'revokePrivileges', user, privileges: ['SELECT'], grantOption: true, ...target })
          const after = (await db.showGrants(user)).filter((g) => /users/.test(g))
          // The privilege is still held; only the right to pass it on is gone.
          expect(after.join('\n')).toMatch(/GRANT SELECT ON .*users/i)
          expect(after.join('\n')).not.toMatch(/WITH GRANT OPTION/i)
        } finally {
          await exec(
            [
              ...db.users.build({
                op: 'revokeAll',
                user,
                database: ns.database,
                ...(ns.schema ? { schema: ns.schema } : {}),
              }),
              ...db.users.build({ op: 'dropUser', user }),
            ]
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })

      it('grants a named column only: the account reads that column and not its neighbours', async () => {
        const name = `col_${scratch}`
        const password = 'c0l only!'
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const runOp = async (op: Parameters<typeof db.users.build>[0]) => {
          const target = db.users.namespace(op, db.serverNamespace)
          const r = await db.executeSql(
            target,
            db.users
              .build(op)
              .map((x) => x.sql)
              .join(';\n'),
            EXEC
          )
          for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
        }
        const target = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), table: 'users' }
        await runOp({
          op: 'createUser',
          user,
          password,
          attributes: { superuser: false, createdb: false, createrole: false },
        })
        let reader: DatabaseAdapter | undefined
        try {
          await runOp({ op: 'grantPrivileges', user, privileges: ['SELECT'], columns: ['name'], ...target })
          reader = ctx.createAs(name, password)
          const refused = async (sql: string) => {
            try {
              const r = await (reader as DatabaseAdapter).executeSql(ns, sql, { ...EXEC, stopOnError: false })
              return r.some((x) => x.kind === 'error')
            } catch {
              return true
            }
          }
          // Named columns, not COUNT(*): whether a bare count is allowed under a column grant differs by server
          // and is not what this is testing.
          const granted = await reader.executeSql(ns, 'SELECT name FROM users', EXEC)
          expect(granted[0]?.kind).toBe('rows')
          expect(await refused('SELECT email FROM users')).toBe(true)
          expect(await refused('SELECT * FROM users')).toBe(true)
          // The grant is per column *and* per privilege: reading `name` does not allow writing it.
          expect(await refused('UPDATE users SET name = name WHERE id = -1')).toBe(true)

          // The privileges screen reads showGrants, so a column grant has to be visible there or the feature
          // looks like it did nothing.
          expect((await db.showGrants(user)).join('\n')).toMatch(/GRANT SELECT \(.?name.?\) ON/i)

          await runOp({ op: 'revokePrivileges', user, privileges: ['SELECT'], columns: ['name'], ...target })
          expect(await refused('SELECT name FROM users')).toBe(true)
        } finally {
          await reader?.close()
          await exec(
            [
              ...db.users.build({
                op: 'revokeAll',
                user,
                database: ns.database,
                ...(ns.schema ? { schema: ns.schema } : {}),
              }),
              ...db.users.build({ op: 'dropUser', user }),
            ]
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })

      it('accepts columns for exactly the privileges COLUMN_PRIVILEGES lists', async () => {
        // The closed list in `packages/shared` is a claim about both servers; this is the claim being checked.
        const name = `colset_${scratch}`
        const user = dialect === 'mysql' ? { name, host: '%' } : { name }
        const account = dialect === 'mysql' ? `'${name}'@'%'` : `"${name}"`
        const table = dialect === 'mysql' ? `\`${ns.database}\`.\`users\`` : `"${ns.schema ?? 'public'}"."users"`
        await exec(
          db.users
            .build({
              op: 'createUser',
              user,
              password: 'c0lset!',
              attributes: { superuser: false, createdb: false, createrole: false },
            })
            .map((x) => x.sql)
            .join(';\n')
        )
        try {
          const target = db.users.namespace(
            { op: 'grantPrivileges', user, privileges: ['SELECT'], database: ns.database },
            db.serverNamespace
          )
          const attempt = async (privilege: string, columns: boolean) => {
            const r = await db.executeSql(
              target,
              `GRANT ${privilege}${columns ? ' (name)' : ''} ON ${table} TO ${account}`,
              { ...EXEC, stopOnError: false }
            )
            return r.every((x) => x.kind !== 'error')
          }
          for (const privilege of COLUMN_PRIVILEGES) {
            expect([privilege, await attempt(privilege, true)]).toEqual([privilege, true])
          }
          // DELETE and TRIGGER act on the whole table, so naming a column is rejected. Each is also granted
          // *without* columns in the same breath: the column list is then the only difference between a
          // statement that works and one that does not, so this cannot pass because of some unrelated refusal
          // (a missing grant option, a mistyped table) that would have failed both forms.
          for (const privilege of ['DELETE', 'TRIGGER']) {
            expect([privilege, 'with columns', await attempt(privilege, true)]).toEqual([
              privilege,
              'with columns',
              false,
            ])
            expect([privilege, 'whole table', await attempt(privilege, false)]).toEqual([
              privilege,
              'whole table',
              true,
            ])
          }
        } finally {
          await exec(
            [
              ...db.users.build({
                op: 'revokeAll',
                user,
                database: ns.database,
                ...(ns.schema ? { schema: ns.schema } : {}),
              }),
              ...db.users.build({ op: 'dropUser', user }),
            ]
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
        }
      })

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
      /** As the web runs a preview: all of an op's statements as one script through the SQL route. */
      const runScript = async (op: DdlOp) => execOk(sqlScript(dialect, db.ddl.build(ns, op)))
      const firstValue = async (sql: string) => {
        const r = await execOk(sql)
        const rows = r.find((x) => x.kind === 'rows')
        return rows?.kind === 'rows' ? rows.result.rows[0]?.[0] : undefined
      }

      it('creates a view, a function and a procedure whose bodies hold statements of their own', async () => {
        const view = `${scratch}_v`
        const fn = `${scratch}_fn`
        const proc = `${scratch}_proc`
        try {
          await runScript({
            op: 'createView',
            name: view,
            select: 'SELECT id, name FROM users WHERE id <= 2;',
            orReplace: false,
          })
          expect(await firstValue(`SELECT COUNT(*) FROM ${view}`)).toBe(2)
          await runScript({
            op: 'createRoutine',
            kind: 'function',
            name: fn,
            params: [{ mode: 'IN', name: 'n', type: 'INT' }],
            returns: 'INT',
            body:
              dialect === 'mysql'
                ? 'BEGIN\n  DECLARE r INT;\n  SET r = n + 1;\n  RETURN r;\nEND;'
                : 'BEGIN\n  RETURN n + 1;\nEND;',
            language: 'plpgsql',
            deterministic: true,
            comment: "adds 'one'",
          })
          expect(Number(await firstValue(`SELECT ${fn}(41)`))).toBe(42)
          await runScript({
            op: 'createRoutine',
            kind: 'procedure',
            name: proc,
            params: [{ mode: 'IN', name: 'n', type: 'INT' }],
            body:
              dialect === 'mysql'
                ? 'BEGIN\n  SET @conformance_proc = n;\n  SET @conformance_proc = @conformance_proc * 2;\nEND'
                : "BEGIN\n  PERFORM set_config('conformance.proc', (n * 2)::text, false);\nEND",
            language: 'plpgsql',
            deterministic: false,
          })
          // One run: the variable is the connection's, and each run may get another one from the pool.
          const doubled =
            dialect === 'mysql'
              ? await firstValue(`CALL ${proc}(21); SELECT @conformance_proc`)
              : await firstValue(`CALL ${proc}(21); SELECT current_setting('conformance.proc')`)
          expect(Number(doubled)).toBe(42)
          const listed = (await db.listRoutines(ns)).map((r) => r.name)
          expect(listed).toEqual(expect.arrayContaining([fn, proc]))
        } finally {
          await exec(`DROP VIEW IF EXISTS ${view}`, { stopOnError: false })
          await exec(`DROP FUNCTION IF EXISTS ${fn}`, { stopOnError: false })
          await exec(`DROP PROCEDURE IF EXISTS ${proc}`, { stopOnError: false })
        }
      })

      it('sets, changes and drops routine characteristics; drops a trigger; makes a view with columns and a check option', async () => {
        const fn = `${scratch}_sec`
        const view = `${scratch}_cv`
        const table = `${scratch}_trgt`
        const trigger = `${scratch}_trg`
        const event = `${scratch}_evp`
        const security = async () =>
          dialect === 'mysql'
            ? await firstValue(
                `SELECT SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = '${fn}'`
              )
            : (await firstValue(`SELECT prosecdef FROM pg_proc WHERE proname = '${fn}'`)) === true
              ? 'DEFINER'
              : 'INVOKER'
        try {
          // MySQL: the connecting account as DEFINER (allowed without SUPER) and a data-access characteristic.
          const me = dialect === 'mysql' ? String(await firstValue('SELECT CURRENT_USER()')) : ''
          const at = me.lastIndexOf('@')
          await runScript({
            op: 'createRoutine',
            kind: 'function',
            name: fn,
            params: [{ mode: 'IN', name: 'n', type: 'INT' }],
            returns: 'INT',
            body: dialect === 'mysql' ? 'RETURN n + 1;' : 'BEGIN\n  RETURN n + 1;\nEND;',
            language: 'plpgsql',
            deterministic: true,
            sqlSecurity: 'INVOKER',
            ...(dialect === 'mysql'
              ? { definer: { user: me.slice(0, at), host: me.slice(at + 1) }, dataAccess: 'NO SQL' as const }
              : {}),
          })
          expect(await security()).toBe('INVOKER')
          const parameters = (await db.listRoutines(ns)).find((r) => r.name === fn)?.parameters
          await runScript({
            op: 'alterRoutine',
            kind: 'function',
            name: fn,
            ...(dialect === 'postgres' ? { parameters } : {}),
            sqlSecurity: 'DEFINER',
            comment: 'changed',
          })
          expect(await security()).toBe('DEFINER')
          expect((await db.listRoutines(ns)).find((r) => r.name === fn)?.comment).toBe('changed')
          await runScript({
            op: 'dropRoutine',
            kind: 'function',
            name: fn,
            ...(dialect === 'postgres' ? { parameters } : {}),
          })
          expect((await db.listRoutines(ns)).map((r) => r.name)).not.toContain(fn)

          await execOk(`CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
          await runScript({
            op: 'createTrigger',
            name: trigger,
            table,
            timing: 'BEFORE',
            event: 'INSERT',
            body: dialect === 'mysql' ? 'SET NEW.v = 1;' : 'BEGIN\n  NEW.v := 1;\n  RETURN NEW;\nEND;',
          })
          expect((await db.listTriggers(ns, table)).map((x) => x.name)).toContain(trigger)
          await runScript({ op: 'dropTrigger', name: trigger, table })
          expect((await db.listTriggers(ns, table)).map((x) => x.name)).not.toContain(trigger)

          // The view's own column names, and a check option: a change moving a row out of it is refused.
          await runScript({
            op: 'createView',
            name: view,
            select: 'SELECT id, name FROM users WHERE id <= 2',
            orReplace: false,
            columns: ['a', 'b'],
            checkOption: 'CASCADED',
          })
          expect(await firstValue(`SELECT COUNT(a) FROM ${view}`)).toBe(2)
          const refused = await exec(`UPDATE ${view} SET a = 999 WHERE a = 1`, { stopOnError: false })
          expect(refused[0]).toMatchObject({ kind: 'error', message: expect.stringMatching(/check option/i) })

          if (dialect === 'mysql') {
            // PRESERVE keeps a one-time event after it has run.
            await runScript({
              op: 'createEvent',
              name: event,
              schedule: { kind: 'at', at: '2037-01-01 00:00:00' },
              body: 'SELECT 1',
              enabled: false,
              preserve: true,
            })
            expect(
              await firstValue(
                `SELECT ON_COMPLETION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = '${event}'`
              )
            ).toBe('PRESERVE')
          }
        } finally {
          await exec(`DROP VIEW IF EXISTS ${view}`, { stopOnError: false })
          await exec(`DROP FUNCTION IF EXISTS ${fn}`, { stopOnError: false })
          await exec(`DROP TABLE IF EXISTS ${table}`, { stopOnError: false })
          if (dialect === 'mysql') await exec(`DROP EVENT IF EXISTS ${event}`, { stopOnError: false })
        }
      })

      it('normalizes: splits a table on a dependency (refusing one the rows break) and turns a repeating group into rows', async () => {
        const orders = `${scratch}_nord`
        const customers = `${scratch}_ncust`
        const bad = `${scratch}_nbad`
        const badCustomers = `${scratch}_nbadc`
        const contacts = `${scratch}_ncon`
        const phones = `${scratch}_nph`
        const count = async (table: string) => Number(await firstValue(`SELECT COUNT(*) FROM ${table}`))
        try {
          await execOk(
            `CREATE TABLE ${orders} (id INT PRIMARY KEY, customer_id INT, customer_name VARCHAR(20), customer_city VARCHAR(20))`
          )
          await execOk(
            `INSERT INTO ${orders} VALUES (1, 10, 'Ann', 'Oslo'), (2, 10, 'Ann', 'Oslo'), (3, 11, 'Bob', 'Rome'), (4, NULL, 'Zed', 'Nice')`
          )
          await runScript({
            op: 'splitTable',
            table: orders,
            newName: customers,
            keyColumns: ['customer_id'],
            columns: ['customer_name', 'customer_city'],
            dropMoved: true,
          })
          // One row per distinct key (a row without a key has nowhere to go), keyed by it, and the original points at it.
          expect(await count(customers)).toBe(2)
          expect((await db.describeTable(ns, customers)).primaryKey).toEqual(['customer_id'])
          const kept = await db.describeTable(ns, orders)
          expect(kept.columns.map((c) => c.name)).toEqual(['id', 'customer_id'])
          expect(kept.foreignKeys.map((f) => f.refTable)).toEqual([customers])
          expect(await count(orders)).toBe(4)

          // The same key with two different values: the primary key of the new table is what refuses it, and the
          // original keeps its columns because the statements after the failure never run.
          await execOk(`CREATE TABLE ${bad} (id INT PRIMARY KEY, k INT, v VARCHAR(20))`)
          await execOk(`INSERT INTO ${bad} VALUES (1, 10, 'Ann'), (2, 10, 'Anna')`)
          const statements = db.ddl.build(ns, {
            op: 'splitTable',
            table: bad,
            newName: badCustomers,
            keyColumns: ['k'],
            columns: ['v'],
            dropMoved: true,
          })
          await execOk(statements[0] ?? '')
          const refused = await exec(statements[1] ?? '', { stopOnError: false })
          expect(refused[0]).toMatchObject({ kind: 'error' })
          expect((await db.describeTable(ns, bad)).columns.map((c) => c.name)).toEqual(['id', 'k', 'v'])

          await execOk(`CREATE TABLE ${contacts} (id INT PRIMARY KEY, phone1 VARCHAR(20), phone2 VARCHAR(20))`)
          await execOk(`INSERT INTO ${contacts} VALUES (1, 'a', 'b'), (2, 'c', NULL)`)
          await runScript({
            op: 'moveRepeatingGroup',
            table: contacts,
            newName: phones,
            keyColumns: ['id'],
            columns: ['phone1', 'phone2'],
            valueColumn: 'phone',
            dropMoved: true,
          })
          expect(await count(phones)).toBe(3)
          expect((await db.describeTable(ns, phones)).columns.map((c) => c.name)).toEqual(['id', 'phone'])
          expect((await db.describeTable(ns, phones)).foreignKeys.map((f) => f.refTable)).toEqual([contacts])
          expect((await db.describeTable(ns, contacts)).columns.map((c) => c.name)).toEqual(['id'])
        } finally {
          // Referencing tables first.
          for (const table of [phones, contacts, badCustomers, bad, orders, customers])
            await exec(`DROP TABLE IF EXISTS ${table}`, { stopOnError: false })
        }
      })

      it('moves a table, rows and all, to another database (MySQL) or schema (PostgreSQL)', async () => {
        const t = `${scratch}_mv`
        const target = dialect === 'mysql' ? ctx.otherDatabase : `${scratch}_sch`
        const there: Namespace = dialect === 'mysql' ? { database: target } : { database: ns.database, schema: target }
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
        await execOk(`INSERT INTO ${t} (id) VALUES (1), (2)`)
        if (dialect === 'postgres') await execOk(`CREATE SCHEMA ${quoteIdent(dialect, target)}`)
        try {
          await runScript({ op: 'moveTable', table: t, to: target })
          expect((await db.listTables(ns)).map((x) => x.name)).not.toContain(t)
          expect((await db.listTables(there)).map((x) => x.name)).toContain(t)
          const moved = await db.browseRows(there, t, { offset: 0, limit: 10, sort: [], filters: [] })
          expect(moved.rows).toHaveLength(2)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${quoteTable(dialect, there, t)}`, { stopOnError: false })
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
          if (dialect === 'postgres') {
            await exec(`DROP SCHEMA IF EXISTS ${quoteIdent(dialect, target)}`, { stopOnError: false })
          }
        }
      })

      it("changes table options, every column's collation, the rows' order, and copies with the extra options", async () => {
        const t = `${scratch}_ops15`
        const ref = `${scratch}_ops15r`
        const copy = `${scratch}_ops15c`
        const [other, otherNs] =
          dialect === 'mysql'
            ? ['tsmyadmin_other', { database: 'tsmyadmin_other' }]
            : ['app', { database: ns.database, schema: 'app' }]
        try {
          await execOk(`CREATE TABLE ${ref} (id INT PRIMARY KEY)`)
          await execOk(`INSERT INTO ${ref} (id) VALUES (1), (2)`)
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20), ref_id INT)`)
          await execOk(`INSERT INTO ${t} (id, name, ref_id) VALUES (2, 'b', 1), (1, 'a', 2)`)
          const collation = dialect === 'mysql' ? 'utf8mb4_bin' : 'C'
          await runDdl({
            op: 'convertCollation',
            table: t,
            collation,
            columns: [{ name: 'name', dataType: 'varchar(20)' }],
          })
          expect((await db.describeTable(ns, t)).columns.find((c) => c.name === 'name')?.collation).toBe(collation)
          if (dialect === 'mysql') {
            await runDdl({ op: 'setTableOptions', table: t, rowFormat: 'DYNAMIC' })
            expect((await db.tableStats(ns, t)).rowFormat).toBe('Dynamic')
            await runDdl({ op: 'orderTable', table: t, column: 'name', desc: true })
            const [sum] = await exec(
              sqlScript(dialect, db.ddl.build(ns, { op: 'maintainTable', table: t, action: 'checksum' }))
            )
            expect(sum?.kind).toBe('rows')
          } else {
            const pk = (await db.describeTable(ns, t)).indexes.find((i) => i.primary)?.name ?? ''
            await runDdl({ op: 'orderTable', table: t, index: pk })
          }
          // Into another database / schema, dropping what is there, with the foreign key the source would have.
          await execOk(`CREATE TABLE ${dialect === 'mysql' ? 'tsmyadmin_other' : 'app'}.${copy} (x INT)`)
          await runDdl({
            op: 'copyTable',
            table: t,
            newName: copy,
            withData: true,
            ...(dialect === 'mysql' ? { toDatabase: other } : { toSchema: other }),
            dropExisting: true,
            foreignKeys: [{ name: `${copy}_fk`, columns: ['ref_id'], refTable: ref, refColumns: ['id'] }],
          })
          const copied = await db.describeTable(otherNs, copy)
          expect(copied.columns.map((c) => c.name)).toEqual(['id', 'name', 'ref_id'])
          expect(copied.foreignKeys[0]).toMatchObject({
            refTable: ref,
            refNamespace: dialect === 'mysql' ? ns : { database: ns.database, schema: ns.schema ?? 'public' },
          })
          // Rows only, into the copy that now exists.
          await execOk(`DELETE FROM ${dialect === 'mysql' ? 'tsmyadmin_other' : 'app'}.${copy}`)
          await runDdl({
            op: 'copyTable',
            table: t,
            newName: copy,
            withData: true,
            structure: false,
            ...(dialect === 'mysql' ? { toDatabase: other } : { toSchema: other }),
          })
          const [n] = await exec(`SELECT COUNT(*) FROM ${dialect === 'mysql' ? 'tsmyadmin_other' : 'app'}.${copy}`)
          expect(n?.kind === 'rows' ? Number(n.result.rows[0]?.[0]) : -1).toBe(2)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${dialect === 'mysql' ? 'tsmyadmin_other' : 'app'}.${copy}`, {
            stopOnError: false,
          })
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
          await exec(`DROP TABLE IF EXISTS ${ref}`, { stopOnError: false })
        }
      })

      it('changes the database collation (MySQL) and converts the tables and their text columns to it', async () => {
        const t = `${scratch}_dbcoll`
        const collation = dialect === 'mysql' ? 'utf8mb4_bin' : 'C'
        const schemaDefault = async () => {
          const [r] = await exec(
            'SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()'
          )
          return r?.kind === 'rows' ? String(r.result.rows[0]?.[0] ?? '') : ''
        }
        const before = dialect === 'mysql' ? await schemaDefault() : ''
        try {
          await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20))`)
          // Only the scratch table: converting the shared fixtures would change them for every other test.
          await runScript({
            op: 'setDatabaseCollation',
            name: ns.database,
            collation,
            applyToTables: true,
            tables: [t],
            ...(dialect === 'postgres'
              ? { columns: { [t]: [{ name: 'name', dataType: 'character varying(20)' }] } }
              : {}),
          })
          expect((await db.describeTable(ns, t)).columns.find((c) => c.name === 'name')?.collation).toBe(collation)
          if (dialect === 'mysql') expect(await schemaDefault()).toBe(collation)
          else
            expect(() =>
              db.ddl.build(ns, { op: 'setDatabaseCollation', name: ns.database, collation, applyToTables: false })
            ).toThrow(/cannot change/)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
          // The shared database goes back to the default it had.
          if (dialect === 'mysql' && before)
            await runScript({ op: 'setDatabaseCollation', name: ns.database, collation: before, applyToTables: false })
        }
      })

      it('maintains, renames and copies several tables at once', async () => {
        const [a, b] = [`${scratch}_bka`, `${scratch}_bkb`]
        const [pa, pb] = [`p_${a}`, `p_${b}`]
        const other = dialect === 'mysql' ? 'tsmyadmin_other' : 'app'
        const drop = async () => {
          for (const x of [a, b, pa, pb]) await exec(`DROP TABLE IF EXISTS ${x}`, { stopOnError: false })
          for (const x of [pa, pb]) await exec(`DROP TABLE IF EXISTS ${other}.${x}`, { stopOnError: false })
        }
        try {
          await drop()
          for (const x of [a, b]) {
            await execOk(`CREATE TABLE ${x} (id INT PRIMARY KEY)`)
            await execOk(`INSERT INTO ${x} (id) VALUES (1), (2)`)
          }
          await runScript({ op: 'maintainTables', tables: [a, b], action: 'analyze' })
          await runScript({
            op: 'renameTables',
            renames: [
              { from: a, to: pa },
              { from: b, to: pb },
            ],
          })
          const names = (await db.listTables(ns)).map((x) => x.name)
          expect(names).toEqual(expect.arrayContaining([pa, pb]))
          expect(names).not.toContain(a)
          await runScript({
            op: 'copyTables',
            tables: [pa, pb],
            withData: true,
            ...(dialect === 'mysql' ? { toDatabase: other } : { toSchema: other }),
          })
          const [n] = await exec(`SELECT COUNT(*) FROM ${other}.${pb}`)
          expect(n?.kind === 'rows' ? Number(n.result.rows[0]?.[0]) : -1).toBe(2)
        } finally {
          await drop()
        }
      })

      it('finds and replaces in a column, touching only the rows the replacement changes', async () => {
        const t = `${scratch}_rep`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(40))`)
        await execOk(`INSERT INTO ${t} (id, name) VALUES (1, 'Apple pie'), (2, 'apple tart'), (3, 'Banana'), (4, NULL)`)
        try {
          const results = await runScript({
            op: 'replaceInColumn',
            table: t,
            column: 'name',
            find: 'Apple',
            replace: 'Pear',
          })
          // Case-sensitive on both servers, although MySQL's own comparison would call 'apple' a match.
          const updated = results.find((r) => r.kind === 'affected')
          expect(updated?.kind === 'affected' ? updated.affectedRows : -1).toBe(1)
          const rows = await exec(`SELECT id, name FROM ${t} ORDER BY id`)
          const r = rows[0]
          expect(r?.kind === 'rows' ? r.result.rows : []).toEqual([
            [1, 'Pear pie'],
            [2, 'apple tart'],
            [3, 'Banana'],
            [4, null],
          ])
          // A change of case alone: equal under a case-insensitive collation (MySQL's default), yet a change.
          const recased = await runScript({
            op: 'replaceInColumn',
            table: t,
            column: 'name',
            find: 'Pear',
            replace: 'PEAR',
          })
          const second = recased.find((r) => r.kind === 'affected')
          expect(second?.kind === 'affected' ? second.affectedRows : -1).toBe(1)
          expect(await exec(`SELECT name FROM ${t} WHERE id = 1`)).toMatchObject([
            { kind: 'rows', result: { rows: [['PEAR pie']] } },
          ])
          // A regular expression, every match in the value replaced.
          const regex = await runScript({
            op: 'replaceInColumn',
            table: t,
            column: 'name',
            find: 'an+',
            replace: 'X',
            regex: true,
          })
          const third = regex.find((r) => r.kind === 'affected')
          expect(third?.kind === 'affected' ? third.affectedRows : -1).toBe(1)
          expect(await exec(`SELECT name FROM ${t} WHERE id = 3`)).toMatchObject([
            { kind: 'rows', result: { rows: [['BXXa']] } },
          ])
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it('creates a row trigger that fires', async () => {
        const t = `${scratch}_trg`
        const trigger = `${scratch}_up`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20))`)
        try {
          await runScript({
            op: 'createTrigger',
            name: trigger,
            table: t,
            timing: 'BEFORE',
            event: 'INSERT',
            body:
              // Ending in a line comment: whatever closes the statement must not land inside it.
              dialect === 'mysql'
                ? 'BEGIN\n  SET NEW.name = UPPER(NEW.name);\nEND; -- upper-cases the name'
                : 'BEGIN\n  NEW.name := UPPER(NEW.name);\n  RETURN NEW;\nEND; -- upper-cases the name',
          })
          await execOk(`INSERT INTO ${t} (id, name) VALUES (1, 'abc')`)
          expect(await firstValue(`SELECT name FROM ${t}`)).toBe('ABC')
          expect((await db.listTriggers(ns)).map((x) => x.name)).toContain(trigger)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
          if (dialect === 'postgres') await exec(`DROP FUNCTION IF EXISTS ${trigger}_fn()`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'mysql')('creates an event on a schedule (MySQL)', async () => {
        const event = `${scratch}_ev`
        try {
          await runScript({
            op: 'createEvent',
            name: event,
            schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2030-01-01 00:00:00' },
            body: 'BEGIN\n  SET @conformance_event = 1;\n  SET @conformance_event = 2;\nEND # runs daily',
            enabled: false,
            comment: 'conformance',
          })
          const listed = (await db.listEvents(ns)).find((e) => e.name === event)
          expect(listed?.status).toMatch(/DISABLED/i)
        } finally {
          await exec(`DROP EVENT IF EXISTS ${event}`, { stopOnError: false })
        }
      })

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

      it.skipIf(dialect !== 'mysql')('recovers a default the catalog cannot spell (MySQL)', async () => {
        // information_schema.COLUMNS.COLUMN_DEFAULT is utf8mb3, so a 4-byte character comes back as `?`.
        // MySQL prints such a default as hex in SHOW CREATE TABLE — which is also how a real `?` is told apart.
        if (await isMariaDb()) return
        const t = `${scratch}_astral`
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
            `emoji VARCHAR(20) NOT NULL DEFAULT '日本語😀', ` +
            `q VARCHAR(20) NOT NULL DEFAULT 'a?b')`
        )
        try {
          const hex = async () => {
            await execOk(`INSERT INTO ${t} () VALUES ()`)
            const rows = await exec(`SELECT HEX(emoji), HEX(q) FROM ${t} ORDER BY id DESC LIMIT 1`)
            const r = rows[0]
            return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
          }
          const before = await hex()
          const schema = await db.describeTable(ns, t)
          const emoji = schema.columns.find((c) => c.name === 'emoji')
          // Recovered as the bytes MySQL itself would write, not as text with a `?` in it.
          expect(emoji?.default).toMatch(/^0x[0-9A-Fa-f]+$/)
          expect(emoji?.defaultIsExpression).toBe(true)
          // A `?` the user really typed stays a plain literal.
          expect(schema.columns.find((c) => c.name === 'q')).toMatchObject({
            default: 'a?b',
            defaultIsExpression: false,
          })
          for (const name of ['emoji', 'q']) {
            const c = schema.columns.find((x) => x.name === name)
            if (!c) throw new Error(name)
            await runDdl({
              op: 'modifyColumn',
              table: t,
              name,
              column: col(name, c.dataType, {
                nullable: c.nullable,
                collation: c.collation,
                comment: 'edited',
                default: c.defaultIsExpression
                  ? { kind: 'expression', sql: c.default ?? '' }
                  : { kind: 'literal', value: c.default ?? '' },
              }),
            })
          }
          expect(await hex()).toBe(before)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'mysql')('modifyColumn keeps a column-level CHECK (MariaDB)', async () => {
        // MariaDB attaches CHECKs to the column and MODIFY COLUMN replaces the whole definition, so a
        // comment-only edit used to drop them — including the `json_valid` that is all a JSON column is.
        if (!(await isMariaDb())) return
        const t = `${scratch}_chk`
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, c INT CHECK (c > 0), j JSON DEFAULT '{}')`)
        try {
          const refuses = async (sql: string) =>
            (await exec(sql, { stopOnError: false })).some((r) => r.kind === 'error')
          const schema = await db.describeTable(ns, t)
          expect(schema.columns.find((c) => c.name === 'c')?.check).toBeTruthy()
          expect(schema.columns.find((c) => c.name === 'j')?.check).toBeTruthy()
          for (const name of ['c', 'j']) {
            const c = schema.columns.find((x) => x.name === name)
            if (!c) throw new Error(name)
            await runDdl({
              op: 'modifyColumn',
              table: t,
              name,
              column: col(name, c.dataType, {
                nullable: c.nullable,
                collation: c.collation,
                comment: 'edited',
                check: c.check,
                ...(c.default === null ? {} : { default: { kind: 'literal', value: c.default } }),
              }),
            })
          }
          expect(await refuses(`INSERT INTO ${t} (id, c) VALUES (1, -1)`)).toBe(true)
          expect(await refuses(`INSERT INTO ${t} (id, j) VALUES (2, 'not json')`)).toBe(true)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'mysql')('describeTable reports a default that replays to the same value', async () => {
        // The two servers print COLUMN_DEFAULT differently (MariaDB quotes and escapes literals, MySQL 8 does
        // not) and both hide it behind the same column. Asserting the produced value catches either format.
        const t = `${scratch}_def`
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
            `plain VARCHAR(20) NOT NULL DEFAULT 'abc', ` +
            `quoted VARCHAR(20) NOT NULL DEFAULT 'it''s', ` +
            `newline VARCHAR(20) NOT NULL DEFAULT 'a\\nb', ` +
            `slash VARCHAR(20) NOT NULL DEFAULT 'a\\\\nb', ` +
            `looksHex VARCHAR(20) NOT NULL DEFAULT '0xFF', ` +
            `bin VARBINARY(10) NOT NULL DEFAULT 0x6162, ` +
            `none VARCHAR(20) NULL)`
        )
        const names = ['plain', 'quoted', 'newline', 'slash', 'looksHex', 'bin', 'none']
        try {
          const produced = async () => {
            await execOk(`INSERT INTO ${t} () VALUES ()`)
            const rows = await exec(
              `SELECT ${names.map((n) => `HEX(\`${n}\`)`).join(', ')} FROM ${t} ORDER BY id DESC LIMIT 1`
            )
            const r = rows[0]
            return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
          }
          const before = await produced()
          const schema = await db.describeTable(ns, t)
          // A nullable column with no default is "no default", however the catalog spells it.
          expect(schema.columns.find((c) => c.name === 'none')?.default).toBeNull()
          for (const name of names) {
            const c = schema.columns.find((x) => x.name === name)
            if (!c) throw new Error(name)
            await runDdl({
              op: 'modifyColumn',
              table: t,
              name,
              column: col(name, c.dataType, {
                nullable: c.nullable,
                collation: c.collation,
                comment: 'edited',
                ...(c.default === null
                  ? {}
                  : {
                      default: c.defaultIsExpression
                        ? { kind: 'expression', sql: c.default }
                        : { kind: 'literal', value: c.default },
                    }),
              }),
            })
          }
          expect(await produced()).toBe(before)

          // A byte the connection charset cannot show is reported as `?` by MariaDB 10.11 — the catalog itself
          // loses it, so only MySQL can be asked to carry one.
          if (!(await isMariaDb())) {
            const b = `${t}_hi`
            await execOk(`CREATE TABLE ${b} (id INT PRIMARY KEY AUTO_INCREMENT, v VARBINARY(4) NOT NULL DEFAULT 0xFF)`)
            try {
              const hex = async () => {
                await execOk(`INSERT INTO ${b} () VALUES ()`)
                const rows = await exec(`SELECT HEX(v) FROM ${b} ORDER BY id DESC LIMIT 1`)
                const r = rows[0]
                return r?.kind === 'rows' ? String(r.result.rows[0]?.[0]) : 'n/a'
              }
              const was = await hex()
              const c = (await db.describeTable(ns, b)).columns.find((x) => x.name === 'v')
              expect(c?.defaultIsExpression).toBe(true)
              await runDdl({
                op: 'modifyColumn',
                table: b,
                name: 'v',
                column: col('v', c?.dataType ?? 'varbinary(4)', {
                  nullable: false,
                  comment: 'edited',
                  default: { kind: 'expression', sql: c?.default ?? '' },
                }),
              })
              expect(await hex()).toBe(was)
            } finally {
              await exec(`DROP TABLE IF EXISTS ${b}`, { stopOnError: false })
            }
          }
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'mysql')('modifyColumn replays an expression default without changing it', async () => {
        // information_schema hands the expression back with its literals escaped and its UTF-8 bytes read as
        // latin1; replaying that text verbatim would store mojibake. What matters is the value it produces.
        const t = `${scratch}_expr`
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
            `jp VARCHAR(20) NULL DEFAULT (concat('日本')), ` +
            `qu VARCHAR(20) NULL DEFAULT (concat('it''s')))`
        )
        try {
          const value = async () => {
            await execOk(`INSERT INTO ${t} () VALUES ()`)
            const rows = await exec(`SELECT jp, qu FROM ${t} ORDER BY id DESC LIMIT 1`)
            const r = rows[0]
            return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
          }
          const before = await value()
          const schema = await db.describeTable(ns, t)
          for (const name of ['jp', 'qu']) {
            const c = schema.columns.find((x) => x.name === name)
            if (!c) throw new Error(name)
            await runDdl({
              op: 'modifyColumn',
              table: t,
              name,
              column: col(name, c.dataType, {
                nullable: c.nullable,
                collation: c.collation,
                // Taken from the catalog's answer, not assumed: a wrong flag has to show up here.
                default: c.defaultIsExpression
                  ? { kind: 'expression', sql: c.default ?? '' }
                  : { kind: 'literal', value: c.default ?? '' },
                comment: 'edited',
              }),
            })
          }
          expect(await value()).toBe(before)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it.skipIf(dialect !== 'mysql')('modifyColumn keeps the clauses the column form does not model', async () => {
        // MySQL rewrites the whole column, so a comment-only edit used to drop ON UPDATE and the collation.
        const t = `${scratch}_keep`
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY, ` +
            'updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP, ' +
            'code VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_bin NULL)'
        )
        try {
          const before = await db.describeTable(ns, t)
          const spec = (name: string, over: Partial<ColumnSpec>) => {
            const c = before.columns.find((x) => x.name === name)
            if (!c) throw new Error(`missing column ${name}`)
            return col(name, c.dataType, {
              nullable: c.nullable,
              collation: c.collation,
              onUpdate: /\bon update (CURRENT_TIMESTAMP(?:\(\d\))?)/i.exec(c.extra)?.[1]?.toUpperCase() ?? null,
              ...over,
            })
          }
          await runDdl({
            op: 'modifyColumn',
            table: t,
            name: 'updated_at',
            column: spec('updated_at', { comment: 'c' }),
          })
          await runDdl({ op: 'modifyColumn', table: t, name: 'code', column: spec('code', { comment: 'c' }) })
          const after = await db.describeTable(ns, t)
          const byName = (n: string) => after.columns.find((c) => c.name === n)
          expect(byName('updated_at')?.extra.toLowerCase()).toContain('on update current_timestamp')
          expect(byName('code')?.collation).toBe('latin1_bin')
          expect(byName('code')?.comment).toBe('c')
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
        // MySQL reports a literal default as a literal; PostgreSQL stores every default as an expression.
        // Asserted exactly, because a loose check here hid MariaDB returning the value still quoted.
        expect(s.columns[1]?.defaultIsExpression).toBe(dialect === 'postgres')
        expect(s.columns[1]?.default).toBe(dialect === 'postgres' ? "'it''s'::character varying" : "it's")

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

      it('manages indexes and columns in bulk: kinds, lengths, rename, replace, several columns at once', async () => {
        const t = `${scratch}_bulk`
        const idx = `${t}_idx`
        try {
          await runDdl({
            op: 'createTable',
            table: t,
            columns: [col('id', 'INT', { nullable: false }), col('a', 'VARCHAR(40)'), col('b', 'INT'), col('c', 'INT')],
            primaryKey: ['id'],
          })
          // MySQL: a prefix length; PostgreSQL: an access method.
          await runDdl({
            op: 'addIndex',
            table: t,
            name: idx,
            columns: ['a'],
            unique: false,
            ...(dialect === 'mysql' ? { lengths: { a: 5 } } : { method: 'hash' as const }),
          })
          let s = await db.describeTable(ns, t)
          let i = s.indexes.find((x) => x.name === idx)
          if (dialect === 'mysql') expect(i?.lengths).toEqual({ a: 5 })
          else expect(i?.type).toBe('hash')

          await runDdl({ op: 'renameIndex', table: t, name: idx, newName: `${idx}2` })
          await runDdl({
            op: 'alterIndex',
            table: t,
            name: `${idx}2`,
            index: { name: `${idx}3`, columns: ['a', 'b'], unique: true },
          })
          s = await db.describeTable(ns, t)
          i = s.indexes.find((x) => x.name === `${idx}3`)
          expect(i).toMatchObject({ unique: true, columns: ['a', 'b'] })
          expect(s.indexes.some((x) => x.name === idx || x.name === `${idx}2`)).toBe(false)

          // The primary key replaced by another, in one statement.
          const current = s.indexes.find((x) => x.primary)?.name
          await runDdl({
            op: 'setPrimaryKey',
            table: t,
            columns: ['id', 'c'],
            ...(dialect === 'postgres' && current ? { current } : { current: 'PRIMARY' }),
          })
          expect((await db.describeTable(ns, t)).primaryKey).toEqual(['id', 'c'])

          await runDdl({
            op: 'modifyColumns',
            table: t,
            changes: [
              { name: 'b', column: col('b', 'BIGINT'), previous: col('b', 'INT') },
              { name: 'a', column: col('a', 'VARCHAR(60)'), previous: col('a', 'VARCHAR(40)') },
            ],
          })
          s = await db.describeTable(ns, t)
          expect(s.columns.find((c) => c.name === 'b')?.dataType.toLowerCase()).toContain('bigint')
          expect(s.columns.find((c) => c.name === 'a')?.dataType.toLowerCase()).toContain('60')

          if (dialect === 'mysql') {
            const specs = (await db.describeTable(ns, t)).columns.map((c) =>
              col(c.name, c.dataType, { nullable: c.nullable })
            )
            const reordered = [specs[3], specs[0], specs[1], specs[2]].filter((c): c is ColumnSpec => c !== undefined)
            await runDdl({ op: 'reorderColumns', table: t, columns: reordered })
            expect((await db.describeTable(ns, t)).columns.map((c) => c.name)).toEqual(['c', 'id', 'a', 'b'])
          }

          // A change that fails part-way (UNIQUE over duplicates) leaves the index as it was, run as the UI runs
          // it: one script, stopping at the first error.
          await execOk(`INSERT INTO ${t} (id, a, b, c) VALUES (1, 'dup', 1, 1), (2, 'dup', 2, 2)`)
          await runDdl({ op: 'addIndex', table: t, name: `${idx}c`, columns: ['c'], unique: false })
          const failed = await exec(
            sqlScript(
              dialect,
              db.ddl.build(ns, {
                op: 'alterIndex',
                table: t,
                name: `${idx}c`,
                index: { name: `${idx}c`, columns: ['a'], unique: true },
              })
            )
          )
          expect(failed.some((r) => r.kind === 'error')).toBe(true)
          expect((await db.describeTable(ns, t)).indexes.find((x) => x.name === `${idx}c`)).toMatchObject({
            columns: ['c'],
            unique: false,
          })

          await runDdl({ op: 'dropIndex', table: t, name: `${idx}3` })
          await runDdl({ op: 'dropColumns', table: t, names: ['a', 'b'] })
          expect((await db.describeTable(ns, t)).columns.map((c) => c.name).sort()).toEqual(['c', 'id'])
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it('writes a generated column that describeTable reads back, and keeps it generated when changed', async () => {
        const t = `${scratch}_gen`
        try {
          await runDdl({
            op: 'createTable',
            table: t,
            columns: [col('id', 'INT', { nullable: false }), col('a', 'INT'), col('b', 'INT')],
            primaryKey: ['id'],
          })
          const expression = dialect === 'mysql' ? '`a` + `b`' : 'a + b'
          await runDdl({
            op: 'addColumn',
            table: t,
            column: col('total', 'INT', { generated: { expression, stored: true } }),
          })
          let total = (await db.describeTable(ns, t)).columns.find((c) => c.name === 'total')
          expect(total?.generated?.stored).toBe(true)
          expect(total?.generated?.expression.replace(/[`"()\s]/g, '')).toBe('a+b')
          await db.insertRow(ns, t, { id: 1, a: 2, b: 3 })
          expect((await browseAll(t)).rows[0]?.[3]).toBe(5)

          // Changing something else about it (its comment) leaves it generated: MySQL rewrites the whole column
          // from the definition read back, PostgreSQL touches only what changed.
          const generated = total?.generated ?? null
          await runDdl({
            op: 'modifyColumn',
            table: t,
            name: 'total',
            column: col('total', 'INT', { generated, comment: 'sum' }),
            previous: col('total', 'INT', { generated }),
          })
          total = (await db.describeTable(ns, t)).columns.find((c) => c.name === 'total')
          expect(total).toMatchObject({ comment: 'sum', generated: { stored: true } })
          expect((await browseAll(t)).rows[0]?.[3]).toBe(5)

          // A new column with its key, and on MySQL in the first position.
          await runDdl({ op: 'addColumn', table: t, column: col('code', 'VARCHAR(10)'), first: true, key: 'unique' })
          const s = await db.describeTable(ns, t)
          expect(s.columns.map((c) => c.name)[0]).toBe(dialect === 'mysql' ? 'code' : 'id')
          expect(s.indexes.find((i) => i.columns.join() === 'code')).toMatchObject({ unique: true })
        } finally {
          await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
        }
      })

      it('sets a table comment, runs maintenance and bulk-drops / truncates tables', async () => {
        const a = `${scratch}_bulk_a`
        const b = `${scratch}_bulk_b`
        await execOk(`CREATE TABLE ${a} (id INT PRIMARY KEY); CREATE TABLE ${b} (id INT PRIMARY KEY)`)
        await execOk(`INSERT INTO ${a} (id) VALUES (1); INSERT INTO ${b} (id) VALUES (1)`)
        await runDdl({ op: 'setTableOptions', table: a, comment: "bulk 'a'" })
        expect((await db.describeTable(ns, a)).comment).toBe("bulk 'a'")
        await runDdl({ op: 'maintainTable', table: a, action: 'analyze' })
        if (dialect === 'mysql') {
          await runDdl({ op: 'maintainTable', table: a, action: 'check' })
          // InnoDB cannot be repaired: the server says so in the result, which must not read as a failure.
          await runDdl({ op: 'maintainTable', table: a, action: 'repair' })
        } else await runDdl({ op: 'maintainTable', table: a, action: 'vacuum' })
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

      it('creates databases with a collation and drops several at once', async () => {
        const first = `${scratch}_cdb1`
        const second = `${scratch}_cdb2`
        const collation = dialect === 'mysql' ? 'utf8mb4_bin' : 'C'
        await runDdl({ op: 'createDatabase', name: first, collation })
        await runDdl({ op: 'createDatabase', name: second })
        try {
          const found = (await db.listDatabases()).map((d) => d.name)
          expect(found).toEqual(expect.arrayContaining([first, second]))
          expect(
            await firstValue(
              dialect === 'mysql'
                ? `SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${first}'`
                : `SELECT datcollate FROM pg_database WHERE datname = '${first}'`
            )
          ).toBe(collation)
        } finally {
          await runDdl({ op: 'dropDatabases', names: [first, second] })
        }
        const left = (await db.listDatabases()).map((d) => d.name)
        expect(left).not.toContain(first)
        expect(left).not.toContain(second)
      })

      it('changes a server setting and puts it back to its default', async () => {
        const name = dialect === 'mysql' ? 'long_query_time' : 'work_mem'
        const wanted = dialect === 'mysql' ? '7' : '8MB'
        const read = async () =>
          (await db.listVariables()).find((v) => v.name === name)?.value?.replace(/\.0+$/, '') ?? ''
        const original = await read()
        try {
          await runDdl({ op: 'setServerVariable', name, value: wanted })
          if (dialect === 'postgres') {
            // The reload reaches new sessions a moment later.
            for (let i = 0; i < 20 && !(await read()).startsWith('8'); i++) await new Promise((r) => setTimeout(r, 100))
          }
          expect(await read()).toMatch(dialect === 'mysql' ? /^7/ : /^8/)
        } finally {
          await runDdl({ op: 'setServerVariable', name })
        }
        if (dialect === 'postgres') {
          for (let i = 0; i < 20 && (await read()) !== original; i++) await new Promise((r) => setTimeout(r, 100))
        }
        expect(await read()).toBe(dialect === 'mysql' ? '10' : original)
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

    describe('renaming and copying a database', () => {
      const src = `${scratch}_srcdb`
      const renamed = `${scratch}_rendb`
      const copied = `${scratch}_cpydb`
      const inDb = async (database: string, sql: string) => {
        for (const r of await db.executeSql({ database }, sql, EXEC))
          if (r.kind === 'error') throw new Error(`SQL failed: ${r.message}\n${r.sql}`)
      }
      const dropQuietly = async (name: string) => {
        if ((await db.listDatabases()).some((d) => d.name === name))
          for (const sql of db.ddl.build(ns, { op: 'dropDatabase', name })) await exec(sql)
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
        (await db.listTables({ database })).filter((t) => t.kind === 'table').map((t) => t.name)
      const rowIds = async (database: string, table: string) =>
        (await db.browseRows({ database }, table, { offset: 0, limit: 100, sort: [], filters: [] })).rows.map(
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
        const collation = (await db.listDatabases()).find((d) => d.name === src)?.collation ?? undefined
        await runDdl({
          op: 'renameDatabase',
          name: src,
          newName: renamed,
          tables: await tablesOf(src),
          ...(collation ? { collation } : {}),
        })
        const names = (await db.listDatabases()).map((d) => d.name)
        expect(names).toContain(renamed)
        if (dialect === 'postgres') expect(names).not.toContain(src)
        // MySQL keeps the old database, emptied of its tables, for the user to inspect and drop.
        else expect(await tablesOf(src)).toEqual([])
        expect(await rowIds(renamed, 'child')).toEqual([10, 20])
        expect((await db.describeTable({ database: renamed }, 'child')).foreignKeys.map((f) => f.name)).toEqual([
          'child_parent',
        ])
        if (dialect === 'mysql') {
          expect(collation).toBe('utf8mb4_bin')
          expect((await db.listDatabases()).find((d) => d.name === renamed)?.collation).toBe('utf8mb4_bin')
        }
      })

      it('never drops the old database on MySQL, so a table created after the preview is not lost', async () => {
        if (dialect !== 'mysql') return
        await seed(src)
        // The statements are built from the table list as it stood at preview time …
        const sql = db.ddl.build(ns, { op: 'renameDatabase', name: src, newName: renamed, tables: await tablesOf(src) })
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
        const running = db.executeSql({ database: src }, 'SELECT pg_sleep(2)', EXEC)
        await new Promise((resolve) => setTimeout(resolve, 300))
        const results: StatementResult[] = []
        for (const sql of db.ddl.build(ns, { op: 'renameDatabase', name: src, newName: renamed }))
          results.push(...(await exec(sql, { stopOnError: true })))
        expect(results.some((r) => r.kind === 'error')).toBe(true)
        expect((await running).every((r) => r.kind !== 'error')).toBe(true)
        expect((await db.listDatabases()).map((d) => d.name)).toContain(src)
      }, 20_000)

      it('copies a database with its rows, leaving the source untouched', async () => {
        await seed(src)
        expect(await rowIds(src, 'parent')).toEqual([1, 2])
        const tables = await Promise.all(
          (await tablesOf(src)).map(async (name) => ({
            name,
            columns: (await db.describeTable({ database: src }, name)).columns.map((c) => c.name),
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
          const grants = await db.databaseGrants(src)
          expect(grants.find((g) => g.user === account.name)).toMatchObject({
            host: '%',
            privileges: ['INSERT', 'SELECT'],
            grantable: true,
          })
          const tables = await Promise.all(
            (await tablesOf(src)).map(async (name) => {
              const s = await db.describeTable({ database: src }, name)
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
          const fk = (await db.describeTable({ database: copied }, 'child')).foreignKeys[0]
          expect(fk).toMatchObject({ refTable: 'parent', refNamespace: { database: copied } })
          // The counter is the source's, not the one the single row would give.
          expect((await db.describeTable({ database: copied }, 'counter')).autoIncrement).toBe('500')
          expect((await db.databaseGrants(copied)).find((g) => g.user === account.name)).toMatchObject({
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
