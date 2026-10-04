import { createHash } from 'node:crypto'
import { EXACT_COUNT_MAX_ROWS, type Filter } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import type { ConformanceEnv } from './env.ts'
import { byName } from './helpers.ts'

/** Conformance: browseRows and the inserts (in the order they have always run in). */
export function describeBrowseAndInsert(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, browseAll } = env
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
