import { gunzipSync } from 'node:zlib'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ExportQuerySchema, ServerExportQuerySchema } from '@tsmyadmin/shared'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import {
  buildPackagedExport,
  buildServerExport,
  encodeText,
  keylessTables,
  renderFileName,
  safeFileName,
  withRowRange,
} from './export-package.ts'
import { readZip } from './zip.ts'

/** The last stage of an export: names, character sets, row ranges, and the wrapping in gzip or ZIP. */

const ns = { database: 'shop' }
const NOW = new Date(2005, 8, 7, 6, 5, 4)
const q = (over: Record<string, string>) => ExportQuerySchema.parse(over)
const sq = (over: Record<string, string>) => ServerExportQuerySchema.parse({ targets: 'shop', ...over })
const bytes = async (parts: AsyncIterable<Uint8Array>) => Buffer.concat(await Array.fromAsync(parts))
const names = async (body: AsyncIterable<Uint8Array>) => readZip(new Uint8Array(await bytes(body))).map((f) => f.name)
const adapter = () =>
  new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'あ' },
              { id: 2, name: 'い' },
            ]
          ),
          posts: fakeTable('posts', ['id'], [{ id: 1 }]),
        },
      },
      other: { tables: { notes: fakeTable('notes', ['id'], [{ id: 7 }]) } },
    },
  })
const base = { server: 's', baseName: 'shop', everything: false, now: NOW }

describe('safeFileName', () => {
  it('replaces every character no file system takes, and control characters', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(safeFileName('x\u0000y\u0001z\u001fw')).toBe('x_y_z_w')
    expect(safeFileName('a b.c')).toBe('a b.c')
  })

  it('replaces leading dots by one underscore, trims, and cuts at 150 characters', () => {
    expect(safeFileName('..a.b')).toBe('_a.b')
    expect(safeFileName('.')).toBe('_')
    expect(safeFileName('  x  ')).toBe('x')
    expect(safeFileName('a'.repeat(150))).toBe('a'.repeat(150))
    expect(safeFileName('a'.repeat(151))).toBe('a'.repeat(150))
  })
})

describe('renderFileName', () => {
  const parts = { database: 'shop', table: 'users', server: 'srv', now: NOW }

  it('falls back when there is no template or it is blank', () => {
    expect(renderFileName(undefined, parts, 'fb')).toBe('fb')
    expect(renderFileName('', parts, 'fb')).toBe('fb')
    expect(renderFileName(' \t', parts, 'fb')).toBe('fb')
  })

  it('fills the placeholders, all of their occurrences', () => {
    expect(renderFileName('@DATABASE@-@DB@-@TABLE@-@SERVER@-@TABLE@', parts, 'fb')).toBe('shop-shop-users-srv-users')
  })

  it('uses the database for @TABLE@ when no table is named, but not for an empty table name', () => {
    expect(renderFileName('@TABLE@', { ...parts, table: undefined }, 'fb')).toBe('shop')
    expect(renderFileName('@TABLE@', { ...parts, table: '' }, 'fb')).toBe('fb')
  })

  it('fills each date part with its width: year 4 or 2 digits, month from 1, zero-padded', () => {
    expect(renderFileName('%Y|%y|%m|%d|%H|%M|%S', parts, 'fb')).toBe('2005_05_09_07_06_05_04')
    expect(renderFileName('%m%d', { ...parts, now: new Date(2012, 11, 31, 23, 59, 58) }, 'fb')).toBe('1231')
    expect(renderFileName('%Y', { ...parts, now: new Date(2000, 0, 1) }, 'fb')).toBe('2000')
  })

  it('writes %% as one percent sign and leaves other sequences as typed', () => {
    expect(renderFileName('a%%b%Zc%', parts, 'fb')).toBe('a%b%Zc%')
  })

  it('cleans the result like any file name', () => {
    expect(renderFileName('  @DATABASE@/x  ', { ...parts, database: 'a:b' }, 'fb')).toBe('a_b_x')
  })
})

describe('encodeText', () => {
  const encode = async (chunks: (string | Uint8Array)[], charset: Parameters<typeof encodeText>[1]) =>
    Buffer.concat(
      await Array.fromAsync(
        encodeText(
          (async function* () {
            yield* chunks
          })(),
          charset
        )
      )
    )

  it('passes bytes through untouched, whatever the set', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0x80])
    expect([...(await encode([raw], 'cp932'))]).toEqual([0xff, 0x00, 0x80])
    expect([...(await encode([raw], 'utf-8'))]).toEqual([0xff, 0x00, 0x80])
  })

  it('keeps a byte-order mark in UTF-8 and drops it from the start of any other set', async () => {
    expect([...(await encode(['﻿a'], 'utf-8'))]).toEqual([0xef, 0xbb, 0xbf, 0x61])
    expect([...(await encode(['﻿a', 'b'], 'cp932'))]).toEqual([0x61, 0x62])
    expect([...(await encode(['a', '﻿b'].slice(0, 1), 'cp932'))]).toEqual([0x61])
  })

  it('refuses a mark that is not at the start, since the set cannot hold it', async () => {
    await expect(encode(['a', '﻿b'], 'iso-8859-1')).rejects.toThrow(/cannot hold/)
  })

  it('names the set in the error', async () => {
    await expect(encode(['日本'], 'iso-8859-1')).rejects.toThrow(
      'The text has characters that iso-8859-1 cannot hold: export it as UTF-8'
    )
  })

  it('encodes each text chunk in the set', async () => {
    expect(iconv.decode(await encode(['日', '本'], 'cp932'), 'cp932')).toBe('日本')
    expect((await encode(['日', '本'], 'cp932')).length).toBe(4)
  })
})

describe('withRowRange', () => {
  /** An adapter that serves batches of the given sizes (row values count up from 1) and counts the batches pulled. */
  function batched(sizes: number[]) {
    const pulled = { n: 0 }
    const a = Object.assign(adapter(), {
      async *iterateRows() {
        let v = 1
        for (const size of sizes) {
          pulled.n++
          yield { columns: [{ name: 'id', dataType: 'int' }], rows: Array.from({ length: size }, () => [v++]) }
        }
      },
    }) as unknown as DatabaseAdapter
    return { a, pulled }
  }
  const batchesOf = async (a: DatabaseAdapter, offset: number, limit: number) => {
    const out: unknown[][][] = []
    for await (const b of withRowRange(a, offset, limit).iterateRows(ns, 'users', { batchSize: 3 })) out.push(b.rows)
    return out
  }

  it('passes every batch on, an emptied one too, so the first still tells the column names', async () => {
    expect(await batchesOf(batched([3, 3]).a, 3, 0)).toEqual([[], [[4], [5], [6]]])
    const { a } = batched([2])
    const got = await Array.fromAsync(withRowRange(a, 5, 0).iterateRows(ns, 'users', { batchSize: 3 }))
    expect(got).toEqual([{ columns: [{ name: 'id', dataType: 'int' }], rows: [] }])
  })

  it('skips across batches', async () => {
    expect(await batchesOf(batched([2, 2, 2]).a, 3, 0)).toEqual([[], [[4]], [[5], [6]]])
    expect(await batchesOf(batched([2, 2, 2]).a, 2, 0)).toEqual([[], [[3], [4]], [[5], [6]]])
  })

  it('limits across batches and stops reading once it has enough', async () => {
    const one = batched([2, 2, 2])
    expect(await batchesOf(one.a, 0, 3)).toEqual([[[1], [2]], [[3]]])
    expect(one.pulled.n).toBe(2)
    const exact = batched([2, 2, 2])
    expect(await batchesOf(exact.a, 0, 2)).toEqual([[[1], [2]]])
    expect(exact.pulled.n).toBe(1)
  })

  it('applies the offset first and then the limit', async () => {
    expect(await batchesOf(batched([2, 2, 2]).a, 1, 3)).toEqual([[[2]], [[3], [4]]])
  })

  it('takes a limit of 0 as no limit', async () => {
    expect(await batchesOf(batched([2, 2]).a, 0, 0)).toEqual([
      [[1], [2]],
      [[3], [4]],
    ])
  })

  it('leaves everything else of the adapter as it was, bound to it', async () => {
    const a = adapter()
    const ranged = withRowRange(a, 1, 1)
    expect(ranged.dialect).toBe('mysql')
    expect((await ranged.listTables(ns)).map((t) => t.name)).toEqual(['users', 'posts'])
  })
})

describe('keylessTables', () => {
  const keyless = () =>
    new FakeAdapter({
      databases: {
        shop: {
          tables: {
            a: fakeTable('a', ['id'], [], ['id']),
            b: fakeTable('b', ['x'], [], []),
            v: { ...fakeTable('v', ['x'], [], []), schema: { ...fakeTable('v', ['x'], [], []).schema, kind: 'view' } },
            s: {
              ...fakeTable('s', ['x'], [], []),
              schema: { ...fakeTable('s', ['x'], [], []).schema, kind: 'sequence' },
            },
          },
        },
      },
    })
  const run = async (a: FakeAdapter, over: Partial<{ data: string; statement: string; viewsAsTables: string }>) =>
    keylessTables(a, ns, await a.listTables(ns), ['a', 'b', 'v', 's'], {
      data: '1',
      statement: 'update',
      viewsAsTables: '0',
      ...over,
    })

  it('finds the tables without a primary key when rows are found by it', async () => {
    expect(await run(keyless(), { statement: 'update' })).toEqual(['b'])
    expect(await run(keyless(), { statement: 'replace' })).toEqual(['b'])
  })

  it('asks nothing for INSERT, or when no data is written', async () => {
    const a = keyless()
    expect(await run(a, { statement: 'insert' })).toEqual([])
    expect(await run(a, { data: '0' })).toEqual([])
    expect(a.calls.some((c) => c.method === 'describeTable')).toBe(false)
  })

  it('skips a table the listing does not name, whatever the view setting', async () => {
    const a = keyless()
    const none = await keylessTables(a, ns, [], ['b'], { data: '1', statement: 'update', viewsAsTables: '0' })
    expect(none).toEqual([])
    const unlisted = await keylessTables(a, ns, [], ['b'], { data: '1', statement: 'update', viewsAsTables: '1' })
    expect(unlisted).toEqual(['b'])
  })

  it('counts views only when they are written as tables, and never a sequence', async () => {
    expect(await run(keyless(), { viewsAsTables: '1' })).toEqual(['b', 'v'])
    const a = keyless()
    await run(a, {})
    expect(a.calls.filter((c) => c.method === 'describeTable').map((c) => c.args[1])).toEqual(['a', 'b'])
  })
})

describe('buildPackagedExport', () => {
  it('names the file by the template, or by the base name without one', () => {
    expect(buildPackagedExport(adapter(), ns, ['users'], q({ format: 'csv', filename: 'x' }), base).filename).toBe(
      'x.csv'
    )
    expect(buildPackagedExport(adapter(), ns, ['users'], q({ format: 'csv' }), base).filename).toBe('shop.csv')
  })

  it('fills @TABLE@ with the table only when one table is exported on its own', () => {
    const f = (tables: string[], everything: boolean) =>
      buildPackagedExport(adapter(), ns, tables, q({ format: 'json', filename: '@TABLE@' }), { ...base, everything })
        .filename
    expect(f(['users'], false)).toBe('users.json')
    expect(f(['users'], true)).toBe('shop.json')
    expect(f(['users', 'posts'], false)).toBe('shop.json')
  })

  it('names the zip and the gzip after the same template', async () => {
    const opts = { ...base, everything: false }
    const zip = buildPackagedExport(
      adapter(),
      ns,
      ['users'],
      q({ format: 'csv', filename: '@TABLE@', compress: 'zip' }),
      opts
    )
    expect(zip.filename).toBe('users.zip')
    expect(zip.contentType).toBe('application/zip')
    expect(await names(zip.body)).toEqual(['users.csv'])
    const gz = buildPackagedExport(
      adapter(),
      ns,
      ['users'],
      q({ format: 'csv', filename: '@TABLE@', compress: 'gzip' }),
      opts
    )
    expect(gz.filename).toBe('users.csv.gz')
    expect(gz.contentType).toBe('application/gzip')
    expect(gunzipSync(await bytes(gz.body)).toString('utf8')).toContain('あ')
  })

  it('encodes what goes into a gzip or zip in the chosen set too', async () => {
    const gz = buildPackagedExport(
      adapter(),
      ns,
      ['users'],
      q({ format: 'csv', charset: 'cp932', compress: 'gzip' }),
      base
    )
    expect(iconv.decode(gunzipSync(await bytes(gz.body)), 'cp932')).toContain('あ')
    const zip = buildPackagedExport(
      adapter(),
      ns,
      ['users'],
      q({ format: 'csv', charset: 'cp932', compress: 'zip' }),
      base
    )
    const [file] = readZip(new Uint8Array(await bytes(zip.body)))
    expect(iconv.decode(Buffer.from(file?.bytes() ?? []), 'cp932')).toContain('あ')
  })

  it('declares the chosen set in the content type of a text format, and UTF-8 for the formats that name their own', () => {
    const type = (format: string) =>
      buildPackagedExport(adapter(), ns, ['users'], q({ format, charset: 'cp932' }), base).contentType
    expect(type('csv')).toContain('charset=cp932')
    expect(type('sql')).toContain('charset=cp932')
    for (const f of ['json', 'xml', 'yaml', 'html']) {
      expect(type(f)).toContain('charset=utf-8')
      expect(type(f)).not.toContain('cp932')
    }
  })

  it('writes the formats that name their own set as UTF-8 bytes', async () => {
    for (const format of ['xml', 'yaml', 'html']) {
      const file = buildPackagedExport(adapter(), ns, ['users'], q({ format, charset: 'cp932' }), base)
      expect(Buffer.from(await bytes(file.body)).toString('utf8')).toContain('あ')
    }
  })

  it('gives the content type of a binary format as it is, ignoring the character set', async () => {
    for (const format of ['ods', 'odt', 'docx']) {
      const file = buildPackagedExport(adapter(), ns, ['users'], q({ format, charset: 'cp932' }), base)
      expect(file.contentType).not.toContain('charset')
      expect(readZip(new Uint8Array(await bytes(file.body))).length).toBeGreaterThan(0)
    }
  })

  it('dates the file name by the time it is made when no time is given', () => {
    const f = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'csv', filename: '%Y' }), {
      server: 's',
      baseName: 'shop',
      everything: false,
    })
    expect(f.filename).toBe(`${new Date().getFullYear()}.csv`)
  })

  it('limits the rows by the offset alone, or the limit alone', async () => {
    const ids = async (over: Record<string, string>) => {
      const f = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'json', ...over }), base)
      return JSON.parse(Buffer.from(await bytes(f.body)).toString('utf8')).users.map((r: { id: number }) => r.id)
    }
    expect(await ids({ rowOffset: '1' })).toEqual([2])
    expect(await ids({ rowLimit: '1' })).toEqual([1])
    expect(await ids({})).toEqual([1, 2])
  })

  describe('one file per table', () => {
    const make = (filename: string | undefined, tables = ['users', 'posts']) =>
      buildPackagedExport(
        adapter(),
        ns,
        tables,
        q({ format: 'csv', filePerTable: '1', ...(filename === undefined ? {} : { filename }) }),
        { ...base, everything: true }
      )

    it('names the files by @TABLE@ when the template has it, with the format extension', async () => {
      const f = make('t-@TABLE@')
      expect(f.filename).toBe('t-shop.zip')
      expect(f.contentType).toBe('application/zip')
      expect(await names(f.body)).toEqual(['t-users.csv', 't-posts.csv'])
    })

    it('adds the table name to a template without @TABLE@, or to the base name without any template', async () => {
      expect(await names(make('out').body)).toEqual(['out_users.csv', 'out_posts.csv'])
      expect(await names(make(undefined).body)).toEqual(['shop_users.csv', 'shop_posts.csv'])
      expect(make(undefined).filename).toBe('shop.zip')
    })

    it('cleans the table name added to the file name', async () => {
      const a = new FakeAdapter({ databases: { shop: { tables: { 'a/b': fakeTable('a/b', ['id'], []) } } } })
      const f = buildPackagedExport(a, ns, ['a/b'], q({ format: 'csv', filePerTable: '1', filename: 'out' }), base)
      expect(await names(f.body)).toEqual(['out_a_b.csv'])
    })

    it('numbers the files whose names repeat, ignoring the case', async () => {
      const a = new FakeAdapter({
        databases: {
          shop: {
            tables: { a: fakeTable('a', ['id'], []), A: fakeTable('A', ['id'], []), b: fakeTable('b', ['id'], []) },
          },
        },
      })
      const f = buildPackagedExport(
        a,
        ns,
        ['a', 'A', 'a'],
        q({ format: 'csv', filePerTable: '1', filename: '@TABLE@' }),
        base
      )
      expect(await names(f.body)).toEqual(['a.csv', 'A_2.csv', 'a_3.csv'])
    })

    it('puts the triggers of a table in its own file only, and the routines of the database in none', async () => {
      class WithTriggers extends FakeAdapter {
        override async listTriggers() {
          const t = { timing: 'BEFORE', events: 'INSERT', orientation: 'ROW' }
          return [
            {
              name: 'tr_users',
              table: 'users',
              definition: 'CREATE TRIGGER tr_users BEFORE INSERT ON users FOR EACH ROW SET @a=1',
              ...t,
            },
            {
              name: 'tr_posts',
              table: 'posts',
              definition: 'CREATE TRIGGER tr_posts BEFORE INSERT ON posts FOR EACH ROW SET @a=2',
              ...t,
            },
          ] as never
        }
      }
      const a = new WithTriggers({
        databases: {
          shop: { tables: { users: fakeTable('users', ['id'], []), posts: fakeTable('posts', ['id'], []) } },
        },
        routines: { calc: 'CREATE FUNCTION calc() RETURNS INT RETURN 1' },
      })
      const f = buildPackagedExport(
        a,
        ns,
        ['users', 'posts'],
        q({ format: 'sql', filePerTable: '1', filename: '@TABLE@', routines: '1' }),
        { ...base, everything: true }
      )
      const [users, posts] = readZip(new Uint8Array(await bytes(f.body))).map((x) =>
        new TextDecoder().decode(x.bytes())
      )
      expect(users).toContain('tr_users')
      expect(users).not.toContain('tr_posts')
      expect(posts).toContain('tr_posts')
      expect(posts).not.toContain('tr_users')
      expect(users).not.toContain('calc')
      expect(posts).not.toContain('calc')
    })

    it('puts each table in a file of its own, with the extension of the format', async () => {
      const f = buildPackagedExport(
        adapter(),
        ns,
        ['users', 'posts'],
        q({ format: 'json', filePerTable: '1', filename: '@TABLE@' }),
        base
      )
      const files = readZip(new Uint8Array(await bytes(f.body)))
      expect(files.map((x) => x.name)).toEqual(['users.json', 'posts.json'])
      expect(Object.keys(JSON.parse(new TextDecoder().decode(files[0]?.bytes())))).toEqual(['users'])
    })
  })
})

describe('buildServerExport', () => {
  const targets = [{ database: 'shop' }, { database: 'other' }]
  const opts = { server: 'srv', now: NOW }
  const text = async (parts: AsyncIterable<Uint8Array>) => (await bytes(parts)).toString('utf8')

  it('writes the databases as one SQL dump, one after another, each with its own CREATE DATABASE', async () => {
    const f = buildServerExport(adapter(), targets, sq({}), opts)
    expect(f.filename).toBe('server.sql')
    expect(f.contentType).toBe('application/sql; charset=utf-8')
    const sql = await text(f.body)
    const create = [...sql.matchAll(/CREATE DATABASE[^\n]*/g)].map((m) => m[0])
    expect(create).toHaveLength(2)
    expect(create[0]).toContain('shop')
    expect(create[1]).toContain('other')
    expect(sql.indexOf('users')).toBeLessThan(sql.indexOf('notes'))
    expect(sql).toContain('\n\n')
  })

  it('does not put a separator before the first database', async () => {
    // The dump carries the time it was made at: left out, one database written twice is the dump, a newline, the dump.
    const dump = async (list: { database: string }[]) =>
      (await text(buildServerExport(adapter(), list, sq({}), opts).body)).replace(/-- Generated: .*\n/g, '')
    const one = await dump([{ database: 'other' }])
    expect(await dump([{ database: 'other' }, { database: 'other' }])).toBe(`${one}\n${one}`)
  })

  it('names the file by the template with the date and server, and declares the chosen set', async () => {
    const f = buildServerExport(adapter(), targets, sq({ filename: '@SERVER@_%Y', charset: 'cp932' }), opts)
    expect(f.filename).toBe('srv_2005.sql')
    expect(f.contentType).toBe('application/sql; charset=cp932')
  })

  it('compresses into a gzip or a zip, named after the template', async () => {
    const gz = buildServerExport(adapter(), targets, sq({ compress: 'gzip', filename: 'dump' }), opts)
    expect(gz.filename).toBe('dump.sql.gz')
    expect(gz.contentType).toBe('application/gzip')
    expect(gunzipSync(await bytes(gz.body)).toString('utf8')).toContain('notes')
    const zip = buildServerExport(adapter(), targets, sq({ compress: 'zip', filename: 'dump' }), opts)
    expect(zip.filename).toBe('dump.zip')
    expect(zip.contentType).toBe('application/zip')
    expect(await names(zip.body)).toEqual(['dump.sql'])
  })

  it('encodes the dump in the chosen set', async () => {
    const a = new FakeAdapter({
      databases: { shop: { tables: { t: fakeTable('t', ['id', 'v'], [{ id: 1, v: 'あ' }]) } } },
    })
    const f = buildServerExport(a, [{ database: 'shop' }], sq({ charset: 'cp932' }), opts)
    expect(iconv.decode(await bytes(f.body), 'cp932')).toContain('あ')
  })

  it('writes each database whole: its routines too', async () => {
    const a = new FakeAdapter({
      databases: { shop: { tables: { t: fakeTable('t', ['id'], []) } } },
      routines: { calc: 'CREATE FUNCTION calc() RETURNS INT RETURN 1' },
    })
    const sql = await text(buildServerExport(a, [{ database: 'shop' }], sq({}), opts).body)
    expect(sql).toContain('calc')
  })

  it('writes the rows asked for in each table: skipping some, or taking some', async () => {
    const a = new FakeAdapter({
      databases: {
        shop: { tables: { t: fakeTable('t', ['id'], [{ id: 11 }, { id: 22 }, { id: 33 }]) } },
      },
    })
    const dump = async (over: Record<string, string>) =>
      text(buildServerExport(a, [{ database: 'shop' }], sq(over), opts).body)
    const inserted = (sql: string) => ['11', '22', '33'].filter((v) => sql.includes(v))
    expect(inserted(await dump({}))).toEqual(['11', '22', '33'])
    expect(inserted(await dump({ rowOffset: '1' }))).toEqual(['22', '33'])
    expect(inserted(await dump({ rowLimit: '2' }))).toEqual(['11', '22'])
    expect(inserted(await dump({ rowOffset: '1', rowLimit: '1' }))).toEqual(['22'])
  })

  it('dates the file name by the time it is made when no time is given', () => {
    const f = buildServerExport(adapter(), targets, sq({ filename: '%Y' }), { server: 's' })
    expect(f.filename).toBe(`${new Date().getFullYear()}.sql`)
  })

  it('puts tables before views in each dump', async () => {
    const view = (() => {
      const t = fakeTable('v', ['id'], [])
      return { ...t, schema: { ...t.schema, kind: 'view' as const }, definition: 'CREATE VIEW v AS SELECT 1' }
    })()
    const a = new FakeAdapter({
      databases: { shop: { tables: { v: view, z: fakeTable('z', ['id'], [{ id: 1 }]) } } },
    })
    const sql = await text(buildServerExport(a, [{ database: 'shop' }], sq({}), opts).body)
    expect(sql.indexOf('INSERT INTO')).toBeGreaterThan(-1)
    expect(sql.indexOf('CREATE VIEW v')).toBeGreaterThan(sql.indexOf('INSERT INTO'))
  })

  describe('one file per database', () => {
    const make = (over: Record<string, string>, list = targets) =>
      buildServerExport(adapter(), list, sq({ filePerTable: '1', ...over }), opts)

    it('makes a zip with one .sql per database, named by @DATABASE@ or @DB@ when the template has it', async () => {
      const f = make({ filename: 'x-@DATABASE@' })
      expect(f.contentType).toBe('application/zip')
      expect(f.filename).toBe('x-server.zip')
      expect(await names(f.body)).toEqual(['x-shop.sql', 'x-other.sql'])
      expect(await names(make({ filename: '@DB@' }).body)).toEqual(['shop.sql', 'other.sql'])
    })

    it('adds the database to a name that does not hold it, or to the default name', async () => {
      expect(await names(make({ filename: 'out' }).body)).toEqual(['out_shop.sql', 'out_other.sql'])
      expect((await names(make({}).body)).every((n, i) => n.includes(['shop', 'other'][i] as string))).toBe(true)
      expect(make({}).filename).toBe('server.zip')
    })

    it('names a schema by the schema, and numbers repeated names', async () => {
      const a = new FakeAdapter({ dialect: 'postgres', databases: { shop: { schemas: ['public'], tables: {} } } })
      const f = buildServerExport(
        a,
        [
          { database: 'shop', schema: 'public' },
          { database: 'shop', schema: 'Public' },
        ],
        sq({ filePerTable: '1', filename: '@DB@' }),
        opts
      )
      expect(await names(f.body)).toEqual(['public.sql', 'Public_2.sql'])
    })

    it('writes each database whole, in its own file', async () => {
      const f = make({ filename: '@DB@' })
      const files = readZip(new Uint8Array(await bytes(f.body)))
      const dump = (i: number) => new TextDecoder().decode(files[i]?.bytes())
      expect(dump(0)).toContain('users')
      expect(dump(0)).not.toContain('notes')
      expect(dump(1)).toContain('notes')
    })
  })
})
