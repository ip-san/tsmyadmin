import { createHash } from 'node:crypto'
import { DISTINCT_VALUES_LIMIT, EXACT_COUNT_MAX_ROWS, type Filter } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'
import { byName } from './helpers.ts'

/** Conformance: the blocks of `search-and-browse` (in the order they have always run in). */
export function describeSearchAndBrowse(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, runDdl, browseAll, isMariaDb } = env
  describe('checkReferences', () => {
    it('counts the rows that name a parent which is not there, per foreign key, leaving NULL keys out', async () => {
      const parent = `${scratch}_crp`
      const child = `${scratch}_crc`
      await execOk(`CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
      await execOk(`CREATE TABLE ${child} (id INT PRIMARY KEY, pid INT)`)
      try {
        await execOk(`INSERT INTO ${parent} VALUES (1), (2)`)
        await execOk(`INSERT INTO ${child} VALUES (1, 1), (2, 3), (3, 4), (4, NULL), (5, 2)`)
        // Rows that already break the rule can only be under a key the server does not check them against.
        await execOk(
          dialect === 'mysql'
            ? `SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id)`
            : `ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id) NOT VALID`
        )
        const [check] = await env.db.checkReferences(ns, child)
        expect(check).toMatchObject({ name: `${child}_fk`, columns: ['pid'], refTable: parent, orphans: 2 })
        const [listed] = await exec(check?.sql ?? '')
        expect(listed?.kind === 'rows' ? listed.result.rows.map((r) => r[0]).sort() : []).toEqual([2, 3])
        expect(await env.db.checkReferences(ns, parent)).toEqual([])
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${child}`)
        await execOk(`DROP TABLE IF EXISTS ${parent}`)
      }
    })
  })

  describe('distinctValues', () => {
    it('lists each value with its count, most frequent first, NULL included, and refuses an unknown column', async () => {
      const t = `${scratch}_dv`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, colour VARCHAR(10))`)
      try {
        await execOk(`INSERT INTO ${t} VALUES (1, 'red'), (2, 'blue'), (3, 'red'), (4, NULL), (5, 'red'), (6, 'blue')`)
        const found = await env.db.distinctValues(ns, t, 'colour')
        expect(found.truncated).toBe(false)
        expect(found.values).toEqual([
          { value: 'red', count: 3 },
          { value: 'blue', count: 2 },
          { value: null, count: 1 },
        ])
        await expect(env.db.distinctValues(ns, t, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('stops at the limit and says so', async () => {
      const t = `${scratch}_dvl`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
      try {
        const values = Array.from({ length: DISTINCT_VALUES_LIMIT + 5 }, (_, i) => `(${i + 1})`).join(', ')
        await execOk(`INSERT INTO ${t} VALUES ${values}`)
        const found = await env.db.distinctValues(ns, t, 'id')
        expect(found.values).toHaveLength(DISTINCT_VALUES_LIMIT)
        expect(found.truncated).toBe(true)
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })
  })

  describe('searchTable', () => {
    it('reads the term as any word, every word, a regular expression, within columns named like', async () => {
      const total = async (term: string, options: Parameters<typeof env.db.searchTable>[3]) =>
        (await env.db.searchTable(ns, 'users', term, options)).total
      expect(await total('alice bob', { mode: 'any' })).toBe(2)
      expect(await total('alice example', { mode: 'all' })).toBe(1)
      expect(await total('alice bob', { mode: 'all' })).toBe(0)
      expect(await total('alice bob', { mode: 'phrase' })).toBe(0)
      expect(await total('^(al|bo)', { mode: 'regexp' })).toBe(2)
      expect(await total('example', { column: 'name' })).toBe(0)
      const inEmail = await env.db.searchTable(ns, 'users', 'example', { column: 'MAIL' })
      expect(inEmail.columns).toEqual(['email'])
      expect(inEmail.total).toBe(5)
      // The SELECT for the SQL tab finds the same rows.
      const any = await env.db.searchTable(ns, 'users', 'alice bob', { mode: 'any' })
      const [r] = await exec(any.sql)
      expect(r?.kind === 'rows' ? r.result.rows.length : -1).toBe(2)
    })

    it('offers the same match as a DELETE that removes exactly the rows found', async () => {
      const t = `${scratch}_sdel`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, note VARCHAR(40))`)
      try {
        await execOk(`INSERT INTO ${t} VALUES (1, 'it''s zap'), (2, 'keep'), (3, 'ZAP too')`)
        const found = await env.db.searchTable(ns, t, "it's zap", { mode: 'any' })
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
      expect(await env.db.searchTable(ns, 'users', 'ALICE')).toMatchObject({ total: 1, count: 'exact' })
      expect((await env.db.searchTable(ns, 'posts', 'alice')).total).toBe(0)
    })

    it('matches LIKE metacharacters literally', async () => {
      // Unescaped, % and _ would match every row.
      expect((await env.db.searchTable(ns, 'users', '%')).total).toBe(0)
      expect((await env.db.searchTable(ns, 'users', '_')).total).toBe(0)
    })

    it('skips binary and bit columns instead of failing on them', async () => {
      const r = await env.db.searchTable(ns, 'types_all', 'x')
      expect(r.columns).not.toContain('blob_col')
      expect(r.columns).not.toContain(dialect === 'mysql' ? 'varbinary_col' : 'blob_col')
      if (dialect === 'mysql') expect(r.columns).not.toContain('bit_col')
      expect(r.columns).toContain('text_col')
    })

    it('searches the text form of numbers, dates, JSON and enums', async () => {
      // Each term appears only in types_all's first row, and only in a column of that type.
      for (const term of ['901234.5678', '2024-03-04', 'true, null', dialect === 'mysql' ? 'beta' : 'sad'])
        expect((await env.db.searchTable(ns, 'types_all', term)).total, term).toBe(1)
    })

    it('gives a SELECT for the SQL tab that finds the same rows', async () => {
      // A backslash before a quote: on MySQL the literal must escape the backslash as well, or the quote ends
      // the string early. Nothing matches; the point is that the SELECT parses and agrees with the count.
      const escaped = await env.db.searchTable(ns, 'posts', "x\\'y")
      expect(escaped.total).toBe(0)
      const none = (await exec(escaped.sql))[0]
      expect(none?.kind).toBe('rows')
      expect(none?.kind === 'rows' && none.result.rows.length).toBe(0)
      // A quote in the term (posts has "Bob's post"): the SELECT must still parse and find that row.
      const found = await env.db.searchTable(ns, 'posts', "bob's")
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
        const fk = (await env.db.describeTable(ns, t)).foreignKeys.find((k) => k.name === `${t}_fk`)
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
        // The API integration suite may be creating and dropping its own `dump_*` tables in this database at the same
        // moment (the MariaDB job runs both files against one server): a table that comes and goes is not compared.
        const keys = (await env.db.listForeignKeys(ns)).filter((k) => !k.table.startsWith('dump_'))
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
          const described = (await env.db.describeTable(ns, table)).foreignKeys
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
          expect((await env.db.describeTable(ns, child)).foreignKeys.map((k) => k.refTable)).toEqual([parent])
          const listed = (await env.db.listForeignKeys(ns)).filter(
            (k) => k.table === child || k.table.startsWith(parent)
          )
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
      const columns = [shown('users', 'name', { sort: 'asc' }), shown('posts', 'title', { alias: 'post', sort: 'asc' })]
      const expected = [
        ['Alice', 'Second'],
        ['Bob', "Bob's post"],
      ]
      for (const tables of [
        ['users', 'posts'],
        ['posts', 'users'],
      ]) {
        const { sql } = await env.db.buildQuery(ns, { tables, columns, where })
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
        env.db.buildQuery(ns, {
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
      const { sql } = await env.db.buildQuery(ns, {
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
      const older = await env.db.buildQuery(ns, {
        tables: ['users'],
        columns,
        where: [[{ table: 'users', column: 'age', op: 'gt', value: '34' }]],
      })
      expect((await rowsOf(older.sql)).result.rows).toEqual([['Carol'], ['Eve']])
      const unknownAge = await env.db.buildQuery(ns, {
        tables: ['users'],
        columns,
        where: [[{ table: 'users', column: 'age', op: 'is_null' }]],
      })
      expect((await rowsOf(unknownAge.sql)).result.rows).toEqual([['Bob']])
      // Keys in another order: equal only when compared as JSON, which on MySQL takes an explicit cast. MariaDB's
      // JSON is LONGTEXT underneath and compares as text, so there the value is the text as stored.
      const jsonValue = (await isMariaDb()) ? '{"a": 1, "b": [true, null]}' : '{"b": [true, null], "a": 1}'
      const json = await env.db.buildQuery(ns, {
        tables: ['types_all'],
        columns: [shown('types_all', 'id')],
        where: [[{ table: 'types_all', column: 'json_col', op: 'eq', value: jsonValue }]],
      })
      expect((await rowsOf(json.sql)).result.rows).toEqual([[1]])
      // BIT typed as a number: on MySQL a quoted '170' would be compared as the bytes of the text.
      if (dialect === 'mysql') {
        const bit = await env.db.buildQuery(ns, {
          tables: ['types_all'],
          columns: [shown('types_all', 'id')],
          where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: '170' }]],
        })
        expect((await rowsOf(bit.sql)).result.rows).toEqual([[1]])
        await expect(
          env.db.buildQuery(ns, {
            tables: ['types_all'],
            columns: [],
            where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: 'x' }]],
          })
        ).rejects.toMatchObject({ code: 'VALIDATION' })
        // One past BIT(64): MySQL would clamp it to the maximum and match that instead.
        await expect(
          env.db.buildQuery(ns, {
            tables: ['types_all'],
            columns: [],
            where: [[{ table: 'types_all', column: 'bit_col', op: 'eq', value: '18446744073709551616' }]],
          })
        ).rejects.toMatchObject({ code: 'VALIDATION' })
      }
    })

    it('refuses tables that no foreign key connects, and unknown columns', async () => {
      await expect(
        env.db.buildQuery(ns, { tables: ['users', 'types_all'], columns: [], where: [] })
      ).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(
        env.db.buildQuery(ns, { tables: ['users'], columns: [shown('users', 'nope')], where: [] })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        env.db.buildQuery(ns, { tables: ['users'], columns: [shown('posts', 'title')], where: [] })
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

    it('also gives the statement with its values written in, which finds the same rows when run', async () => {
      const opts = {
        offset: 0,
        limit: 3,
        sort: [{ column: 'id', direction: 'asc' as const }],
        filters: [
          { column: 'name', op: 'neq' as const, value: "o'hara; \\ --" },
          { column: 'age', op: 'gt' as const, value: 0 },
        ],
      }
      const r = await env.db.browseRows(ns, 'users', opts)
      expect(r.statement.literal).toMatch(/^SELECT /)
      // No placeholder is left in it, and the text with a quote in it is a literal, not code.
      expect(r.statement.literal).not.toMatch(/\?|\$1/)
      const [again] = await exec(r.statement.literal)
      expect(again?.kind === 'rows' ? again.result.rows.map((row) => row[0]) : []).toEqual(r.rows.map((row) => row[0]))
    })

    it('returns every row when the limit is 0, up to the cap', async () => {
      const r = await env.db.browseRows(ns, 'users', { offset: 3, limit: 0, sort: [], filters: [] })
      // The offset is ignored: "all" starts at the first row.
      expect(r.rows).toHaveLength(5)
      expect(r.statement.sql).toMatch(/LIMIT/)
    })

    it('times the stages of the statement when asked (MySQL / MariaDB), and says nothing elsewhere', async () => {
      const r = await env.db.browseRows(ns, 'users', { offset: 0, limit: 5, sort: [], filters: [], profile: true })
      if (dialect === 'mysql') {
        expect(r.statement.profile?.length).toBeGreaterThan(0)
        expect(r.statement.profile?.every((p) => p.state !== '' && p.seconds >= 0)).toBe(true)
      } else expect(r.statement.profile).toBeUndefined()
      expect((await browseAll('users')).statement.profile).toBeUndefined()
    })

    it('reports the statement it ran, with values bound and never spliced into the text', async () => {
      // A value that would break the SQL if it were ever interpolated rather than bound.
      const needle = "o'hara; --"
      const r = await env.db.browseRows(ns, 'users', {
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
        const many = await env.db.browseRows(ns, t, {
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
        const few = await env.db.browseRows(ns, t, {
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
      const desc = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 2,
        sort: [{ column: 'name', direction: 'desc' }],
        filters: [],
      })
      expect(desc.rows.map((r) => r[1])).toEqual(['Eve', 'Dave'])
      expect(desc.total).toBe(5)
      const page = await env.db.browseRows(ns, 'users', {
        offset: 2,
        limit: 2,
        sort: [{ column: 'id', direction: 'asc' }],
        filters: [],
      })
      expect(page.rows.map((r) => r[1])).toEqual(['Carol', 'Dave'])
    })

    it('applies filters (comparison, like, null checks) with parameters', async () => {
      const gt = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 10,
        sort: [{ column: 'id', direction: 'asc' }],
        filters: [{ column: 'age', op: 'gt', value: 30 }],
      })
      expect(gt.rows.map((r) => r[1])).toEqual(['Carol', 'Eve'])
      expect(gt.total).toBe(2)
      const isNull = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 10,
        sort: [],
        filters: [{ column: 'age', op: 'is_null' }],
      })
      expect(isNull.rows.map((r) => r[1])).toEqual(['Bob'])
      const like = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 10,
        sort: [],
        filters: [{ column: 'name', op: 'like', value: 'A%' }],
      })
      expect(like.rows.map((r) => r[1])).toEqual(['Alice'])
      const injection = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 10,
        sort: [],
        filters: [{ column: 'name', op: 'eq', value: "' OR 1=1 --" }],
      })
      expect(injection.rows).toHaveLength(0)
    })

    it('applies text filters to non-text columns (numbers, dates) too', async () => {
      const r = await env.db.browseRows(ns, 'users', {
        offset: 0,
        limit: 10,
        sort: [],
        filters: [{ column: 'id', op: 'starts_with', value: '1' }],
      })
      expect(r.rows.map((x) => x[0])).toEqual([1])
      const d = await env.db.browseRows(ns, 'users', {
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
          await env.db.browseRows(ns, t, {
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
            await env.db.browseRows(ns, t, {
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

        const { sql } = await env.db.buildQuery(ns, {
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
        env.db.browseRows(ns, 'users', {
          offset: 0,
          limit: 1,
          sort: [{ column: 'nope', direction: 'asc' }],
          filters: [],
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('returns lossless wire values for every fixture type', async () => {
      const r = await env.db.browseRows(ns, 'types_all', {
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

  describe('insertPreview', () => {
    it('shows the INSERT without running it, the values apart from the text', () => {
      const preview = env.db.insertPreview(ns, scratch, { id: 7, name: "it's", n: { $bin: 'AQID' } }, { ignore: true })
      expect(preview.sql).toMatch(
        dialect === 'mysql' ? /^INSERT IGNORE INTO / : /^INSERT INTO [\s\S]* ON CONFLICT DO NOTHING$/
      )
      // The value is bound, so the text has no quote of it in it.
      expect(preview.sql).not.toContain("it's")
      expect(preview.params).toEqual([7, "it's", { $bin: 'AQID' }])
    })
  })

  describe('insertRow', () => {
    it('inserts values including NULL and binary', async () => {
      const r = await env.db.insertRow(ns, scratch, { id: 1, name: 'first', n: null })
      expect(r.affectedRows).toBe(1)
      await env.db.insertRow(ns, scratch, { id: 2, name: "quote ' here", n: 42 })
      const rows = await browseAll(scratch)
      expect(rows.total).toBe(2)
      expect(rows.rows.map((x) => x[1])).toEqual(['first', "quote ' here"])
      expect(rows.rows[0]?.[2]).toBeNull()
    })

    it('skips a row the server refuses when asked to ignore errors, and refuses it otherwise', async () => {
      await env.db.insertRow(ns, scratch, { id: 100, name: 'first', n: null })
      await expect(env.db.insertRow(ns, scratch, { id: 100, name: 'again', n: null })).rejects.toBeInstanceOf(Error)
      const skipped = await env.db.insertRow(ns, scratch, { id: 100, name: 'again', n: null }, { ignore: true })
      expect(skipped.affectedRows).toBe(0)
      expect((await browseAll(scratch)).rows.filter((x) => x[0] === 100).map((x) => x[1])).toEqual(['first'])
      // The scratch table is shared by the tests that follow: leave it as it was.
      await execOk(`DELETE FROM ${scratch} WHERE id = 100`)
    })

    it('writes through an allowed function, the value bound as its argument', async () => {
      const t = `${scratch}_fn`
      try {
        await exec(`CREATE TABLE ${t} (id INT PRIMARY KEY, h VARCHAR(64), u VARCHAR(64), at VARCHAR(40))`)
        await env.db.insertRow(ns, t, {
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
        await env.db.updateRow(ns, t, { kind: 'pk', values: { id: 1 } }, { h: { $fn: 'sha256', arg: 'x' } })
        expect((await browseAll(t)).rows[0]?.[1]).toBe(createHash('sha256').update('x').digest('hex'))
        if (dialect === 'postgres') {
          await expect(env.db.insertRow(ns, t, { id: 2, h: { $fn: 'sha1', arg: 'x' } })).rejects.toMatchObject({
            code: 'UNSUPPORTED',
          })
        }
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })

    it('surfaces constraint violations as QUERY_FAILED', async () => {
      await expect(env.db.insertRow(ns, scratch, { id: 1, name: 'dup' })).rejects.toMatchObject({
        code: 'QUERY_FAILED',
      })
    })
  })

  describe('insertRows', () => {
    it('bulk-inserts in chunks inside one transaction', async () => {
      const rows = Array.from({ length: 1203 }, (_, i) => [1000 + i, `bulk ${i}`, i % 3 === 0 ? null : i])
      const r = await env.db.insertRows(ns, scratch, ['id', 'name', 'n'], rows)
      expect(r.affectedRows).toBe(1203)
      const after = await env.db.browseRows(ns, scratch, {
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
        env.db.insertRows(
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
        const r = await env.db.insertRows(
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
      expect(await env.db.insertRows(ns, scratch, ['id'], [])).toEqual({ affectedRows: 0 })
      await expect(env.db.insertRows(ns, scratch, [], [[1]])).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    })
  })
}
