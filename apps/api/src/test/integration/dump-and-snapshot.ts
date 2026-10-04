import {
  BrowseResultSchema,
  SnapshotListSchema,
  SnapshotRestorePreviewSchema,
  SnapshotRestoreResultSchema,
  StatementResultSchema,
  TableSchemaSchema,
} from '@tsmyadmin/shared'
import { expect, it } from 'vitest'
import { z } from 'zod'
import type { IntegrationContext } from './context.ts'

/** The API against the real servers: dumps, snapshots and the SQL console (in the order they have always run in). */
export function describeDumpAndSnapshot(c: IntegrationContext): void {
  const { dialect, req } = c
  it('walks databases → tables → structure → rows', async () => {
    const dbs = z.array(z.object({ name: z.string() })).parse(await (await req('/api/databases')).json())
    expect(dbs.map((d) => d.name)).toContain('tsmyadmin_test')
    const tables = await (await req('/api/databases/tsmyadmin_test/tables')).json()
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(tables)
        .map((t) => t.name)
    ).toContain('users')
    const structure = TableSchemaSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/structure')).json()
    )
    expect(structure.primaryKey).toEqual(['id'])
    const rows = BrowseResultSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/rows?sort=name:desc&limit=2')).json()
    )
    expect(rows.rows.map((r) => r[1])).toEqual(['Eve', 'Dave'])
    expect(rows.total).toBe(5)
  })

  it('runs SQL and previews DDL', async () => {
    const results = z.array(StatementResultSchema).parse(
      await (
        await req('/api/databases/tsmyadmin_test/sql', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM users' }),
        })
      ).json()
    )
    expect(results[0]?.kind).toBe('rows')
    const preview = await (
      await req('/api/databases/tsmyadmin_test/ddl/preview', {
        method: 'POST',
        body: JSON.stringify({ op: { op: 'dropTable', table: 'users' } }),
      })
    ).json()
    expect(z.object({ sql: z.array(z.string()) }).parse(preview).sql[0]).toMatch(/DROP TABLE/)
  })

  it('produces a SQL dump that restores over the existing objects (foreign keys after all tables)', async () => {
    const parent = `dump_parent_${dialect}`
    const child = `dump_child_${dialect}`
    const sql = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    await sql(
      `CREATE TABLE ${parent} (id INT PRIMARY KEY);
       CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT NULL, CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent} (id));
       INSERT INTO ${parent} (id) VALUES (1); INSERT INTO ${child} (id, parent_id) VALUES (1, 1)`
    )
    try {
      // child sorts before parent: the dump must still restore (DROP ... CASCADE / FK checks off, FKs last).
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${child},${parent}&format=sql`)).text()
      expect(dump).toContain('dump complete')
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      const errors = restored.filter((r) => r.kind === 'error')
      expect(errors).toEqual([])
      const rows = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/rows`)).json()
      )
      expect(rows.rows).toEqual([[1, 1]])
      const structure = TableSchemaSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/structure`)).json()
      )
      expect(structure.foreignKeys.map((f) => f.refTable)).toEqual([parent])
    } finally {
      await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    }
  })

  it('takes a snapshot and puts it back: changed rows, a dropped table, and what was made since', async () => {
    const scratch = `it_snap_${dialect}_${Date.now().toString(36)}`
    const mysql = dialect === 'mysql'
    // MySQL: a database of its own. PostgreSQL: a schema of the test database.
    const db = mysql ? scratch : 'tsmyadmin_test'
    const schema = mysql ? '' : `?schema=${scratch}`
    const run = (path: string, text: string) =>
      req(`/api/databases/${path}/sql`, {
        method: 'POST',
        body: JSON.stringify({ sql: text, stopOnError: true, ...(mysql ? {} : { schema: scratch }) }),
      })
    const errorsOf = async (res: Response) =>
      z
        .array(StatementResultSchema)
        .parse(await res.json())
        .filter((r) => r.kind === 'error')
    const rows = async (table: string) =>
      BrowseResultSchema.parse(await (await req(`/api/databases/${db}/tables/${table}/rows${schema}`)).json()).rows
    await req('/api/databases/tsmyadmin_test/sql', {
      method: 'POST',
      body: JSON.stringify({ sql: mysql ? `CREATE DATABASE ${scratch}` : `CREATE SCHEMA ${scratch}` }),
    })
    try {
      expect(
        await errorsOf(
          await run(
            db,
            `CREATE TABLE a (id INT PRIMARY KEY, v VARCHAR(20));
             CREATE TABLE b (id INT PRIMARY KEY, a_id INT, CONSTRAINT b_fk FOREIGN KEY (a_id) REFERENCES a (id));
             INSERT INTO a VALUES (1, 'one'), (2, 'two'); INSERT INTO b VALUES (1, 1)`
          )
        )
      ).toEqual([])
      const taken = SnapshotListSchema.parse(
        await (
          await req(`/api/databases/${db}/snapshots${schema}`, {
            method: 'POST',
            body: JSON.stringify({ name: 'start' }),
          })
        ).json()
      )
      const id = taken.snapshots[0]?.id ?? ''
      expect(taken.snapshots[0]).toMatchObject({ name: 'start', objects: 2 })
      // Changes after it: a row edited, a child row and a table removed, a new table made.
      expect(
        await errorsOf(
          await run(
            db,
            `UPDATE a SET v = 'changed' WHERE id = 1; DROP TABLE b; DELETE FROM a WHERE id = 2; CREATE TABLE c (id INT)`
          )
        )
      ).toEqual([])
      const preview = SnapshotRestorePreviewSchema.parse(
        await (await req(`/api/databases/${db}/snapshots/${id}/restore/preview${schema}`)).json()
      )
      expect(preview.drops).toHaveLength(1)
      expect(preview.drops[0]).toContain('c')
      const restored = await req(`/api/databases/${db}/snapshots/${id}/restore${schema}`, { method: 'POST' })
      const result = SnapshotRestoreResultSchema.parse(await restored.json())
      expect(result.errors).toEqual([])
      expect(result.failed).toBe(0)
      expect(await rows('a')).toEqual([
        [1, 'one'],
        [2, 'two'],
      ])
      expect(await rows('b')).toEqual([[1, 1]])
      // What was made since is gone.
      expect((await req(`/api/databases/${db}/tables/c/rows${schema}`)).status).toBe(404)
    } finally {
      await req('/api/databases/tsmyadmin_test/sql', {
        method: 'POST',
        body: JSON.stringify({
          sql: mysql ? `DROP DATABASE IF EXISTS ${scratch}` : `DROP SCHEMA IF EXISTS ${scratch} CASCADE`,
        }),
      })
    }
  })

  it('restores dumps written with the SQL options: REPLACE, UPDATE, one row per statement, IF NOT EXISTS, a transaction, no comments', async () => {
    const t = `dump_opts_${dialect}`
    const sql = async (text: string, db = 'tsmyadmin_test') =>
      req(`/api/databases/${db}/sql`, { method: 'POST', body: JSON.stringify({ sql: text }) })
    const rows = async () =>
      BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json()).rows
    const run = async (dump: string) => {
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
    }
    const dumpOf = async (params: string) =>
      (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql&${params}`)).text()
    await sql(`DROP TABLE IF EXISTS ${t}`)
    await sql(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO ${t} VALUES (1, 'one'), (2, 'two'), (3, 'three')`
    )
    try {
      // Rows written one to a statement, as REPLACE / ON CONFLICT, over a table that is there already.
      const replace = await dumpOf('structure=0&data=1&statement=replace&extended=0&transaction=1&comments=0')
      expect(replace).not.toContain('-- Table:')
      expect(replace.match(/^(REPLACE|INSERT) INTO/gm)).toHaveLength(3)
      await sql(`UPDATE ${t} SET name = 'changed'; DELETE FROM ${t} WHERE id = 3`)
      await run(replace)
      expect(await rows()).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
      ])

      // UPDATE by primary key puts values back without touching which rows exist.
      const update = await dumpOf('structure=0&data=1&statement=update')
      expect(update).toContain('UPDATE')
      await sql(`UPDATE ${t} SET name = 'x'; INSERT INTO ${t} VALUES (4, 'four')`)
      await run(update)
      expect(await rows()).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
        [4, 'four'],
      ])

      // IF NOT EXISTS + IGNORE restore over what is there without an error or a duplicate.
      const gentle = await dumpOf('dropTable=0&ifNotExists=1&ignore=1')
      expect(gentle).toMatch(/CREATE TABLE IF NOT EXISTS/)
      await run(gentle)
      expect(await rows()).toHaveLength(4)

      // A range: the middle two rows of the table.
      const middle = await dumpOf('structure=0&rowOffset=1&rowLimit=2')
      expect(middle).toContain("'two'")
      expect(middle).toContain("'three'")
      expect(middle).not.toContain("'one'")
      expect(middle).not.toContain("'four'")
      // Without a key an UPDATE dump is refused before it starts.
      const keyless = `${t}_keyless`
      await sql(`DROP TABLE IF EXISTS ${keyless}; CREATE TABLE ${keyless} (a INT)`)
      const refused = await req(`/api/databases/tsmyadmin_test/export?tables=${keyless}&format=sql&statement=update`)
      await sql(`DROP TABLE IF EXISTS ${keyless}`)
      expect(refused.status).toBe(400)
    } finally {
      await sql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('writes a view as a table with its rows when asked, and packages a dump as gzip and as a zip', async () => {
    const t = `dump_vt_${dialect}`
    const v = `${t}_v`
    const sql = async (text: string, db = 'tsmyadmin_test') =>
      req(`/api/databases/${db}/sql`, { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`)
    await sql(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO ${t} VALUES (1, 'one'), (2, 'two'); CREATE VIEW ${v} AS SELECT id, name FROM ${t} WHERE id > 1`
    )
    try {
      const dump = await (
        await req(`/api/databases/tsmyadmin_test/export?tables=${v}&format=sql&viewsAsTables=1`)
      ).text()
      expect(dump).toContain(`CREATE TABLE`)
      expect(dump).not.toContain('CREATE VIEW')
      // Restored into another database the view's rows are a table's.
      const other = dialect === 'mysql' ? 'tsmyadmin_other' : 'tsmyadmin_test'
      const restore = dialect === 'mysql' ? dump : dump.replace(new RegExp(v, 'g'), `${v}_copy`)
      const restored = z.array(StatementResultSchema).parse(await (await sql(restore, other)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const name = dialect === 'mysql' ? v : `${v}_copy`
      const copied = BrowseResultSchema.parse(await (await req(`/api/databases/${other}/tables/${name}/rows`)).json())
      expect(copied.rows.map((r) => r.slice(0, 2))).toEqual([[2, 'two']])
      await sql(`DROP TABLE IF EXISTS ${name}`, other)

      const gz = await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql&compress=gzip`)
      expect(gz.headers.get('content-type')).toBe('application/gzip')
      expect(new Uint8Array(await gz.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]))
      const zip = await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=csv&filePerTable=1`)
      expect(zip.headers.get('content-type')).toBe('application/zip')
    } finally {
      await sql(`DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('leaves generated columns out of the INSERTs it writes', async () => {
    // The server computes them; listing one in an INSERT makes the whole dump unrestorable.
    const t = `dump_gen_${dialect}`
    const sql = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP TABLE IF EXISTS ${t}`)
    const generated =
      dialect === 'mysql'
        ? `CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, twice INT AS (a * 2) STORED)`
        : `CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, twice INT GENERATED ALWAYS AS (a * 2) STORED)`
    await sql(`${generated}; INSERT INTO ${t} (id, a) VALUES (1, 21)`)
    try {
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql`)).text()
      // The column belongs in the CREATE but never in an INSERT's column list.
      expect(dump).toContain('twice')
      for (const line of dump.split('\n'))
        if (/^INSERT INTO/i.test(line.trim())) expect(line.slice(0, line.indexOf('VALUES'))).not.toContain('twice')
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const rows = BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json())
      expect(rows.rows).toEqual([[1, 21, 42]])
    } finally {
      await sql(`DROP TABLE IF EXISTS ${t}`)
    }
  })
}
