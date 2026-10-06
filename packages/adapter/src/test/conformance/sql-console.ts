import { type StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { AdapterError, type ExecuteOptions } from '../../types.ts'
import type { ConformanceEnv } from './env.ts'
import { EXEC } from './helpers.ts'

/** Conformance: the blocks of `sql-console` (in the order they have always run in). */
export function describeSqlConsole(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, browseAll, isMariaDb } = env
  describe('executeSql', () => {
    it('tells a request that no connection became free in time, instead of making it wait without end', async () => {
      // A session has four pooled connections. Four long statements hold all of them; a fifth request must be
      // answered (both dialects give up after ACQUIRE_TIMEOUT_MS), not left hanging until one of them ends.
      const sleep = dialect === 'mysql' ? 'SELECT SLEEP(30)' : 'SELECT pg_sleep(30)'
      const busy = ctx.create()
      const ids = Array.from({ length: 4 }, () => crypto.randomUUID())
      const holders = ids.map((queryId) =>
        busy.executeSql(ns, sleep, { ...EXEC, timeoutMs: 60_000, queryId }).catch(() => undefined)
      )
      // Long enough for all four statements to have taken a connection and started.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const started = performance.now()
      const err = await busy.listTables(ns).then(
        () => null,
        (e: unknown) => e
      )
      const waited = performance.now() - started
      for (const id of ids) await busy.cancelQuery(id).catch(() => undefined)
      await Promise.all(holders)
      // Once the places are free again the same session works: the refusal was not a lasting state.
      const afterwards = await busy.listTables(ns).then(
        () => null,
        (e: unknown) => e
      )
      await busy.close()
      expect(afterwards).toBeNull()
      expect(err).toBeInstanceOf(AdapterError)
      expect(err).toMatchObject({ code: 'CONNECTION_FAILED', message: 'No connection became free in time' })
      expect(waited).toBeGreaterThan(8_000)
      expect(waited).toBeLessThan(20_000)
    }, 40_000)

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
          expect(await open(`${begin};\nINSERT INTO ${t} VALUES (5);\nCREATE TEMPORARY TABLE ${t}_tmp (a INT);`)).toBe(
            true
          )
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
          const hit = await env.db.browseRows(ns, scratch, {
            offset: 0,
            limit: 10,
            sort: [],
            filters: [{ column: 'name', op: 'eq', value: "o'brien" }],
          })
          expect(hit.rows.map((r) => r[0])).toEqual([77])
          const miss = await env.db.browseRows(ns, scratch, {
            offset: 0,
            limit: 10,
            sort: [],
            filters: [{ column: 'name', op: 'eq', value: "o\\'brien" }],
          })
          expect(miss.rows).toEqual([])
          expect(await env.db.deleteRows(ns, scratch, [{ kind: 'pk', values: { id: 77 } }])).toEqual({
            affectedRows: 1,
          })
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
      const results = await env.db.executeSql(ns, 'SELECT 1 AS a; SELECT 2 AS b; SELECT * FROM nope_nope; SELECT 4', {
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
        nativeCode: dialect === 'mysql' ? ((await isMariaDb()) ? 'ER_STATEMENT_TIMEOUT' : 'ER_QUERY_TIMEOUT') : '57014',
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
      const run = env.db.executeSql(ns, `${ctx.slowSql}; SELECT 42 AS after`, {
        ...EXEC,
        stopOnError: false,
        timeoutMs: 60_000,
        queryId,
      })
      expect(await env.db.cancelQuery(queryId)).toBe(true)
      const results = await run
      expect(results).toHaveLength(1)
      expect(results[0]?.kind).toBe('error')
    })

    it('re-applies the namespace after a script changed it', async () => {
      await execOk(dialect === 'mysql' ? 'USE information_schema; SELECT 1' : 'SET search_path TO pg_catalog; SELECT 1')
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
      const rows = await env.db.browseRows(ns, scratch, {
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
      const run = env.db.executeSql(ns, 'SELECT 1 AS a; SELECT 2 AS b', {
        ...EXEC,
        queryId,
        onResult: async (_r, index) => {
          if (index === 0) await gate
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const cancelling = env.db.cancelQuery(queryId)
      await new Promise((resolve) => setTimeout(resolve, 300))
      release()
      expect(await cancelling).toBe(true)
      // Stopped between the statements: only the first ran.
      expect((await run).map((r) => r.kind)).toEqual(['rows'])
      expect((await exec('SELECT 1 AS x'))[0]).toMatchObject({ kind: 'rows' })
    })

    it('interrupts a running script from another connection and keeps the pool usable', async () => {
      const queryId = crypto.randomUUID()
      const run = env.db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
      // Registration is synchronous: a cancel issued immediately waits for the backend id and succeeds.
      expect(await env.db.cancelQuery(queryId)).toBe(true)
      const results = await run
      expect(results[0]?.kind).toBe('error')
      // KILL QUERY / pg_cancel_backend end the statement, not the connection: it must stay in the pool.
      if (results[0]?.kind === 'error') expect(results[0].code).not.toBe('CONNECTION_FAILED')
      expect(await env.db.cancelQuery(queryId)).toBe(false)
      const ok = await exec('SELECT 1 AS x')
      expect(ok[0]).toMatchObject({ kind: 'rows' })
    })

    it('shares one cancel between concurrent requests for the same run', async () => {
      const before = (await env.db.listProcesses()).length
      const queryId = crypto.randomUUID()
      const run = env.db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
      // A burst of cancel clicks must not become a burst of dedicated connections against the server:
      // sampled while the burst is in progress, the server sees at most one extra session.
      const burst = Array.from({ length: 25 }, () => env.db.cancelQuery(queryId))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const during = (await env.db.listProcesses()).length
      const results = await Promise.all(burst)
      expect(results.every((r) => r)).toBe(true)
      expect(during).toBeLessThanOrEqual(before + 3)
      expect((await run)[0]?.kind).toBe('error')
      // The cancel connection is closed again: the server sees no lingering sessions from the burst.
      expect((await env.db.listProcesses()).length).toBeLessThanOrEqual(before + 2)
    })

    it('cancels reliably even when the cancel reaches the server before the statement does', async () => {
      // The backend id is known before the statement is sent; a cancel landing on the idle connection is a
      // no-op on every server, so cancelQuery must keep re-sending it while the statement is in flight.
      for (let i = 0; i < 8; i++) {
        const queryId = crypto.randomUUID()
        const started = Date.now()
        const run = env.db.executeSql(ns, ctx.slowSql, { ...EXEC, timeoutMs: 60_000, queryId })
        expect(await env.db.cancelQuery(queryId)).toBe(true)
        const results = await run
        expect(results[0]?.kind).toBe('error')
        expect(Date.now() - started).toBeLessThan(10_000)
      }
    })

    it('returns false for unknown ids and for ids whose script already completed', async () => {
      expect(await env.db.cancelQuery(crypto.randomUUID())).toBe(false)
      const queryId = crypto.randomUUID()
      const results = await env.db.executeSql(ns, 'SELECT 1 AS x', { ...EXEC, queryId })
      expect(results[0]).toMatchObject({ kind: 'rows' })
      // The registration is removed on the success path too, so a late cancel is a no-op.
      expect(await env.db.cancelQuery(queryId)).toBe(false)
    })
  })
}
