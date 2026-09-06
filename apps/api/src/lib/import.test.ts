import { splitStatements } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ImportFormSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { decodeUpload, type ImportSqlOptions, importCsv, importSql } from './import.ts'

const ns = { database: 'shop' }
const adapter = () =>
  new FakeAdapter({ databases: { shop: { tables: { users: fakeTable('users', ['id', 'name', 'age'], []) } } } })
const form = (over: Record<string, string>) =>
  ImportFormSchema.parse({ file: new File([''], 'x.csv'), format: 'csv', table: 'users', ...over })

describe('importCsv', () => {
  it('maps header columns, converts the NULL marker and inserts through the adapter', async () => {
    const a = adapter()
    const r = await importCsv(a, ns, form({}), '﻿name,id,age\r\nAlice,1,30\r\nBob,2,\\N\r\n')
    expect(r).toMatchObject({ format: 'csv', table: 'users', columns: ['name', 'id', 'age'], inserted: 2 })
    expect(a.calls.at(-1)).toMatchObject({
      method: 'insertRows',
      args: [
        ns,
        'users',
        ['name', 'id', 'age'],
        [
          ['Alice', '1', '30'],
          ['Bob', '2', null],
        ],
        { overriding: false },
      ],
    })
  })

  it('keeps a quoted NULL marker and a quoted empty field, skips blank lines, decodes binary columns', async () => {
    const blobs = fakeTable('blobs', ['name', 'data'], [], ['name'])
    const data = blobs.schema.columns.find((c) => c.name === 'data')
    if (data) data.dataType = 'blob'
    const a = new FakeAdapter({ databases: { shop: { tables: { blobs } } } })
    const r = await importCsv(a, ns, form({ table: 'blobs' }), 'name\n"\\N"\n""\n\n\\N\nx\n')
    expect(r).toMatchObject({ inserted: 4 })
    expect(a.calls.at(-1)).toMatchObject({
      method: 'insertRows',
      args: [ns, 'blobs', ['name'], [['\\N'], [''], [null], ['x']], { overriding: false }],
    })
    const b = await importCsv(a, ns, form({ table: 'blobs' }), 'name,data\nx,AQI=\ny,\\N\n')
    expect(b).toMatchObject({ inserted: 2 })
    expect(a.calls.at(-1)).toMatchObject({
      args: [
        ns,
        'blobs',
        ['name', 'data'],
        [
          ['x', { $bin: 'AQI=' }],
          ['y', null],
        ],
        { overriding: false },
      ],
    })
    await expect(importCsv(a, ns, form({ table: 'blobs' }), 'name,data\nx,not base64!\n')).rejects.toThrow(/base64/)
    // A wrong file is reported without echoing its whole first line.
    const long = `${'a'.repeat(500)}\n`
    await expect(importCsv(adapter(), ns, form({}), long)).rejects.toThrow(/^Unknown column\(s\) in header: a{64}…$/)
    await expect(importCsv(adapter(), ns, form({}), 'q,r,s,t,u,,w\n')).rejects.toThrow(
      /^Unknown column\(s\) in header: q, r, s, t, u \(\+2\)$/
    )
    await expect(importCsv(adapter(), ns, form({}), 'id,\n1,2\n')).rejects.toThrow(/\(empty\)/)
    // The delimiter must be one character that is not structural to the parser.
    for (const delimiter of ['"', '\n', '\r', 'ab', '']) expect(() => form({ delimiter })).toThrow()
  })

  it('uses positional table columns without a header and pads short rows with NULL', async () => {
    const a = adapter()
    const r = await importCsv(a, ns, form({ header: '0', delimiter: ';' }), '1;A\n2\n')
    expect(r).toMatchObject({ columns: ['id', 'name'], inserted: 2 })
    expect(a.calls.at(-1)?.args[3]).toEqual([
      ['1', 'A'],
      ['2', null],
    ])
  })

  it('rejects unknown header columns, too-wide rows, empty files and a missing table', async () => {
    await expect(importCsv(adapter(), ns, form({}), 'id,nope\n1,2\n')).rejects.toThrow(/Unknown column/)
    await expect(importCsv(adapter(), ns, form({}), 'id,name\n1,"open\n2,x\n')).rejects.toMatchObject({
      reason: 'CSV_UNTERMINATED_QUOTE',
      params: { line: 2 },
    })
    // Header names match case-insensitively when exactly one column fits.
    const r = await importCsv(adapter(), ns, form({}), 'ID,Name\n3,Cy\n')
    expect(r).toMatchObject({ format: 'csv', columns: ['id', 'name'], inserted: 1 })
    expect(() => decodeUpload(new Uint8Array([0x61, 0x0a, 0xff, 0x62]))).toThrow(/not valid UTF-8 \(near line 2\)/)
    expect(decodeUpload(new TextEncoder().encode('caf\u00e9'))).toBe('caf\u00e9')
    await expect(importCsv(adapter(), ns, form({}), 'id\n1,2\n')).rejects.toThrow(/Line 2 has 2 fields/)
    await expect(importCsv(adapter(), ns, form({}), '')).rejects.toThrow(/empty/)
    await expect(
      importCsv(adapter(), ns, ImportFormSchema.parse({ file: new File([''], 'x.csv'), format: 'csv' }), 'id\n1\n')
    ).rejects.toThrow(/target table/)
  })
})

/** A fake that answers one `affected` result per `;`-separated statement (the default echoes the whole script). */
const perStatement = () =>
  new FakeAdapter({
    databases: { shop: { tables: { users: fakeTable('users', ['id', 'name', 'age'], []) } } },
    onSql: (_ns, sql) =>
      sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => ({ kind: 'affected' as const, sql: s, affectedRows: 1, durationMs: 1 })),
  })

const opts = (over: Partial<ImportSqlOptions>): ImportSqlOptions => ({
  stopOnError: true,
  ignoreForeignKeys: false,
  singleTransaction: false,
  queryId: 'q',
  ...over,
})

describe('importSql', () => {
  it('terminates the last statement with the delimiter in force (real splitter)', async () => {
    const seen: string[] = []
    const a = new FakeAdapter({
      dialect: 'mysql',
      onSql: (_ns, sql) =>
        splitStatements(sql, 'mysql').map((st) => {
          seen.push(st.sql)
          return { kind: 'affected' as const, sql: st.sql, affectedRows: 1, durationMs: 1 }
        }),
    })
    const files = [
      'INSERT INTO t VALUES (1)',
      'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$',
      'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nINSERT INTO t VALUES (2)',
      'DELIMITER //\nCALL p()',
    ]
    for (const file of files) {
      seen.length = 0
      const r = await importSql(a, { database: 'shop' }, file, opts({ singleTransaction: true, stopOnError: false }))
      if (r.format !== 'sql') throw new Error('sql result expected')
      // The user's statements, then the wrapper COMMIT — nothing merged, nothing phantom.
      expect(seen.length).toBe(r.total + 2)
      expect(seen.some((sql) => /DELIMITER\s*$/i.test(sql) || sql.trim() === ';')).toBe(false)
      expect(seen[seen.length - 1]).toBe('COMMIT')
      expect(r.failed).toBe(0)
    }
  })

  it('summarises statement results and caps the error list', async () => {
    const a = new FakeAdapter({
      onSql: (_ns, sql) =>
        sql
          .split(';')
          .map((s) => s.trim())
          // The real splitter drops the empty chunk the import appends before COMMIT.
          .filter((s) => s.length > 0)
          .map((s, i) =>
            i % 2
              ? { kind: 'error' as const, sql: s, message: 'boom', code: 'QUERY_FAILED' }
              : { kind: 'affected' as const, sql: s, affectedRows: 1, durationMs: 1 }
          ),
    })
    const r = await importSql(
      a,
      ns,
      Array.from({ length: 60 }, (_, i) => `S${i}`).join(';'),
      opts({ stopOnError: false })
    )
    expect(r).toMatchObject({ format: 'sql', total: 60, statements: 60, succeeded: 30, failed: 30, warnings: [] })
    if (r.format === 'sql') {
      expect(r.errors).toHaveLength(20)
      expect(r.errors[0]).toMatchObject({ index: 1 })
    }
    expect(a.calls.at(-1)?.args[2]).toMatchObject({ stopOnError: false, maxRows: 1, queryId: 'q' })
  })

  it('refuses a dump of the other dialect and an empty script, and flags database switches', async () => {
    await expect(importSql(adapter(), ns, '-- PostgreSQL database dump\nSELECT 1', opts({}))).rejects.toMatchObject({
      reason: 'WRONG_DIALECT',
      params: { dialect: 'postgres' },
    })
    await expect(importSql(adapter(), ns, '-- only a comment\n', opts({}))).rejects.toMatchObject({
      reason: 'NO_STATEMENTS',
    })
    const r = await importSql(
      perStatement(),
      ns,
      'USE other; INSERT INTO t VALUES (1); START TRANSACTION; INSERT INTO t VALUES (2)',
      opts({})
    )
    expect(r).toMatchObject({ format: 'sql', warnings: ['CHANGED_DATABASE', 'ROLLED_BACK'] })
  })

  it('wraps the script for FK-free and single-transaction runs and keeps the wrapper out of the counts', async () => {
    const a = perStatement()
    const r = await importSql(
      a,
      ns,
      'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)',
      opts({ ignoreForeignKeys: true, singleTransaction: true })
    )
    const sql = String(a.calls.at(-1)?.args[1])
    expect(sql.startsWith('SET FOREIGN_KEY_CHECKS = 0;\nSTART TRANSACTION;\n')).toBe(true)
    expect(sql.endsWith('\nCOMMIT;')).toBe(true)
    expect(r).toMatchObject({ format: 'sql', total: 2, statements: 2, succeeded: 2, warnings: [] })
    expect(a.calls.at(-1)?.args[2]).toMatchObject({ stopOnError: true })
    const progress: [number, number][] = []
    await importSql(
      a,
      ns,
      Array.from({ length: 250 }, (_, i) => `S${i}`).join(';'),
      opts({ onProgress: (d, t) => void progress.push([d, t]) })
    )
    expect(progress).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ])
  })
})
