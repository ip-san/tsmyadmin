import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ExportQuerySchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { buildExport, collect, contentDisposition, DUMP_COMPLETE_MARKER } from './export.ts'

const adapter = () =>
  new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'A,"quoted"' },
              { id: 2, name: null },
              { id: 3, name: 'line\nbreak' },
            ]
          ),
          empty: fakeTable('empty', ['id'], []),
        },
      },
    },
  })
const ns = { database: 'shop' }
const q = (over: Record<string, string>) => ExportQuerySchema.parse(over)

describe('buildExport', () => {
  it('sql: structure + batched inserts with a header', async () => {
    const f = buildExport(adapter(), ns, ['users', 'empty'], q({ format: 'sql' }))
    const body = await collect(f.body)
    expect(f.filename).toBe('shop.sql')
    expect(body).toContain('-- tsmyadmin SQL dump')
    expect(body).toContain('-- fake CREATE TABLE users (id, name);')
    expect(body).toContain(
      "INSERT INTO `shop`.`users` (`id`, `name`) VALUES\n(1, 'A,\"quoted\"'),\n(2, NULL),\n(3, 'line\nbreak');"
    )
    expect(body).toContain('-- Table: empty')
    expect(body).not.toContain('INSERT INTO `shop`.`empty`')
    expect(body.trimEnd().endsWith(`${DUMP_COMPLETE_MARKER} (2 tables)`)).toBe(true)
  })

  it('sql: structure-only and data-only respect the flags', async () => {
    const s = buildExport(adapter(), ns, ['users'], q({ structure: '1', data: '0' }))
    const sBody = await collect(s.body)
    expect(sBody).toContain('fake CREATE TABLE')
    expect(sBody).not.toContain('INSERT INTO')
    const d = buildExport(adapter(), ns, ['users'], q({ structure: '0', data: '1' }), 'shop_users')
    const dBody = await collect(d.body)
    expect(dBody).not.toContain('fake CREATE TABLE')
    expect(dBody).toContain('INSERT INTO')
    expect(d.filename).toBe('shop_users.sql')
  })

  it('csv: RFC 4180 quoting, \\N for NULL, BOM by default', async () => {
    const f = buildExport(adapter(), ns, ['users'], q({ format: 'csv' }), 'shop_users')
    const body = await collect(f.body)
    expect(f.filename).toBe('shop_users.csv')
    expect(body.startsWith('﻿')).toBe(true)
    expect(body.slice(1)).toBe('id,name\r\n1,"A,""quoted"""\r\n2,\\N\r\n3,"line\nbreak"\r\n')
    const noBom = buildExport(adapter(), ns, ['empty'], q({ format: 'csv', bom: '0' }))
    const noBomBody = await collect(noBom.body)
    expect(noBomBody).toBe('id\r\n')
  })

  it('json: one array per table with native cells', async () => {
    const f = buildExport(adapter(), ns, ['users'], q({ format: 'json' }))
    const body = await collect(f.body)
    expect(JSON.parse(body)).toEqual({
      users: [
        { id: 1, name: 'A,"quoted"' },
        { id: 2, name: null },
        { id: 3, name: 'line\nbreak' },
      ],
    })
  })
})

describe('contentDisposition', () => {
  it('provides an ASCII fallback and a UTF-8 encoded name', () => {
    expect(contentDisposition('売上_users.sql')).toBe(
      `attachment; filename="___users.sql"; filename*=UTF-8''${encodeURIComponent('売上_users.sql')}`
    )
  })
})

describe('buildExport failure mid-stream', () => {
  it('propagates the error and never emits the completion marker', async () => {
    const a = adapter()
    let batches = 0
    const original = a.iterateRows.bind(a)
    a.iterateRows = async function* (ns, table, opts) {
      for await (const b of original(ns, table, opts)) {
        if (++batches === 2) throw new Error('connection lost')
        yield b
      }
    }
    const f = buildExport(a, ns, ['users', 'empty'], q({ format: 'sql' }))
    let partial = ''
    await expect(
      (async () => {
        for await (const chunk of f.body) partial += chunk
      })()
    ).rejects.toThrow('connection lost')
    expect(partial).toContain('-- Table: users')
    expect(partial).not.toContain(DUMP_COMPLETE_MARKER)
  })
})
