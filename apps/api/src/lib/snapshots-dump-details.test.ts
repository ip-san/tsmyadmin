import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Dialect, ImportResult, TableInfo } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildExport, DUMP_COMPLETE_MARKER } from './export.ts'
import { importSql } from './import.ts'
import { previewRestore, restoreSnapshot, SnapshotError, SnapshotStore, takeSnapshot } from './snapshots.ts'

/**
 * What goes into a snapshot and how a restore is run, with the export and the import replaced by recorders: which
 * objects are dumped and in which order, how the bytes of a dump are counted and decoded, what a failed dump gives
 * back, and the options a restore passes on (found as surviving mutants; see `bun run mutation`).
 */

vi.mock('./export.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export.ts')>()),
  buildExport: vi.fn(),
}))
vi.mock('./import.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./import.ts')>()),
  importSql: vi.fn(),
}))

const mocks = {
  buildExport: vi.mocked(buildExport),
  importSql: vi.mocked(importSql),
}

const NS = { database: 'shop' }
const info = (name: string, kind: TableInfo['kind']): TableInfo => ({ name, kind }) as TableInfo

/** An adapter that lists the given objects and builds one DROP per object it is asked to drop. */
function adapterOf(tables: TableInfo[], dialect: Dialect = 'mysql') {
  return {
    dialect,
    listTables: async () => tables,
    ddl: {
      build: (_ns: unknown, op: { objects: { name: string; kind: string }[] }) =>
        op.objects.map((o) => `DROP ${o.kind} ${o.name}`),
    },
  } as unknown as DatabaseAdapter
}

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield p
}
const dumpOf = (...parts: (string | Uint8Array)[]) => ({
  body: chunks(...parts),
  contentType: 'application/sql',
  filename: 'x.sql',
})
const encode = (s: string) => new TextEncoder().encode(s)
const MARKER = `${DUMP_COMPLETE_MARKER} (0 objects)\n`

async function refusal(run: Promise<unknown>): Promise<SnapshotError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(SnapshotError)
  return err as SnapshotError
}

beforeEach(() => {
  mocks.buildExport.mockReset()
  mocks.importSql.mockReset()
})

describe('takeSnapshot: what is dumped', () => {
  it('asks for an SQL dump of the whole namespace, tables first and then views, using the listing it already has', async () => {
    mocks.buildExport.mockReturnValue(dumpOf(MARKER))
    const all = [info('v1', 'view'), info('b', 'table'), info('v2', 'view'), info('a', 'table')]
    const adapter = adapterOf(all)
    await takeSnapshot(new SnapshotStore({ sweepIntervalMs: 0 }), 's', adapter, NS, 'n')
    expect(mocks.buildExport).toHaveBeenCalledTimes(1)
    const [passedAdapter, ns, names, query, baseName, everything, listing] = mocks.buildExport.mock.calls[0] ?? []
    // The adapter itself, behind the recorder of the definitions the dump reads (see snapshot-diff.test.ts).
    expect(passedAdapter).not.toBe(adapter)
    expect(passedAdapter?.dialect).toBe(adapter.dialect)
    expect(await passedAdapter?.listTables(NS)).toBe(all)
    expect(ns).toEqual(NS)
    expect(names).toEqual(['b', 'a', 'v1', 'v2'])
    expect(query).toMatchObject({ format: 'sql' })
    expect(baseName).toBe('shop')
    expect(everything).toBe(true)
    expect(listing).toBe(all)
  })

  it('records the number of objects the database had', async () => {
    mocks.buildExport.mockReturnValue(dumpOf(MARKER))
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const s = await takeSnapshot(store, 's', adapterOf([info('a', 'table'), info('v', 'view')]), NS, 'n')
    expect(s.objects).toBe(2)
    expect(s.name).toBe('n')
  })
})

describe('takeSnapshot: reading the dump', () => {
  it('joins text and bytes in order, and a character split between two chunks is whole again', async () => {
    const bytes = encode('あ')
    mocks.buildExport.mockReturnValue(dumpOf('-- a\n', bytes.slice(0, 1), bytes.slice(1), encode('い\n'), MARKER))
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const s = await takeSnapshot(store, 's', adapterOf([]), NS, 'n')
    expect(store.get('s', s.id)?.sql).toBe(`-- a\nあい\n${MARKER}`)
    expect(s.bytes).toBe(Buffer.byteLength(`-- a\nあい\n${MARKER}`))
  })

  it('counts bytes of binary chunks against the limit as it reads, and names the limit in MB', async () => {
    const mb = 1024 * 1024
    const marked = (n: number) => `${MARKER}${'x'.repeat(n - MARKER.length)}`
    // Exactly at the limit is allowed (the marker is in it), one byte over is not.
    mocks.buildExport.mockReturnValue(dumpOf(encode(marked(2 * mb))))
    const ok = await takeSnapshot(
      new SnapshotStore({ sweepIntervalMs: 0 }),
      's',
      adapterOf([]),
      NS,
      'n',
      new Date(),
      2 * mb
    )
    expect(ok.bytes).toBe(2 * mb)
    mocks.buildExport.mockReturnValue(dumpOf(encode(marked(2 * mb + 1))))
    const err = await refusal(
      takeSnapshot(new SnapshotStore({ sweepIntervalMs: 0 }), 's', adapterOf([]), NS, 'n', new Date(), 2 * mb)
    )
    expect(err.reason).toBe('TOO_LARGE')
    expect(err.message).toBe('The dump is larger than 2 MB: a database this size is for Export')
  })

  it('counts the bytes of text chunks too, and adds the chunks up', async () => {
    mocks.buildExport.mockReturnValue(dumpOf('あ'.repeat(10), 'あ'.repeat(10), MARKER))
    const err = await refusal(
      takeSnapshot(new SnapshotStore({ sweepIntervalMs: 0 }), 's', adapterOf([]), NS, 'n', new Date(), 59)
    )
    expect(err.reason).toBe('TOO_LARGE')
    // 60 bytes of text alone: 59 refuses on the second chunk, before the marker is even read.
  })

  it('refuses a dump that never says it is complete, naming why, and saves nothing', async () => {
    mocks.buildExport.mockReturnValue(dumpOf('-- cut off\nINSERT INTO t VALUES (1);\n'))
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const err = await refusal(takeSnapshot(store, 's', adapterOf([]), NS, 'n'))
    expect(err.reason).toBe('INCOMPLETE')
    expect(err.message).toBe('The dump did not finish: nothing was saved')
    expect(store.list('s')).toEqual([])
  })

  it('gives the room it set aside back, whether the dump is kept or refused', async () => {
    const store = new SnapshotStore({ totalLimit: 1000, sweepIntervalMs: 0 })
    mocks.buildExport.mockReturnValue(dumpOf('cut off'))
    await refusal(takeSnapshot(store, 's', adapterOf([]), NS, 'n', new Date(), 500))
    expect(store.reserve(1000).limit).toBe(1000)
    const kept = new SnapshotStore({ totalLimit: 1000, sweepIntervalMs: 0 })
    mocks.buildExport.mockReturnValue(dumpOf(MARKER))
    const s = await takeSnapshot(kept, 's', adapterOf([]), NS, 'n', new Date(), 500)
    expect(kept.reserve(1000).limit).toBe(1000 - s.bytes)
  })

  it('gives the room back when the export itself fails', async () => {
    const store = new SnapshotStore({ totalLimit: 1000, sweepIntervalMs: 0 })
    mocks.buildExport.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(takeSnapshot(store, 's', adapterOf([]), NS, 'n', new Date(), 500)).rejects.toThrow('boom')
    expect(store.reserve(1000).limit).toBe(1000)
  })
})

describe('previewRestore', () => {
  it('says what the snapshot is, how many statements it runs, and what made since will be dropped', async () => {
    mocks.buildExport.mockReturnValue(dumpOf(MARKER))
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const taken = await takeSnapshot(store, 's', adapterOf([info('old', 'table')]), NS, 'n')
    const held = store.get('s', taken.id)
    if (!held) throw new Error('not held')
    const now = adapterOf([info('old', 'table'), info('new1', 'table'), info('v', 'view')])
    expect(await previewRestore(now, NS, held)).toEqual({
      snapshot: taken,
      statements: held.statements,
      drops: ['DROP table new1', 'DROP view v'],
    })
    expect((await previewRestore(adapterOf([info('old', 'table')]), NS, held)).drops).toEqual([])
  })
})

describe('restoreSnapshot', () => {
  async function held(sql: string) {
    mocks.buildExport.mockReturnValue(dumpOf(sql))
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const taken = await takeSnapshot(store, 's', adapterOf([info('old', 'table')]), NS, 'n')
    const h = store.get('s', taken.id)
    if (!h) throw new Error('not held')
    return h
  }
  const sqlResult: ImportResult = {
    format: 'sql',
    total: 6,
    statements: 5,
    succeeded: 4,
    failed: 1,
    durationMs: 12,
    errors: [
      { sql: 'A', message: 'e1' },
      { sql: 'B', message: 'e2' },
    ],
    warnings: [],
  }

  it('drops what was made since, then runs the dump, stopping at the first error, with the query ID it was given', async () => {
    mocks.importSql.mockResolvedValue(sqlResult)
    const h = await held(MARKER)
    const adapter = adapterOf([info('old', 'table'), info('extra', 'table')])
    const result = await restoreSnapshot(adapter, NS, h, 'q-1')
    expect(result).toEqual({ statements: 5, failed: 1, errors: ['e1', 'e2'], durationMs: 12 })
    const [passedAdapter, ns, script, options] = mocks.importSql.mock.calls[0] ?? []
    expect(passedAdapter).toBe(adapter)
    expect(ns).toEqual(NS)
    expect(script).toBe(`DROP table extra;\n${MARKER}`)
    expect(options).toEqual({
      stopOnError: true,
      ignoreForeignKeys: true,
      singleTransaction: false,
      queryId: 'q-1',
    })
  })

  it('runs the dump as it is when nothing was made since', async () => {
    mocks.importSql.mockResolvedValue(sqlResult)
    const h = await held(MARKER)
    await restoreSnapshot(adapterOf([info('old', 'table')]), NS, h, 'q')
    expect(mocks.importSql.mock.calls[0]?.[2]).toBe(MARKER)
  })

  it('wraps the whole restore in one transaction where definitions roll back, and then leaves foreign keys alone', async () => {
    mocks.importSql.mockResolvedValue(sqlResult)
    const h = await held(MARKER)
    await restoreSnapshot(adapterOf([info('old', 'table')], 'postgres'), NS, h, 'q')
    expect(mocks.importSql.mock.calls[0]?.[3]).toEqual({
      stopOnError: true,
      ignoreForeignKeys: false,
      singleTransaction: true,
      queryId: 'q',
    })
  })

  it('refuses an answer that is not the result of a SQL script', async () => {
    mocks.importSql.mockResolvedValue({
      format: 'csv',
      table: 't',
      columns: [],
      skippedColumns: [],
      inserted: 0,
      skipped: 0,
      warnings: [],
      durationMs: 1,
    })
    const h = await held(MARKER)
    await expect(restoreSnapshot(adapterOf([]), NS, h, 'q')).rejects.toThrow(
      'A SQL restore answered with another kind of result'
    )
  })
})
