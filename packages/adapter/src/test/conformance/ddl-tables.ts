import { type Namespace, sqlScript } from '@tsmyadmin/shared'
import { expect, it } from 'vitest'
import { quoteIdent, quoteTable } from '../../sql/quote.ts'
import type { ConformanceEnv, DdlHelpers } from './env.ts'

/** Conformance of `ddl`: tables (in the order they have always run in). */
export function describeDdlTables(env: ConformanceEnv, { runScript }: DdlHelpers): void {
  const { ctx, ns, dialect, scratch, exec, execOk, runDdl } = env
  it('moves a table, rows and all, to another database (MySQL) or schema (PostgreSQL)', async () => {
    const t = `${scratch}_mv`
    const target = dialect === 'mysql' ? ctx.otherDatabase : `${scratch}_sch`
    const there: Namespace = dialect === 'mysql' ? { database: target } : { database: ns.database, schema: target }
    await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
    await execOk(`INSERT INTO ${t} (id) VALUES (1), (2)`)
    if (dialect === 'postgres') await execOk(`CREATE SCHEMA ${quoteIdent(dialect, target)}`)
    try {
      await runScript({ op: 'moveTable', table: t, to: target })
      expect((await env.db.listTables(ns)).map((x) => x.name)).not.toContain(t)
      expect((await env.db.listTables(there)).map((x) => x.name)).toContain(t)
      const moved = await env.db.browseRows(there, t, { offset: 0, limit: 10, sort: [], filters: [] })
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
      expect((await env.db.describeTable(ns, t)).columns.find((c) => c.name === 'name')?.collation).toBe(collation)
      if (dialect === 'mysql') {
        await runDdl({ op: 'setTableOptions', table: t, rowFormat: 'DYNAMIC' })
        expect((await env.db.tableStats(ns, t)).rowFormat).toBe('Dynamic')
        // InnoDB's statistics options, read back from the statement the server prints.
        await runDdl({ op: 'setTableOptions', table: t, statsPersistent: '0', statsAutoRecalc: '1' })
        const printed = (await env.db.showCreateTable(ns, t)).join('\n')
        expect(printed).toMatch(/STATS_PERSISTENT=0/i)
        expect(printed).toMatch(/STATS_AUTO_RECALC=1/i)
        await runDdl({ op: 'orderTable', table: t, column: 'name', desc: true })
        const [sum] = await exec(
          sqlScript(dialect, env.db.ddl.build(ns, { op: 'maintainTable', table: t, action: 'checksum' }))
        )
        expect(sum?.kind).toBe('rows')
      } else {
        const pk = (await env.db.describeTable(ns, t)).indexes.find((i) => i.primary)?.name ?? ''
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
      const copied = await env.db.describeTable(otherNs, copy)
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
        ...(dialect === 'postgres' ? { columns: { [t]: [{ name: 'name', dataType: 'character varying(20)' }] } } : {}),
      })
      expect((await env.db.describeTable(ns, t)).columns.find((c) => c.name === 'name')?.collation).toBe(collation)
      if (dialect === 'mysql') expect(await schemaDefault()).toBe(collation)
      else
        expect(() =>
          env.db.ddl.build(ns, { op: 'setDatabaseCollation', name: ns.database, collation, applyToTables: false })
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
      const names = (await env.db.listTables(ns)).map((x) => x.name)
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
}
