import { type ColumnSpec, type DdlOp, type Namespace, sqlScript } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { quoteIdent, quoteTable } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'
import { col } from './helpers.ts'

/** Conformance: the blocks of `ddl` (in the order they have always run in). */
export function describeDdl(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, scratchDdl, exec, execOk, runDdl, browseAll, isMariaDb } = env
  describe('ddl', () => {
    /** As the web runs a preview: all of an op's statements as one script through the SQL route. */
    const runScript = async (op: DdlOp) => execOk(sqlScript(dialect, env.db.ddl.build(ns, op)))
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
        const listed = (await env.db.listRoutines(ns)).map((r) => r.name)
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
        const parameters = (await env.db.listRoutines(ns)).find((r) => r.name === fn)?.parameters
        await runScript({
          op: 'alterRoutine',
          kind: 'function',
          name: fn,
          ...(dialect === 'postgres' ? { parameters } : {}),
          sqlSecurity: 'DEFINER',
          comment: 'changed',
        })
        expect(await security()).toBe('DEFINER')
        expect((await env.db.listRoutines(ns)).find((r) => r.name === fn)?.comment).toBe('changed')
        await runScript({
          op: 'dropRoutine',
          kind: 'function',
          name: fn,
          ...(dialect === 'postgres' ? { parameters } : {}),
        })
        expect((await env.db.listRoutines(ns)).map((r) => r.name)).not.toContain(fn)

        await execOk(`CREATE TABLE ${table} (id INT PRIMARY KEY, v INT)`)
        await runScript({
          op: 'createTrigger',
          name: trigger,
          table,
          timing: 'BEFORE',
          event: 'INSERT',
          body: dialect === 'mysql' ? 'SET NEW.v = 1;' : 'BEGIN\n  NEW.v := 1;\n  RETURN NEW;\nEND;',
        })
        expect((await env.db.listTriggers(ns, table)).map((x) => x.name)).toContain(trigger)
        await runScript({ op: 'dropTrigger', name: trigger, table })
        expect((await env.db.listTriggers(ns, table)).map((x) => x.name)).not.toContain(trigger)

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
        expect((await env.db.describeTable(ns, customers)).primaryKey).toEqual(['customer_id'])
        const kept = await env.db.describeTable(ns, orders)
        expect(kept.columns.map((c) => c.name)).toEqual(['id', 'customer_id'])
        expect(kept.foreignKeys.map((f) => f.refTable)).toEqual([customers])
        expect(await count(orders)).toBe(4)

        // The same key with two different values: the primary key of the new table is what refuses it, and the
        // original keeps its columns because the statements after the failure never run.
        await execOk(`CREATE TABLE ${bad} (id INT PRIMARY KEY, k INT, v VARCHAR(20))`)
        await execOk(`INSERT INTO ${bad} VALUES (1, 10, 'Ann'), (2, 10, 'Anna')`)
        const statements = env.db.ddl.build(ns, {
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
        expect((await env.db.describeTable(ns, bad)).columns.map((c) => c.name)).toEqual(['id', 'k', 'v'])

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
        expect((await env.db.describeTable(ns, phones)).columns.map((c) => c.name)).toEqual(['id', 'phone'])
        expect((await env.db.describeTable(ns, phones)).foreignKeys.map((f) => f.refTable)).toEqual([contacts])
        expect((await env.db.describeTable(ns, contacts)).columns.map((c) => c.name)).toEqual(['id'])
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
          ...(dialect === 'postgres'
            ? { columns: { [t]: [{ name: 'name', dataType: 'character varying(20)' }] } }
            : {}),
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
        expect((await env.db.listTriggers(ns)).map((x) => x.name)).toContain(trigger)
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
        const listed = (await env.db.listEvents(ns)).find((e) => e.name === event)
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
        expect((await env.db.describeTable(ns, t)).columns[0]?.comment).toBe('renumbered')
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
        const schema = await env.db.describeTable(ns, t)
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
        const refuses = async (sql: string) => (await exec(sql, { stopOnError: false })).some((r) => r.kind === 'error')
        const schema = await env.db.describeTable(ns, t)
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
        const schema = await env.db.describeTable(ns, t)
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
            const c = (await env.db.describeTable(ns, b)).columns.find((x) => x.name === 'v')
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
        const schema = await env.db.describeTable(ns, t)
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
        const before = await env.db.describeTable(ns, t)
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
        const after = await env.db.describeTable(ns, t)
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
  })
}
