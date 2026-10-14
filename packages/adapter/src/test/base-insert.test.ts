import { describe, expect, it } from 'vitest'
import { BaseAdapter } from '../base.ts'
import type { MysqlAdapter } from '../mysql/adapter.ts'
import { AdapterError } from '../types.ts'
import { affecting, type Dialect, ns, rig } from './base-rig.ts'
import { type Answer, fail, rows } from './scripted-conn.ts'

/**
 * The statements `insertRows`, `insertRow` and `insertPreview` write, for both dialects: the verb of a duplicate, the
 * PostgreSQL conflict clause, the chunking, what INSERT IGNORE let pass, and which rows a failure points at. The
 * connection is scripted, so no server is needed.
 */

const adapterFor = (dialect: Dialect, script: [RegExp, Answer][] = [[/^(INSERT|REPLACE)/, affecting(1)]]) =>
  rig(dialect, { rules: script })
const statements = (asked: { text: string }[]) => asked.map((q) => q.text)

describe('BaseAdapter.chunkSize', () => {
  it('is 500 rows for few columns, fewer as columns grow to keep under 30000 values, never below 1', () => {
    expect(BaseAdapter.chunkSize(1)).toBe(500)
    expect(BaseAdapter.chunkSize(60)).toBe(500)
    expect(BaseAdapter.chunkSize(61)).toBe(491)
    expect(BaseAdapter.chunkSize(100)).toBe(300)
    expect(BaseAdapter.chunkSize(30_000)).toBe(1)
    expect(BaseAdapter.chunkSize(100_000)).toBe(1)
    expect(BaseAdapter.chunkSize(0)).toBe(500)
  })
})

describe('insertRows: the statement', () => {
  it('writes a multi-row INSERT with the table and columns quoted, and the values as parameters', async () => {
    const m = adapterFor('mysql')
    expect(
      await m.adapter.insertRows(
        ns,
        't',
        ['a', 'we`ird'],
        [
          [1, 'x'],
          [2, null],
        ]
      )
    ).toEqual({ affectedRows: 1 })
    expect(m.asked[0]).toEqual({
      text: 'INSERT INTO `d`.`t` (`a`, `we``ird`) VALUES (?, ?), (?, ?)',
      params: [1, 'x', 2, null],
    })
    const p = adapterFor('postgres')
    await p.adapter.insertRows(
      ns,
      't',
      ['a', 'b'],
      [
        [1, 'x'],
        [2, 'y'],
      ]
    )
    expect(p.asked[0]).toEqual({
      text: 'INSERT INTO "sales"."t" ("a", "b") VALUES ($1, $2), ($3, $4)',
      params: [1, 'x', 2, 'y'],
    })
  })

  it('writes a missing value as null', async () => {
    const m = adapterFor('mysql')
    await m.adapter.insertRows(ns, 't', ['a', 'b'], [[1]])
    expect(m.asked[0]?.params).toEqual([1, null])
  })

  it('refuses no columns, and does nothing, not even a transaction, for no rows', async () => {
    const m = adapterFor('mysql')
    await expect(m.adapter.insertRows(ns, 't', [], [[1]])).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: 'insertRows requires at least one column',
    })
    expect(await m.adapter.insertRows(ns, 't', ['a'], [])).toEqual({ affectedRows: 0 })
    expect(m.transactions()).toBe(0)
    expect(m.sent).toHaveLength(0)
  })

  it('takes the rows from any iterable, as they come', async () => {
    const m = adapterFor('mysql')
    function* gen() {
      yield [1]
      yield [2]
    }
    await m.adapter.insertRows(ns, 't', ['a'], gen())
    expect(m.asked[0]?.params).toEqual([1, 2])
  })

  it('splits the rows into chunks that fit, runs them in one transaction and adds up the rows they changed', async () => {
    const m = adapterFor('mysql', [[/^INSERT/, affecting(7)]])
    const many = Array.from({ length: 1200 }, (_, i) => [i, i, i])
    expect(await m.adapter.insertRows(ns, 't', ['a', 'b', 'c'], many)).toEqual({ affectedRows: 21 })
    expect(m.transactions()).toBe(1)
    expect(m.statements().at(-1)).toBe('COMMIT')
    expect(m.asked.map((q) => q.params?.length)).toEqual([1500, 1500, 600])
    const exact = adapterFor('mysql')
    await exact.adapter.insertRows(
      ns,
      't',
      ['a'],
      Array.from({ length: 500 }, (_, i) => [i])
    )
    expect(exact.asked).toHaveLength(1)
  })

  it('numbers PostgreSQL parameters from $1 again in every statement', async () => {
    const p = adapterFor('postgres')
    await p.adapter.insertRows(
      ns,
      't',
      ['a'],
      Array.from({ length: 501 }, (_, i) => [i])
    )
    expect(p.asked[1]?.text).toBe('INSERT INTO "sales"."t" ("a") VALUES ($1)')
  })
})

describe('insertRows: duplicates', () => {
  const head = async (dialect: Dialect, options: Parameters<MysqlAdapter['insertRows']>[4]) => {
    const a = adapterFor(dialect, [[/./, affecting(1)]])
    await a.adapter.insertRows(ns, 't', ['id', 'name'], [[1, 'x']], options)
    return a.asked[0]?.text ?? ''
  }

  it('uses REPLACE or INSERT IGNORE on MySQL, and never a conflict clause', async () => {
    expect(await head('mysql', { onDuplicate: 'replace' })).toMatch(/^REPLACE INTO /)
    expect(await head('mysql', { onDuplicate: 'ignore' })).toMatch(/^INSERT IGNORE INTO /)
    expect(await head('mysql', {})).toMatch(/^INSERT INTO /)
    expect(await head('mysql', { onDuplicate: 'replace', keyColumns: ['id'] })).not.toContain('ON CONFLICT')
  })

  it('skips a conflicting row on PostgreSQL for ignore, and writes a plain INSERT without an option', async () => {
    expect(await head('postgres', { onDuplicate: 'ignore' })).toBe(
      'INSERT INTO "sales"."t" ("id", "name") VALUES ($1, $2) ON CONFLICT DO NOTHING'
    )
    expect(await head('postgres', {})).toBe('INSERT INTO "sales"."t" ("id", "name") VALUES ($1, $2)')
    expect(await head('postgres', { onDuplicate: 'ignore', keyColumns: ['id'] })).toContain('ON CONFLICT DO NOTHING')
  })

  it('rewrites the other columns of the key on PostgreSQL for replace', async () => {
    expect(await head('postgres', { onDuplicate: 'replace', keyColumns: ['id'] })).toBe(
      'INSERT INTO "sales"."t" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"'
    )
    expect(await head('postgres', { onDuplicate: 'replace', keyColumns: ['name', 'id'] })).toContain(
      'VALUES ($1, $2) ON CONFLICT DO NOTHING'
    )
    expect(await head('postgres', { onDuplicate: 'replace', keyColumns: ['we"ird'] })).toContain(
      'ON CONFLICT ("we""ird") DO UPDATE SET "id" = EXCLUDED."id", "name" = EXCLUDED."name"'
    )
  })

  it('refuses to replace rows on PostgreSQL without a key, before sending anything', async () => {
    for (const keyColumns of [undefined, []]) {
      const a = adapterFor('postgres')
      await expect(
        a.adapter.insertRows(ns, 't', ['id'], [[1]], { onDuplicate: 'replace', ...(keyColumns ? { keyColumns } : {}) })
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        message: 'Replacing rows needs a primary key on the table',
      })
      expect(a.sent).toHaveLength(0)
    }
  })

  it('writes OVERRIDING SYSTEM VALUE after the columns on PostgreSQL only', async () => {
    expect(await head('postgres', { overriding: true })).toBe(
      'INSERT INTO "sales"."t" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ($1, $2)'
    )
    expect(await head('postgres', { overriding: false })).not.toContain('OVERRIDING')
    expect(await head('mysql', { overriding: true })).not.toContain('OVERRIDING')
  })
})

describe('insertRows: what INSERT IGNORE let pass', () => {
  const WARNINGS = /^SHOW WARNINGS/
  const run = async (
    warnings: unknown[][],
    options: Parameters<MysqlAdapter['insertRows']>[4] = { onDuplicate: 'ignore' },
    dialect: Dialect = 'mysql'
  ) => {
    const a = adapterFor(dialect, [
      [/^(INSERT|REPLACE)/, affecting(1)],
      [WARNINGS, rows(warnings)],
    ])
    const out = await a.adapter.insertRows(ns, 't', ['a'], [[1]], options)
    return { out, asked: statements(a.asked) }
  }

  it('hands back the warnings that are not the duplicate key itself, which is what was asked to be left out', async () => {
    const { out } = await run([
      ['Warning', 1062, 'Duplicate entry'],
      ['Warning', 1265, "Data truncated for column 'a'"],
      ['Note', 1048, 'Column cannot be null'],
    ])
    expect(out).toEqual({ affectedRows: 1, warnings: ["Data truncated for column 'a'", 'Column cannot be null'] })
  })

  it('leaves the warnings out of the result when there are none, and keeps at most 20', async () => {
    expect(await run([['Warning', 1062, 'dup']])).toMatchObject({ out: { affectedRows: 1 } })
    expect((await run([['Warning', 1062, 'dup']])).out).not.toHaveProperty('warnings')
    const many = Array.from({ length: 30 }, (_, i) => ['Warning', 1265, `w${i}`])
    const out = (await run(many)).out as { warnings: string[] }
    expect(out.warnings).toHaveLength(20)
    expect(out.warnings.at(-1)).toBe('w19')
  })

  it('reads the warnings only on MySQL and only for ignore', async () => {
    expect((await run([], { onDuplicate: 'ignore' })).asked).toContain('SHOW WARNINGS')
    expect((await run([], { onDuplicate: 'replace' })).asked).not.toContain('SHOW WARNINGS')
    expect((await run([], {})).asked).not.toContain('SHOW WARNINGS')
    expect((await run([], { onDuplicate: 'ignore' }, 'postgres')).asked).not.toContain('SHOW WARNINGS')
  })
})

describe('insertRows: a failure points at the rows', () => {
  /** An adapter whose INSERT number `failOn` fails with `error`; the transaction is rolled back. */
  const failing = (dialect: Dialect, error: Error, failOn = 1) => {
    let n = 0
    const r = rig(dialect, {
      rules: (text) => (/^INSERT/.test(text) ? (++n === failOn ? error : affecting(1)) : undefined),
    })
    return r
  }
  const fiveHundredAnd = (extra: number) => Array.from({ length: 500 + extra }, (_, i) => [i])

  it("names the whole statement's rows when the server does not say which one failed, and rolls back", async () => {
    const a = failing('postgres', fail('QUERY_FAILED', '23505'))
    await expect(a.adapter.insertRows(ns, 't', ['a'], fiveHundredAnd(3))).rejects.toMatchObject({ rows: [0, 499] })
    expect(a.statements().at(-1)).toBe('ROLLBACK')
    const second = failing('postgres', fail('QUERY_FAILED', '23505'), 2)
    await expect(second.adapter.insertRows(ns, 't', ['a'], fiveHundredAnd(3))).rejects.toMatchObject({
      rows: [500, 502],
    })
    expect(second.statements().at(-1)).toBe('ROLLBACK')
    expect(second.statements()).not.toContain('COMMIT')
  })

  it('names the one row MySQL says failed, counted from the start of the whole batch', async () => {
    const dataTooLong = new AdapterError(
      'QUERY_FAILED',
      "ER_DATA_TOO_LONG: Data too long for column 'a' at row 3",
      undefined,
      { nativeCode: 'ER_DATA_TOO_LONG' }
    )
    await expect(
      failing('mysql', dataTooLong).adapter.insertRows(ns, 't', ['a'], fiveHundredAnd(3))
    ).rejects.toMatchObject({ rows: [2, 2] })
    await expect(
      failing('mysql', dataTooLong, 2).adapter.insertRows(ns, 't', ['a'], fiveHundredAnd(3))
    ).rejects.toMatchObject({ rows: [502, 502] })
    const inDetail = new AdapterError('QUERY_FAILED', 'x', 'Out of range value at ROW 1')
    await expect(failing('mysql', inDetail).adapter.insertRows(ns, 't', ['a'], [[1]])).rejects.toMatchObject({
      rows: [0, 0],
    })
  })

  it('keeps the code, message, detail, native code and position of the error', async () => {
    const e = new AdapterError('PERMISSION_DENIED', '42501: denied', 'detail text', {
      nativeCode: '42501',
      position: 9,
    })
    await expect(failing('postgres', e).adapter.insertRows(ns, 't', ['a'], [[1]])).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '42501: denied',
      detail: 'detail text',
      nativeCode: '42501',
      position: 9,
      rows: [0, 0],
    })
    const bare = await failing('postgres', new AdapterError('QUERY_FAILED', 'bare'))
      .adapter.insertRows(ns, 't', ['a'], [[1]])
      .catch((x) => x)
    expect(bare).not.toHaveProperty('nativeCode', expect.anything())
    expect(bare.position).toBeUndefined()
  })

  it('turns an error the driver threw into an adapter error first', async () => {
    const a = failing('postgres', Object.assign(new Error('duplicate key'), { code: '23505' }))
    await expect(a.adapter.insertRows(ns, 't', ['a'], [[1]])).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      nativeCode: '23505',
      rows: [0, 0],
    })
  })
})

describe('insertRow and insertPreview', () => {
  it('previews the statement and its parameters, bytes as base64 and the rest as they are', () => {
    const { adapter } = adapterFor('mysql')
    const preview = adapter.insertPreview(ns, 't', { a: 1, b: { $bin: 'AQI=' }, c: 'x' })
    expect(preview.sql).toContain('INSERT INTO `d`.`t`')
    expect(preview.params).toContain(1)
    expect(preview.params).toContainEqual({ $bin: 'AQI=' })
    expect(preview.params).toContain('x')
  })

  it('writes INSERT IGNORE for the preview and the insert only when asked for ignore', async () => {
    const { adapter, asked } = adapterFor('mysql', [[/^INSERT/, affecting(1)]])
    expect(adapter.insertPreview(ns, 't', { a: 1 }).sql).toMatch(/^INSERT INTO /)
    expect(adapter.insertPreview(ns, 't', { a: 1 }, { ignore: true }).sql).toMatch(/^INSERT IGNORE INTO /)
    expect(adapter.insertPreview(ns, 't', { a: 1 }, { ignore: false }).sql).toMatch(/^INSERT INTO /)
    expect(await adapter.insertRow(ns, 't', { a: 1 })).toEqual({ affectedRows: 1 })
    await adapter.insertRow(ns, 't', { a: 1 }, { ignore: true })
    expect(statements(asked).map((s) => s.slice(0, 14))).toEqual(['INSERT INTO `d', 'INSERT IGNORE '])
  })
})
