import { type ColumnSpec, sqlScript } from '@tsmyadmin/shared'
import { expect, it } from 'vitest'
import type { ConformanceEnv, DdlHelpers } from './env.ts'
import { col } from './helpers.ts'

/** Conformance of `ddl`: columns and databases (in the order they have always run in). */
export function describeDdlColumnsAndDatabases(env: ConformanceEnv, { firstValue }: DdlHelpers): void {
  const { ns, dialect, scratch, scratchDdl, exec, execOk, runDdl, browseAll } = env
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
      const fk = (await env.db.describeTable(ns, t)).foreignKeys.find((f) => f.name === `${t}_user`)
      expect(fk).toMatchObject({
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      })
      expect((await env.db.describeTable(ns, 'users')).referencedBy.some((r) => r.fromTable === t)).toBe(true)
      await runDdl({ op: 'dropForeignKey', table: t, name: `${t}_user` })
      expect((await env.db.describeTable(ns, t)).foreignKeys).toEqual([])
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
    let s = await env.db.describeTable(ns, scratchDdl)
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
    s = await env.db.describeTable(ns, scratchDdl)
    expect(s.columns.map((c) => c.name)).toEqual(['id', 'name', 'n'])
    expect(s.columns[2]?.default).toBe('0')

    await runDdl({
      op: 'modifyColumn',
      table: scratchDdl,
      name: 'n',
      column: col('n2', 'BIGINT', { nullable: false, default: { kind: 'expression', sql: '1' } }),
    })
    s = await env.db.describeTable(ns, scratchDdl)
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
    s = await env.db.describeTable(ns, scratchDdl)
    expect(s.indexes.find((i) => i.name === `${scratchDdl}_name_idx`)).toMatchObject({
      unique: true,
      columns: ['name'],
    })

    await runDdl({ op: 'dropIndex', table: scratchDdl, name: `${scratchDdl}_name_idx` })
    s = await env.db.describeTable(ns, scratchDdl)
    expect(s.indexes.some((i) => i.name === `${scratchDdl}_name_idx`)).toBe(false)

    await runDdl({ op: 'dropColumn', table: scratchDdl, name: 'n2' })
    s = await env.db.describeTable(ns, scratchDdl)
    expect(s.columns.map((c) => c.name)).toEqual(['id', 'name'])

    await env.db.insertRow(ns, scratchDdl, { id: 1, name: 'x' })
    expect((await browseAll(scratchDdl)).total).toBe(1)
    await runDdl({ op: 'truncateTable', table: scratchDdl })
    expect((await browseAll(scratchDdl)).total).toBe(0)

    const renamed = `${scratchDdl}_rn`
    await runDdl({ op: 'renameTable', table: scratchDdl, newName: renamed })
    expect((await env.db.describeTable(ns, renamed)).columns.map((c) => c.name)).toEqual(['id', 'name'])
    await expect(env.db.describeTable(ns, scratchDdl)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runDdl({ op: 'renameTable', table: renamed, newName: scratchDdl })

    await runDdl({ op: 'dropTable', table: scratchDdl, kind: 'table' })
    await expect(env.db.describeTable(ns, scratchDdl)).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
      let s = await env.db.describeTable(ns, t)
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
      s = await env.db.describeTable(ns, t)
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
      expect((await env.db.describeTable(ns, t)).primaryKey).toEqual(['id', 'c'])

      await runDdl({
        op: 'modifyColumns',
        table: t,
        changes: [
          { name: 'b', column: col('b', 'BIGINT'), previous: col('b', 'INT') },
          { name: 'a', column: col('a', 'VARCHAR(60)'), previous: col('a', 'VARCHAR(40)') },
        ],
      })
      s = await env.db.describeTable(ns, t)
      expect(s.columns.find((c) => c.name === 'b')?.dataType.toLowerCase()).toContain('bigint')
      expect(s.columns.find((c) => c.name === 'a')?.dataType.toLowerCase()).toContain('60')

      if (dialect === 'mysql') {
        const specs = (await env.db.describeTable(ns, t)).columns.map((c) =>
          col(c.name, c.dataType, { nullable: c.nullable })
        )
        const reordered = [specs[3], specs[0], specs[1], specs[2]].filter((c): c is ColumnSpec => c !== undefined)
        await runDdl({ op: 'reorderColumns', table: t, columns: reordered })
        expect((await env.db.describeTable(ns, t)).columns.map((c) => c.name)).toEqual(['c', 'id', 'a', 'b'])
      }

      // A change that fails part-way (UNIQUE over duplicates) leaves the index as it was, run as the UI runs
      // it: one script, stopping at the first error.
      await execOk(`INSERT INTO ${t} (id, a, b, c) VALUES (1, 'dup', 1, 1), (2, 'dup', 2, 2)`)
      await runDdl({ op: 'addIndex', table: t, name: `${idx}c`, columns: ['c'], unique: false })
      const failed = await exec(
        sqlScript(
          dialect,
          env.db.ddl.build(ns, {
            op: 'alterIndex',
            table: t,
            name: `${idx}c`,
            index: { name: `${idx}c`, columns: ['a'], unique: true },
          })
        )
      )
      expect(failed.some((r) => r.kind === 'error')).toBe(true)
      expect((await env.db.describeTable(ns, t)).indexes.find((x) => x.name === `${idx}c`)).toMatchObject({
        columns: ['c'],
        unique: false,
      })

      await runDdl({ op: 'dropIndex', table: t, name: `${idx}3` })
      await runDdl({ op: 'dropColumns', table: t, names: ['a', 'b'] })
      expect((await env.db.describeTable(ns, t)).columns.map((c) => c.name).sort()).toEqual(['c', 'id'])
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
      let total = (await env.db.describeTable(ns, t)).columns.find((c) => c.name === 'total')
      expect(total?.generated?.stored).toBe(true)
      expect(total?.generated?.expression.replace(/[`"()\s]/g, '')).toBe('a+b')
      await env.db.insertRow(ns, t, { id: 1, a: 2, b: 3 })
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
      total = (await env.db.describeTable(ns, t)).columns.find((c) => c.name === 'total')
      expect(total).toMatchObject({ comment: 'sum', generated: { stored: true } })
      expect((await browseAll(t)).rows[0]?.[3]).toBe(5)

      // A new column with its key, and on MySQL in the first position.
      await runDdl({ op: 'addColumn', table: t, column: col('code', 'VARCHAR(10)'), first: true, key: 'unique' })
      const s = await env.db.describeTable(ns, t)
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
    expect((await env.db.describeTable(ns, a)).comment).toBe("bulk 'a'")
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
    await expect(env.db.describeTable(ns, a)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(env.db.describeTable(ns, b)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('copies a table with and without data', async () => {
    const copy = `${scratch}_copy`
    await runDdl({ op: 'copyTable', table: scratch, newName: copy, withData: true })
    const src = await browseAll(scratch)
    const dst = await browseAll(copy)
    expect(dst.columns.map((c) => c.name)).toEqual(src.columns.map((c) => c.name))
    expect(dst.total).toBe(src.total)
    expect((await env.db.describeTable(ns, copy)).primaryKey).toEqual(['id'])
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
    const identity = (await env.db.describeTable(ns, src2)).columns
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
    expect(await env.db.insertRow(ns, copy, { v: 4 })).toEqual({ affectedRows: 1 })
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
      const found = (await env.db.listDatabases()).map((d) => d.name)
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
    const left = (await env.db.listDatabases()).map((d) => d.name)
    expect(left).not.toContain(first)
    expect(left).not.toContain(second)
  })

  it('changes a server setting and puts it back to its default', async () => {
    const name = dialect === 'mysql' ? 'long_query_time' : 'work_mem'
    const wanted = dialect === 'mysql' ? '7' : '8MB'
    const read = async () =>
      (await env.db.listVariables()).find((v) => v.name === name)?.value?.replace(/\.0+$/, '') ?? ''
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
    expect((await env.db.listDatabases()).map((d) => d.name)).toContain(name)
    await runDdl({ op: 'dropDatabase', name })
    expect((await env.db.listDatabases()).map((d) => d.name)).not.toContain(name)
    if (dialect === 'postgres') {
      const schemaName = `${scratch}_tmpschema`
      await runDdl({ op: 'createSchema', name: schemaName })
      expect(await env.db.listSchemas(ns.database)).toContain(schemaName)
      await execOk(`DROP SCHEMA ${schemaName}`)
    }
  })
}
