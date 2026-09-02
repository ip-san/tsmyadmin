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
  it('never lets an object name break out of a comment line', async () => {
    const evil = 'x\nDROP TABLE users; -- y'
    const a = new FakeAdapter({ databases: { shop: { tables: { [evil]: fakeTable(evil, ['id'], [{ id: 1 }]) } } } })
    const f = buildExport(a, ns, [evil], q({ format: 'sql', data: '0' }))
    let body = ''
    for await (const c of f.body) body += c
    // The comment stays one line (the next line is the section rule); the DROP names the table inside its
    // quoted identifier, where a line break is just part of the name.
    const lines = body.split('\n')
    const at = lines.indexOf('-- Table: x DROP TABLE users; -- y')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toMatch(/^-- -+$/)
    expect(body).toContain('DROP TABLE IF EXISTS `x\nDROP TABLE users; -- y`;')
  })

  it('sql: structure + batched inserts with a header', async () => {
    const f = buildExport(adapter(), ns, ['users', 'empty'], q({ format: 'sql' }))
    const body = await collect(f.body)
    expect(f.filename).toBe('shop.sql')
    expect(body).toContain('-- tsmyadmin SQL dump')
    expect(body).toContain('-- fake CREATE TABLE users (id, name);')
    expect(body).toContain(
      "INSERT INTO `users` (`id`, `name`) VALUES\n(1, 'A,\"quoted\"'),\n(2, NULL),\n(3, 'line\nbreak');"
    )
    expect(body).toContain('-- Table: empty')
    expect(body).not.toContain('INSERT INTO `empty`')
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

/** A fake view: the definition text is what the mention fallback reads. */
const fakeView = (name: string, definition: string) => ({
  ...fakeTable(name, ['id'], []),
  schema: { ...fakeTable(name, ['id'], []).schema, kind: 'view' as const },
  definition,
})

describe('buildExport ordering of views and routines', () => {
  const order = (body: string, ...markers: string[]) => markers.map((m) => body.indexOf(m))
  const isAscending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > (xs[i - 1] ?? 0)))

  it('follows the catalog when the server has one (an alias equal to a view name is not a dependency)', async () => {
    const a = new FakeAdapter({
      databases: {
        shop: {
          tables: {
            t: fakeTable('t', ['id'], []),
            // va sorts first and its alias is called vb; vb really reads va.
            va: fakeView('va', 'CREATE VIEW va AS SELECT id AS vb FROM t'),
            vb: fakeView('vb', 'CREATE VIEW vb AS SELECT vb FROM va'),
          },
        },
      },
      dependencies: [
        { kind: 'view', name: 'va', dependsOn: [{ kind: 'table', name: 't' }] },
        { kind: 'view', name: 'vb', dependsOn: [{ kind: 'view', name: 'va' }] },
      ],
    })
    const body = await collect(buildExport(a, ns, ['t', 'va', 'vb'], q({ format: 'sql', data: '0' })).body)
    expect(isAscending(order(body, '-- View: va', '-- View: vb'))).toBe(true)
  })

  it('falls back to definition mentions without a catalog, and never emits a view twice', async () => {
    const a = new FakeAdapter({
      databases: {
        shop: {
          tables: {
            t: fakeTable('t', ['id'], []),
            a: fakeView('a', 'CREATE VIEW a AS SELECT id FROM c'),
            b: fakeView('b', 'CREATE VIEW b AS SELECT id FROM t'),
            c: fakeView('c', 'CREATE VIEW c AS SELECT id FROM b'),
            // `bc` contains `b` and `c` only as substrings: no dependency.
            bc: fakeView('bc', 'CREATE VIEW bc AS SELECT id FROM t'),
          },
        },
      },
      dependencies: null,
    })
    const body = await collect(buildExport(a, ns, ['t', 'a', 'b', 'bc', 'c'], q({ format: 'sql', data: '0' })).body)
    expect(isAscending(order(body, '-- View: b\n', '-- View: c\n', '-- View: a\n'))).toBe(true)
    expect(body.match(/-- View: /g)).toHaveLength(4)
  })

  it('reads a DROP signature from pg_get_functiondef headers (defaults stripped, nested types kept)', async () => {
    const a = new FakeAdapter({
      dialect: 'postgres',
      databases: { shop: { tables: { t: fakeTable('t', ['id'], []), v: fakeView('v', 'CREATE VIEW v AS SELECT 1') } } },
      routines: {
        h: "CREATE OR REPLACE FUNCTION public.h(a numeric(10,2), b text DEFAULT 'x, y'::text, VARIADIC c integer[])\n RETURNS integer\n LANGUAGE sql\nRETURN (SELECT count(*) FROM v)",
      },
      dependencies: [{ kind: 'routine', name: 'h', dependsOn: [{ kind: 'view', name: 'v' }] }],
    })
    const body = await collect(buildExport(a, ns, ['t', 'v'], q({ format: 'sql', data: '0', routines: '1' })).body)
    expect(body).toContain('DROP FUNCTION IF EXISTS public.h(a numeric(10,2), b text, VARIADIC c integer[]);')
  })

  it('PostgreSQL: SQL-standard routines are ordered with the views; a name-level cycle puts the view first', async () => {
    const a = new FakeAdapter({
      dialect: 'postgres',
      databases: {
        shop: {
          tables: {
            t: fakeTable('t', ['id'], []),
            v: fakeView('v', 'CREATE VIEW v AS SELECT f(id) FROM t'),
            w: fakeView('w', 'CREATE VIEW w AS SELECT g() AS one'),
          },
        },
      },
      routines: {
        // f: a string-body overload (used by v) and a SQL-standard overload reading v.
        f: 'CREATE OR REPLACE FUNCTION f(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$;\n\nCREATE OR REPLACE FUNCTION f(x text) RETURNS bigint LANGUAGE sql RETURN (SELECT count(*) FROM v)',
        // g: a SQL-standard body read by w.
        g: 'CREATE OR REPLACE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END',
      },
      dependencies: [
        {
          kind: 'view',
          name: 'v',
          dependsOn: [
            { kind: 'table', name: 't' },
            { kind: 'routine', name: 'f' },
          ],
        },
        { kind: 'view', name: 'w', dependsOn: [{ kind: 'routine', name: 'g' }] },
        { kind: 'routine', name: 'f', dependsOn: [{ kind: 'view', name: 'v' }] },
      ],
    })
    const body = await collect(buildExport(a, ns, ['t', 'v', 'w'], q({ format: 'sql', data: '0', routines: '1' })).body)
    // String bodies precede the tables; g precedes w; v precedes f's SQL-standard overload.
    expect(isAscending(order(body, '-- Routines', 'f(x int)', '-- Table: t', '-- Routine: g', '-- View: w'))).toBe(true)
    expect(isAscending(order(body, '-- View: v', '-- Routine: f', 'CREATE OR REPLACE FUNCTION f(x text)'))).toBe(true)
    // The drop section comes first: dependents before dependencies, routines with their identity signature.
    expect(body).toContain(
      'DROP FUNCTION IF EXISTS f(x text);\nDROP VIEW IF EXISTS "public"."w";\nDROP FUNCTION IF EXISTS g();\nDROP VIEW IF EXISTS "public"."v";\nDROP TABLE IF EXISTS "public"."t";'
    )
    expect(body.indexOf('-- Drop')).toBeLessThan(body.indexOf('-- Routines'))
  })
})

describe('contentDisposition', () => {
  it('provides an ASCII fallback and a UTF-8 encoded name', () => {
    expect(contentDisposition('売上_users.sql')).toBe(
      `attachment; filename="___users.sql"; filename*=UTF-8''${encodeURIComponent('売上_users.sql')}`
    )
  })

  it('encodes RFC 8187 reserved characters and strips quote/backslash from the ASCII fallback', () => {
    expect(contentDisposition(`it's "a" (x)*!\\.sql`)).toBe(
      `attachment; filename="it's a (x)*!.sql"; filename*=UTF-8''it%27s%20%22a%22%20%28x%29%2A%21%5C.sql`
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
