import { DISTINCT_VALUES_LIMIT } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'

/** Conformance: checkReferences, deleteImpact, distinctValues, searchTable, listForeignKeys and buildQuery (in the order they have always run in). */
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

  describe('deleteImpact', () => {
    const fk = (name: string, cols: string, ref: string, rule: string) =>
      `CONSTRAINT ${name} FOREIGN KEY (${cols}) REFERENCES ${ref} ON DELETE ${rule}`
    const pk = (id: number) => ({ kind: 'pk' as const, values: { id } })

    it('follows CASCADE down, counts SET NULL and RESTRICT without following them, and deletes nothing', async () => {
      const [p, c, g, n, r] = ['p', 'c', 'g', 'n', 'r'].map((x) => `${scratch}_di${x}`) as [
        string,
        string,
        string,
        string,
        string,
      ]
      await execOk(`CREATE TABLE ${p} (id INT PRIMARY KEY)`)
      await execOk(`CREATE TABLE ${c} (id INT PRIMARY KEY, pid INT, ${fk(`${c}_fk`, 'pid', `${p} (id)`, 'CASCADE')})`)
      await execOk(`CREATE TABLE ${g} (id INT PRIMARY KEY, cid INT, ${fk(`${g}_fk`, 'cid', `${c} (id)`, 'CASCADE')})`)
      await execOk(`CREATE TABLE ${n} (id INT PRIMARY KEY, pid INT, ${fk(`${n}_fk`, 'pid', `${p} (id)`, 'SET NULL')})`)
      await execOk(`CREATE TABLE ${r} (id INT PRIMARY KEY, pid INT, ${fk(`${r}_fk`, 'pid', `${p} (id)`, 'RESTRICT')})`)
      try {
        await execOk(`INSERT INTO ${p} VALUES (1), (2)`)
        await execOk(`INSERT INTO ${c} VALUES (1, 1), (2, 1), (3, 2)`)
        await execOk(`INSERT INTO ${g} VALUES (1, 1), (2, 1), (3, 2), (4, 3)`)
        await execOk(`INSERT INTO ${n} VALUES (1, 1), (2, NULL)`)
        await execOk(`INSERT INTO ${r} VALUES (1, 2)`)

        const one = await env.db.deleteImpact(ns, p, [pk(1)])
        expect(one).toMatchObject({ table: p, rows: 1, blocked: false, capped: false })
        const at = (impact: typeof one, table: string) => impact.steps.find((s) => s.table === table)
        expect(at(one, c)).toMatchObject({ depth: 1, refTable: p, constraint: `${c}_fk`, action: 'cascade', rows: 2 })
        expect(at(one, n)).toMatchObject({ depth: 1, action: 'setNull', rows: 1 })
        expect(at(one, r)).toMatchObject({ depth: 1, action: 'restrict', rows: 0 })
        expect(at(one, g)).toMatchObject({ depth: 2, refTable: c, action: 'cascade', rows: 3 })
        expect(one.steps.map((s) => s.depth)).toEqual([1, 1, 1, 2])

        const two = await env.db.deleteImpact(ns, p, [pk(2)])
        expect(two.blocked).toBe(true)
        expect(at(two, r)?.rows).toBe(1)
        expect(at(two, g)?.rows).toBe(1)

        const both = await env.db.deleteImpact(ns, p, [pk(1), pk(2)])
        expect(both.rows).toBe(2)
        expect(at(both, c)?.rows).toBe(3)
        expect(at(both, g)?.rows).toBe(4)

        expect(await env.db.deleteImpact(ns, p, [pk(9)])).toEqual({
          table: p,
          rows: 0,
          steps: [],
          blocked: false,
          capped: false,
        })
        const [left] = await exec(`SELECT COUNT(*) FROM ${g}`)
        expect(left?.kind === 'rows' ? Number(left.result.rows[0]?.[0]) : null).toBe(4)
      } finally {
        for (const t of [g, c, n, r, p]) await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('walks a self-referencing table until no rows are left to follow', async () => {
      const t = `${scratch}_dit`
      await execOk(
        `CREATE TABLE ${t} (id INT PRIMARY KEY, parent INT, ${fk(`${t}_fk`, 'parent', `${t} (id)`, 'CASCADE')})`
      )
      try {
        await execOk(`INSERT INTO ${t} VALUES (1, NULL), (2, 1), (3, 2), (4, 3), (5, NULL)`)
        const impact = await env.db.deleteImpact(ns, t, [pk(1)])
        expect(impact.steps.map((s) => [s.depth, s.rows])).toEqual([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 0],
        ])
        expect(impact.capped).toBe(false)
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('matches a composite key on every column, leaving rows with a NULL in it out', async () => {
      const [cp, cc] = [`${scratch}_dicp`, `${scratch}_dicc`]
      await execOk(`CREATE TABLE ${cp} (a INT, b INT, PRIMARY KEY (a, b))`)
      await execOk(
        `CREATE TABLE ${cc} (id INT PRIMARY KEY, a INT, b INT, ${fk(`${cc}_fk`, 'a, b', `${cp} (a, b)`, 'CASCADE')})`
      )
      try {
        await execOk(`INSERT INTO ${cp} VALUES (1, 1), (1, 2)`)
        await execOk(`INSERT INTO ${cc} VALUES (1, 1, 1), (2, 1, NULL), (3, 1, 2)`)
        const impact = await env.db.deleteImpact(ns, cp, [{ kind: 'pk', values: { a: 1, b: 1 } }])
        expect(impact.steps).toEqual([
          {
            depth: 1,
            table: cc,
            constraint: `${cc}_fk`,
            columns: ['a', 'b'],
            refTable: cp,
            action: 'cascade',
            rows: 1,
          },
        ])
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${cc}`)
        await execOk(`DROP TABLE IF EXISTS ${cp}`)
      }
    })
  })

  describe('tableUsage', () => {
    it('counts the reads of a table in full and through its indexes, and marks the unique ones', async () => {
      const t = `${scratch}_tu`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, code INT, note VARCHAR(10))`)
      await execOk(`CREATE INDEX ${t}_code ON ${t} (code)`)
      try {
        await execOk(`INSERT INTO ${t} VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c')`)
        const first = await env.db.tableUsage(ns)
        // MariaDB keeps performance_schema off unless it is configured on: there is nothing to read.
        if (first.status === 'unsupported' && (await isMariaDb())) {
          expect(first).toEqual({ status: 'unsupported', unit: 'rows', since: null, tables: [], indexes: [] })
          return
        }
        expect(first.status).toBe('ok')
        expect(first.unit).toBe(dialect === 'mysql' ? 'rows' : 'scans')
        // MySQL counts from the server's start; PostgreSQL from the last reset, and gives none if it never was.
        if (first.since !== null) expect(Number.isNaN(Date.parse(first.since))).toBe(false)
        if (dialect === 'mysql') expect(first.since).not.toBeNull()
        await execOk(`SELECT note FROM ${t} WHERE note = 'b'`)
        // One script: each run starts a fresh session, so the setting must go with the statement it is for.
        const indexOnly = dialect === 'postgres' ? 'SET enable_seqscan = off; ' : ''
        await execOk(`${indexOnly}SELECT id FROM ${t} WHERE code = 20`)
        // PostgreSQL hands its counts to the statistics a moment after the statement: read until they are there.
        let usage = await env.db.tableUsage(ns)
        for (let i = 0; i < 50; i++) {
          const mine = usage.tables.find((u) => u.table === t)
          if (mine && mine.fullReads > 0 && mine.indexReads > 0) break
          await new Promise((r) => setTimeout(r, 100))
          usage = await env.db.tableUsage(ns)
        }
        const mine = usage.tables.find((u) => u.table === t)
        expect(mine?.fullReads).toBeGreaterThan(0)
        expect(mine?.indexReads).toBeGreaterThan(0)
        const indexes = usage.indexes.filter((i) => i.table === t)
        expect(indexes.find((i) => i.index === `${t}_code`)).toMatchObject({ unique: false })
        expect(indexes.find((i) => i.index === (dialect === 'mysql' ? 'PRIMARY' : `${t}_pkey`))).toMatchObject({
          unique: true,
        })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })
  })

  describe('columnProfile', () => {
    it('counts the NULLs and distinct values of each column, and leaves the ones it cannot compare uncounted', async () => {
      const t = `${scratch}_cp`
      const blob = dialect === 'mysql' ? 'BLOB' : 'BYTEA'
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, colour VARCHAR(10), note VARCHAR(10), data ${blob})`)
      try {
        await execOk(
          `INSERT INTO ${t} (id, colour, note) VALUES (1, 'red', NULL), (2, 'blue', NULL), (3, 'red', 'x'), (4, NULL, NULL)`
        )
        const p = await env.db.columnProfile(ns, t)
        expect(p).toMatchObject({ sampled: 4, capped: false, omitted: 0 })
        expect(p.columns).toEqual([
          { column: 'id', nulls: 0, distinct: 4, prefix: false },
          { column: 'colour', nulls: 1, distinct: 2, prefix: false },
          { column: 'note', nulls: 3, distinct: 1, prefix: false },
          { column: 'data', nulls: 4, distinct: null, prefix: false },
        ])
        await expect(env.db.columnProfile(ns, `${t}_none`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('counts a table of documents, shapes, arrays and types of its own without failing', async () => {
      const t = `${scratch}_cpt`
      const kinds = `${t}_kind`
      const doc = `${t}_doc`
      if (dialect === 'mysql') {
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY, j JSON, g GEOMETRY, s SET('a', 'b'), b BIT(4), e ENUM('x', 'y'), body LONGTEXT)`
        )
        await execOk(
          `INSERT INTO ${t} VALUES (1, '{"a": 1}', ST_GeomFromText('POINT(1 1)'), 'a', b'1010', 'x', REPEAT('z', 1000)), (2, NULL, NULL, 'b', NULL, 'x', NULL)`
        )
      } else {
        await execOk(`CREATE TYPE ${kinds} AS ENUM ('x', 'y')`)
        await execOk(`CREATE DOMAIN ${doc} AS json`)
        await execOk(
          `CREATE TABLE ${t} (id INT PRIMARY KEY, j JSON, jb JSONB, p POINT, a INT[], d ${doc}, e ${kinds}, x XML, body TEXT)`
        )
        await execOk(
          `INSERT INTO ${t} VALUES (1, '{"a": 1}', '{"a": 1}', '(1,1)', '{1,2}', '{"a": 1}', 'x', '<a/>', repeat('z', 1000)), (2, NULL, NULL, NULL, NULL, NULL, 'x', NULL, NULL)`
        )
      }
      try {
        const p = await env.db.columnProfile(ns, t)
        expect(p.sampled).toBe(2)
        const of = (column: string) => p.columns.find((c) => c.column === column)
        expect(of('id')).toEqual({ column: 'id', nulls: 0, distinct: 2, prefix: false })
        // MariaDB's JSON is LONGTEXT with a check: compared as text, by its first characters.
        expect(of('j')).toEqual({
          column: 'j',
          nulls: 1,
          distinct: (await isMariaDb()) ? 1 : null,
          prefix: await isMariaDb(),
        })
        expect(of('body')).toEqual({ column: 'body', nulls: 1, distinct: 1, prefix: true })
        if (dialect === 'mysql') {
          expect(of('g')).toEqual({ column: 'g', nulls: 1, distinct: null, prefix: false })
          expect(of('s')).toEqual({ column: 's', nulls: 0, distinct: 2, prefix: false })
          expect(of('e')).toEqual({ column: 'e', nulls: 0, distinct: 1, prefix: false })
        } else {
          for (const c of ['jb', 'p', 'a', 'd', 'x'])
            expect(of(c)).toEqual({ column: c, nulls: 1, distinct: null, prefix: false })
          // A type of the schema's own: not known to be plain, so its values are not compared.
          expect(of('e')).toEqual({ column: 'e', nulls: 0, distinct: null, prefix: false })
        }
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
        if (dialect === 'postgres') {
          await execOk(`DROP DOMAIN IF EXISTS ${doc}`)
          await execOk(`DROP TYPE IF EXISTS ${kinds}`)
        }
      }
    })

    it('compares long text by its first characters, and says so', async () => {
      const t = `${scratch}_cpx`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, body TEXT)`)
      try {
        // Two values alike in their first 256 characters: counted as one, an estimate the profile marks.
        const head = 'a'.repeat(300)
        await execOk(`INSERT INTO ${t} VALUES (1, '${head}x'), (2, '${head}y')`)
        const p = await env.db.columnProfile(ns, t)
        expect(p.columns.find((c) => c.column === 'body')).toEqual({
          column: 'body',
          nulls: 0,
          distinct: 1,
          prefix: true,
        })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('reads an empty table as no rows', async () => {
      const t = `${scratch}_cpe`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
      try {
        expect(await env.db.columnProfile(ns, t)).toEqual({
          sampled: 0,
          capped: false,
          columns: [{ column: 'id', nulls: 0, distinct: 0, prefix: false }],
          omitted: 0,
        })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
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
