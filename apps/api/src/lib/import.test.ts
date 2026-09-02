import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ImportFormSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { importCsv, importSql } from './import.ts'

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
      args: [ns, 'blobs', ['name'], [['\\N'], [''], [null], ['x']]],
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
      ],
    })
    await expect(importCsv(a, ns, form({ table: 'blobs' }), 'name,data\nx,not base64!\n')).rejects.toThrow(/base64/)
    // A wrong file is reported without echoing its whole first line.
    const long = `${'a'.repeat(500)}\n`
    await expect(importCsv(adapter(), ns, form({}), long)).rejects.toThrow(/^Unknown column\(s\) in header: a{64}…$/)
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
    await expect(importCsv(adapter(), ns, form({}), 'id\n1,2\n')).rejects.toThrow(/Line 2 has 2 fields/)
    await expect(importCsv(adapter(), ns, form({}), '')).rejects.toThrow(/empty/)
    await expect(
      importCsv(adapter(), ns, ImportFormSchema.parse({ file: new File([''], 'x.csv'), format: 'csv' }), 'id\n1\n')
    ).rejects.toThrow(/target table/)
  })
})

describe('importSql', () => {
  it('summarises statement results and caps the error list', async () => {
    const a = new FakeAdapter({
      onSql: (_ns, sql) =>
        sql
          .split(';')
          .map((s, i) =>
            i % 2
              ? { kind: 'error' as const, sql: s, message: 'boom', code: 'QUERY_FAILED' }
              : { kind: 'affected' as const, sql: s, affectedRows: 1, durationMs: 1 }
          ),
    })
    const r = await importSql(a, ns, Array.from({ length: 60 }, (_, i) => `S${i}`).join(';'), false)
    expect(r).toMatchObject({ format: 'sql', statements: 60, succeeded: 30, failed: 30 })
    if (r.format === 'sql') expect(r.errors).toHaveLength(20)
    expect(a.calls.at(-1)?.args[2]).toMatchObject({ stopOnError: false, maxRows: 1 })
  })
})
