import { gunzipSync } from 'node:zlib'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ExportQuerySchema } from '@tsmyadmin/shared'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { buildPackagedExport, encodeText, renderFileName, safeFileName, withRowRange } from './export-package.ts'
import { readZip } from './zip.ts'

const adapter = (dialect: 'mysql' | 'postgres' = 'mysql') =>
  new FakeAdapter({
    dialect,
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'あ' },
              { id: 2, name: 'い' },
              { id: 3, name: 'う' },
              { id: 4, name: 'え' },
            ],
            ['id']
          ),
          posts: fakeTable('posts', ['id', 'title'], [{ id: 1, title: 'hello' }], ['id']),
        },
      },
    },
  })
const ns = { database: 'shop' }
const q = (over: Record<string, string>) => ExportQuerySchema.parse(over)
const bytes = async (parts: AsyncIterable<Uint8Array>) => Buffer.concat(await Array.fromAsync(parts))
const NOW = new Date(2026, 0, 2, 3, 4, 5)

describe('file names', () => {
  it('fills the template and cleans what no file system takes', () => {
    const parts = { database: 'shop', table: 'users', server: 'db.example', now: NOW }
    expect(renderFileName('@DATABASE@_@TABLE@_%Y%m%d-%H%M%S', parts, 'x')).toBe('shop_users_20260102-030405')
    expect(renderFileName('@SERVER@/%y', parts, 'x')).toBe('db.example_26')
    expect(renderFileName('   ', parts, 'fallback')).toBe('fallback')
    expect(renderFileName('....', parts, 'fallback')).toBe('_')
    expect(safeFileName('a<b>:c|d?')).toBe('a_b__c_d_')
  })
})

describe('character sets', () => {
  it('writes text in the chosen set, and refuses a character the set cannot hold', async () => {
    const encode = async (text: string, charset: 'utf-8' | 'cp932' | 'iso-8859-1') =>
      Buffer.concat(
        await Array.fromAsync(
          encodeText(
            (async function* () {
              yield text
            })(),
            charset
          )
        )
      )
    expect(iconv.decode(await encode('日本語', 'cp932'), 'cp932')).toBe('日本語')
    expect((await encode('日本語', 'utf-8')).toString('utf8')).toBe('日本語')
    await expect(encode('日本語', 'iso-8859-1')).rejects.toThrow(/cannot hold/)
  })
})

describe('buildPackagedExport', () => {
  it('names a plain export by the template and encodes it', async () => {
    const file = buildPackagedExport(
      adapter(),
      ns,
      ['users'],
      q({ format: 'csv', charset: 'cp932', filename: 'x_%Y' }),
      {
        server: 's',
        baseName: 'shop_users',
        everything: false,
        now: NOW,
      }
    )
    expect(file.filename).toBe('x_2026.csv')
    expect(file.contentType).toContain('charset=cp932')
    expect(iconv.decode(await bytes(file.body), 'cp932')).toContain('あ')
  })

  it('compresses with gzip or into a zip', async () => {
    const opts = { server: 's', baseName: 'shop', everything: true, now: NOW }
    const gz = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'json', compress: 'gzip' }), opts)
    expect(gz.filename).toBe('shop.json.gz')
    expect(gz.contentType).toBe('application/gzip')
    expect(JSON.parse(gunzipSync(await bytes(gz.body)).toString('utf8')).users[0]).toEqual({ id: 1, name: 'あ' })
    const zip = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'json', compress: 'zip' }), opts)
    expect(zip.filename).toBe('shop.zip')
    const files = readZip(new Uint8Array(await bytes(zip.body)))
    expect(files.map((f) => f.name)).toEqual(['shop.json'])
  })

  it('makes one file per table in a zip, each holding only its own table, even for CSV', async () => {
    const file = buildPackagedExport(
      adapter(),
      ns,
      ['users', 'posts'],
      q({ format: 'csv', filePerTable: '1', filename: '@TABLE@-data' }),
      { server: 's', baseName: 'shop', everything: true, now: NOW }
    )
    expect(file.filename).toBe('shop-data.zip')
    const files = readZip(new Uint8Array(await bytes(file.body)))
    expect(files.map((f) => f.name)).toEqual(['users-data.csv', 'posts-data.csv'])
    expect(new TextDecoder().decode(files[1]?.bytes())).toContain('hello')
    expect(new TextDecoder().decode(files[1]?.bytes())).not.toContain('あ')
  })

  it('gives every file of a per-table zip its own name even when the template names no table', async () => {
    for (const filename of ['', '@DATABASE@_%Y']) {
      const file = buildPackagedExport(
        adapter(),
        ns,
        ['users', 'posts'],
        q({ format: 'csv', filePerTable: '1', filename }),
        {
          server: 's',
          baseName: 'shop',
          everything: true,
          now: NOW,
        }
      )
      const names = readZip(new Uint8Array(await bytes(file.body))).map((f) => f.name)
      expect(new Set(names).size).toBe(2)
      expect(names.some((n) => n.includes('users'))).toBe(true)
    }
  })

  it('writes JSON, XML, YAML and HTML as UTF-8 whatever character set was chosen', async () => {
    const file = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'json', charset: 'cp932' }), {
      server: 's',
      baseName: 'shop',
      everything: false,
      now: NOW,
    })
    expect(file.contentType).toContain('charset=utf-8')
    expect(Buffer.from(await bytes(file.body)).toString('utf8')).toContain('あ')
  })

  it('leaves binary formats alone by the character set and puts them in a ZIP of their own', async () => {
    const file = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'ods', charset: 'cp932' }), {
      server: 's',
      baseName: 'shop',
      everything: false,
      now: NOW,
    })
    expect(file.filename).toBe('shop.ods')
    expect(file.contentType).toBe('application/vnd.oasis.opendocument.spreadsheet')
    const files = readZip(new Uint8Array(await bytes(file.body)))
    expect(new TextDecoder().decode(files.find((f) => f.name === 'content.xml')?.bytes())).toContain('あ')
  })
})

describe('withRowRange', () => {
  const rowsOf = async (a: ReturnType<typeof adapter>, offset: number, limit: number) => {
    const ranged = withRowRange(a, offset, limit)
    const ids: unknown[] = []
    for await (const b of ranged.iterateRows(ns, 'users', { batchSize: 3 })) for (const r of b.rows) ids.push(r[0])
    return ids
  }

  it('skips and limits across batches', async () => {
    expect(await rowsOf(adapter(), 0, 0)).toEqual([1, 2, 3, 4])
    expect(await rowsOf(adapter(), 1, 2)).toEqual([2, 3])
    expect(await rowsOf(adapter(), 3, 5)).toEqual([4])
    expect(await rowsOf(adapter(), 10, 0)).toEqual([])
  })

  it('applies to every format through the packaged export', async () => {
    const file = buildPackagedExport(adapter(), ns, ['users'], q({ format: 'json', rowOffset: '1', rowLimit: '2' }), {
      server: 's',
      baseName: 'shop',
      everything: false,
      now: NOW,
    })
    expect(
      JSON.parse(Buffer.from(await bytes(file.body)).toString('utf8')).users.map((r: { id: number }) => r.id)
    ).toEqual([2, 3])
  })
})
