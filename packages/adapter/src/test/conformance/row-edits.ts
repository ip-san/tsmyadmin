import { type RowKey } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import type { ConformanceEnv } from './env.ts'
import { input } from './helpers.ts'

/** Conformance: the blocks of `row-edits` (in the order they have always run in). */
export function describeRowEdits(env: ConformanceEnv): void {
  const { ns, dialect, scratch, scratchNoPk, exec, execOk, browseAll, isMariaDb } = env
  describe('countRows', () => {
    it('counts every row exactly, and lists MySQL tables with their collation and creation time', async () => {
      expect(await env.db.countRows(ns, 'users')).toBe(5)
      await expect(env.db.countRows(ns, `${scratch}_none`)).rejects.toMatchObject({ code: expect.any(String) })
      const users = (await env.db.listTables(ns)).find((x) => x.name === 'users')
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
        const st = await env.db.tableStats(ns, t)
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
        const view = await env.db.tableStats(ns, 'active_users')
        expect([view.dataBytes, view.indexBytes, view.totalBytes, view.rowEstimate]).toEqual([null, null, null, null])
        await expect(env.db.tableStats(ns, `${t}_missing`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
        await env.db.insertRow(ns, t, { id: 1, b: { $bin: bytes.toString('base64') }, s: 'x'.repeat(5) })
        await env.db.insertRow(ns, t, { id: 2, b: null, s: null })
        const page = await env.db.browseRows(ns, t, { offset: 0, limit: 1, sort: [], filters: [] })
        const cut = page.rows[0]?.[1]
        expect(cut && typeof cut === 'object' && '$bin' in cut ? Buffer.from(cut.$bin, 'base64').length : 0).toBe(
          65_536
        )

        const whole = await env.db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'b')
        expect(
          whole && typeof whole === 'object' && '$bin' in whole ? Buffer.from(whole.$bin, 'base64') : null
        ).toEqual(bytes)
        expect(await env.db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 's')).toBe('xxxxx')
        // Any type, not only text and binary (PostgreSQL's octet_length has no integer form).
        expect(await env.db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'id')).toBe(1)
        expect(await env.db.readCell(ns, t, { kind: 'pk', values: { id: 2 } }, 'b')).toBeNull()
        await expect(env.db.readCell(ns, t, { kind: 'pk', values: { id: 3 } }, 'b')).rejects.toMatchObject({
          code: 'KEY_MISMATCH',
        })
        await expect(env.db.readCell(ns, t, { kind: 'pk', values: { id: 1 } }, 'nope')).rejects.toMatchObject({
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
            await env.db.updateRow(ns, t, { kind: 'all-columns', values: { s: b, n: 1 } }, { n: '99' })
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
            await env.db.deleteRows(ns, t, [{ kind: 'all-columns', values: { s: b, n: 1 } }])
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
      const r = await env.db.updateRow(ns, scratch, { kind: 'pk', values: { id: 2 } }, { name: 'second', n: 43 })
      expect(r.affectedRows).toBe(1)
      const rows = await env.db.browseRows(ns, scratch, {
        offset: 0,
        limit: 10,
        sort: [],
        filters: [{ column: 'id', op: 'eq', value: 2 }],
      })
      expect(rows.rows[0]?.slice(1)).toEqual(['second', 43])
    })

    it('rolls back and reports KEY_MISMATCH when the key matches no row', async () => {
      await expect(
        env.db.updateRow(ns, scratch, { kind: 'pk', values: { id: 999 } }, { name: 'ghost' })
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
      const r = await env.db.updateRow(ns, scratchNoPk, key, { b: 'uno' })
      expect(r.affectedRows).toBe(1)
      const after = await browseAll(scratchNoPk)
      expect(after.rows.filter((x) => x[1] === 'uno')).toHaveLength(1)
      expect(after.rows.filter((x) => x[1] === 'one')).toHaveLength(1)
    })

    it.skipIf(dialect !== 'postgres')('rejects a stale ctid after the row moved (PostgreSQL)', async () => {
      const before = await browseAll(scratchNoPk)
      const target = before.rows.find((r) => r[0] === 2 && r[1] === 'two')
      const stale = String(target?.at(-1))
      expect(await env.db.updateRow(ns, scratchNoPk, { kind: 'ctid', value: stale }, { b: 'dos' })).toEqual({
        affectedRows: 1,
      })
      // The UPDATE wrote a new tuple version, so the captured ctid no longer addresses a live row.
      await expect(
        env.db.updateRow(ns, scratchNoPk, { kind: 'ctid', value: stale }, { b: 'tres' })
      ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
      await expect(env.db.deleteRows(ns, scratchNoPk, [{ kind: 'ctid', value: stale }])).rejects.toMatchObject({
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
      const filtered = await env.db.browseRows(ns, t, {
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
      expect(await env.db.updateRow(ns, t, key, { v: 2 })).toEqual({ affectedRows: 1 })
      // The same values as a composite "primary key" (FLOAT 0.1 ≠ DOUBLE 0.1 unless cast).
      await execOk(`ALTER TABLE ${t} ADD PRIMARY KEY (f, d)`)
      const pk: RowKey = { kind: 'pk', values: { f: input(row[0]), d: input(row[1]) } }
      expect(await env.db.updateRow(ns, t, pk, { v: 3 })).toEqual({ affectedRows: 1 })
      expect((await browseAll(t)).rows[0]?.[3]).toBe(3)
      // Keyset paging over a FLOAT key must not re-read the last row of each batch.
      await execOk(`INSERT INTO ${t} (f, d, j, v) VALUES (0.2, 1, '{}', 4), (0.3, 1, '{}', 5)`)
      const seen: number[] = []
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 1 })) for (const r of b.rows) seen.push(Number(r[3]))
      expect(seen).toEqual([3, 4, 5])
      expect(await env.db.deleteRows(ns, t, [pk])).toEqual({ affectedRows: 1 })
      await execOk(`DROP TABLE ${t}`)
    })

    it.skipIf(dialect !== 'mysql')('matches NULL values in all-columns keys (MySQL)', async () => {
      const r = await env.db.updateRow(
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
      await env.db.insertRow(ns, scratch, { id: 3, name: 'three' })
      const r = await env.db.deleteRows(ns, scratch, [
        { kind: 'pk', values: { id: 2 } },
        { kind: 'pk', values: { id: 3 } },
      ])
      expect(r.affectedRows).toBe(2)
      expect((await browseAll(scratch)).rows.map((x) => x[0])).toEqual([1])
    })

    it('rolls back the whole batch when one key mismatches', async () => {
      await env.db.insertRow(ns, scratch, { id: 4, name: 'four' })
      await expect(
        env.db.deleteRows(ns, scratch, [
          { kind: 'pk', values: { id: 4 } },
          { kind: 'pk', values: { id: 999 } },
        ])
      ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
      expect((await browseAll(scratch)).rows.map((x) => x[0])).toEqual([1, 4])
    })
  })
}
