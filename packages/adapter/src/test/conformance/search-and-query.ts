import { DISTINCT_VALUES_LIMIT } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'

/** Conformance: checkReferences, distinctValues, searchTable, listForeignKeys and buildQuery (in the order they have always run in). */
export function describeSearchAndQuery(env: ConformanceEnv): void {
  const { ns, dialect, scratch, exec, execOk, runDdl, isMariaDb } = env
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
}
