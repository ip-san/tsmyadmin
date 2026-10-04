import { expect, it } from 'vitest'
import type { ConformanceEnv, DdlHelpers } from './env.ts'

/** Conformance of `ddl`: objects (in the order they have always run in). */
export function describeDdlObjects(env: ConformanceEnv, { runScript, firstValue }: DdlHelpers): void {
  const { ns, dialect, scratch, exec, execOk } = env
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
}
