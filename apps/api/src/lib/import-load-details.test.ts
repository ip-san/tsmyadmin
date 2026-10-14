import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ImportFormSchema, type StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { csvSource, type ImportValidationError, importRows, type RowsSource } from './import.ts'

/** Rows loaded from a CSV (or another rows source): the header, the columns, the values, the errors, the new table. */

const ns = { database: 'shop' }
const caughtOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as ImportValidationError
  }
}

const form = (over: Record<string, string> = {}) =>
  ImportFormSchema.parse({ file: new File([''], 'x.csv'), format: 'csv', table: 'users', ...over })
const usersTable = () => fakeTable('users', ['id', 'name', 'age'], [])
const shop = (...tables: ReturnType<typeof fakeTable>[]) =>
  new FakeAdapter({ databases: { shop: { tables: Object.fromEntries(tables.map((t) => [t.schema.name, t])) } } })
const inserted = (a: FakeAdapter) => a.calls.filter((c) => c.method === 'insertRows').at(-1)?.args as unknown[]

describe('csvSource', () => {
  const base = { delimiter: ',', enclosure: '"', escape: '"', nullMarker: '\\N' }
  const read = (text: string, over: Partial<Parameters<typeof csvSource>[1]> = {}) => [
    ...csvSource(text, { ...base, ...over }).records(),
  ]

  it('reads records with their lines, the NULL marker only when written without quotes', () => {
    expect(read('a,\\N,"\\N",""\n')).toEqual([{ line: 1, cells: ['a', null, '\\N', ''] }])
    expect(csvSource('', base).header).toBeNull()
    expect(csvSource('', base).format).toBe('csv')
  })

  it('reads either kind of line end by default', () => {
    expect(read('a\r\nb\nc').map((r) => r.cells[0])).toEqual(['a', 'b', 'c'])
    expect(read('a\r\nb', { lineEnd: 'auto' }).map((r) => r.cells[0])).toEqual(['a', 'b'])
  })

  it('skips a blank line, but not a line that holds a field, a quoted empty one, or when asked to keep them', () => {
    expect(read('a\n\nb\n').map((r) => r.line)).toEqual([1, 3])
    expect(read(',x\n').map((r) => r.cells)).toEqual([['', 'x']])
    expect(read(',\n').map((r) => r.cells)).toEqual([['', '']])
    expect(read('""\n').map((r) => r.cells)).toEqual([['']])
    expect(read('a\n\nb\n', { skipBlank: '0' }).map((r) => r.cells)).toEqual([['a'], [''], ['b']])
    expect(read('a\n\nb\n', { skipBlank: '1' }).map((r) => r.cells)).toEqual([['a'], ['b']])
  })

  it('can be read again from the start', () => {
    const s = csvSource('a\nb\n', base)
    expect([...s.records()]).toHaveLength(2)
    expect([...s.records()]).toHaveLength(2)
  })
})

describe('importRows: the header and the columns', () => {
  const rowsOf = (header: string[] | null, rows: (string | null | { base64: string })[][]): RowsSource => ({
    header,
    format: 'xml',
    records: () => rows.map((cells, i) => ({ line: i + 1, cells })),
  })

  it('takes the first record as the header when the file has none of its own: trimmed, bytes as text, NULL as empty', async () => {
    const a = shop(usersTable())
    const idBytes = { base64: Buffer.from('id').toString('base64') }
    const r = await importRows(
      a,
      ns,
      form(),
      rowsOf(null, [
        [idBytes, ' name '],
        ['1', 'A'],
      ])
    )
    expect(r).toMatchObject({ format: 'xml', columns: ['id', 'name'], inserted: 1 })
    expect(inserted(a)[3]).toEqual([['1', 'A']])
    const e = await caughtOf(
      importRows(
        shop(usersTable()),
        ns,
        form(),
        rowsOf(null, [
          ['id', null],
          ['1', 'A'],
        ])
      )
    )
    expect(e?.reason).toBe('CSV_UNKNOWN_COLUMNS')
    expect(e?.message).toBe('Unknown column(s) in header: (empty)')
  })

  it('keeps the header a file names itself, and reads every record as data, whatever the form says', async () => {
    const a = shop(usersTable())
    const r = await importRows(
      a,
      ns,
      form({ header: '1' }),
      rowsOf(
        ['id', 'name'],
        [
          ['1', 'A'],
          ['2', 'B'],
        ]
      )
    )
    expect(r).toMatchObject({ columns: ['id', 'name'], inserted: 2 })
    expect(inserted(a)[3]).toEqual([
      ['1', 'A'],
      ['2', 'B'],
    ])
  })

  it('reads the first record as data without a header, as many columns as the widest record', async () => {
    const a = shop(usersTable())
    const r = await importRows(a, ns, form({ header: '0' }), rowsOf(null, [['1'], ['2', 'B', 'x']]))
    expect(r).toMatchObject({ columns: ['id', 'name', 'age'], inserted: 2 })
    expect(inserted(a)[3]).toEqual([
      ['1', null, null],
      ['2', 'B', 'x'],
    ])
    const narrow = shop(usersTable())
    const n = await importRows(narrow, ns, form({ header: '0' }), rowsOf(null, [['1'], ['2']]))
    expect(n.format === 'xml' && 'columns' in n && n.columns).toEqual(['id'])
  })

  it('refuses a record with more fields than there are columns to put them in', async () => {
    const e = await caughtOf(
      importRows(shop(usersTable()), ns, form({ header: '0' }), rowsOf(null, [['1', 'a', 'b', 'c']]))
    )
    expect(e?.reason).toBe('CSV_FIELD_COUNT')
    expect(e?.message).toBe('Line 1 has 4 fields but 3 columns')
    expect(e?.params).toEqual({ line: 1, fields: 4, columns: 3 })
    const h = await caughtOf(importRows(shop(usersTable()), ns, form(), rowsOf(['id', 'name'], [['1', 'a', 'b']])))
    expect(h?.message).toBe('Line 1 has 3 fields but 2 columns')
  })

  it('refuses a header that names a column of different case twice over (PostgreSQL columns that differ by case)', async () => {
    const two = () => shop(fakeTable('t', ['id', 'Name', 'name'], []))
    const e = await caughtOf(importRows(two(), ns, form({ table: 't' }), rowsOf(['id', 'NAME'], [['1', 'a']])))
    expect(e?.reason).toBe('CSV_AMBIGUOUS_COLUMNS')
    expect(e?.message).toBe('Header column(s) match several table columns (case differs): NAME')
    expect(e?.params).toEqual({ columns: 'NAME' })
    // An exact name is not ambiguous.
    const ok = await importRows(two(), ns, form({ table: 't' }), rowsOf(['id', 'name', 'Name'], [['1', 'a', 'b']]))
    expect(ok).toMatchObject({ columns: ['id', 'name', 'Name'] })
    // Many: all in the message, five in the parameter.
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const wide = shop(
      fakeTable('w', ['id', ...names.flatMap((n) => [n.toLowerCase(), n.toUpperCase() === n ? `${n}x` : n])], [])
    )
    expect(wide).toBeDefined()
    const cols = names.flatMap((n) => [`${n}1`, `${n}2`])
    const many = shop(
      fakeTable(
        'm',
        cols.map((c) => c.toLowerCase()),
        []
      )
    )
    // (Columns a1, a2, ... have no twin differing by case: build twins explicitly.)
    const twins = names.flatMap((n) => [`${n.toLowerCase()}x`, `${n.toLowerCase()}X`])
    const t = shop(fakeTable('t2', twins, []))
    const h = names.map((n) => `${n.toLowerCase()}X`.toUpperCase())
    const e2 = await caughtOf(importRows(t, ns, form({ table: 't2' }), rowsOf(h, [h.map(() => '1')])))
    expect(e2?.reason).toBe('CSV_AMBIGUOUS_COLUMNS')
    expect(e2?.message).toBe(`Header column(s) match several table columns (case differs): ${h.join(', ')}`)
    expect(e2?.params).toEqual({ columns: h.slice(0, 5).join(', ') })
    expect(many).toBeDefined()
  })

  it('refuses a header that names a column twice, listing each once in the parameter', async () => {
    const cols = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
    const t = () => shop(fakeTable('t', cols, []))
    const e = await caughtOf(importRows(t(), ns, form({ table: 't' }), rowsOf(['c1', 'C1'], [['1', '2']])))
    expect(e?.reason).toBe('CSV_DUPLICATE_COLUMNS')
    expect(e?.message).toBe('Header names a column twice: c1')
    expect(e?.params).toEqual({ columns: 'c1' })
    const thrice = await caughtOf(
      importRows(t(), ns, form({ table: 't' }), rowsOf(['c1', 'c1', 'c1'], [['1', '2', '3']]))
    )
    expect(thrice?.message).toBe('Header names a column twice: c1, c1')
    expect(thrice?.params).toEqual({ columns: 'c1' })
    const header = cols.flatMap((c) => [c, c])
    const many = await caughtOf(importRows(t(), ns, form({ table: 't' }), rowsOf(header, [header.map(() => '1')])))
    expect(many?.message).toBe(`Header names a column twice: ${cols.join(', ')}`)
    expect(many?.params).toEqual({ columns: cols.slice(0, 5).join(', ') })
  })

  it('lists at most five unknown columns, cutting a long name at 64 characters and naming an empty one', async () => {
    const run = (header: string[]) =>
      caughtOf(importRows(shop(usersTable()), ns, form(), rowsOf(header, [header.map(() => '1')])))
    const e = await run(['id', 'a', 'b', 'c', 'd', 'e'])
    expect(e?.reason).toBe('CSV_UNKNOWN_COLUMNS')
    expect(e?.message).toBe('Unknown column(s) in header: a, b, c, d, e')
    const more = await run(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(more?.message).toBe('Unknown column(s) in header: a, b, c, d, e (+2)')
    expect(more?.params).toEqual({ columns: 'a, b, c, d, e (+2)' })
    const one = await run(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(one?.message).toBe('Unknown column(s) in header: a, b, c, d, e (+1)')
    const sixtyFour = 'x'.repeat(64)
    const exact = await run([sixtyFour])
    expect(exact?.message).toBe(`Unknown column(s) in header: ${sixtyFour}`)
    const long = await run(['y'.repeat(65)])
    expect(long?.message).toBe(`Unknown column(s) in header: ${'y'.repeat(64)}…`)
    const empty = await run(['id', ''])
    expect(empty?.message).toBe('Unknown column(s) in header: (empty)')
  })

  it('refuses to import into no column at all', async () => {
    const mapped = await caughtOf(
      importRows(shop(usersTable()), ns, form({ header: '0', columns: '["",""]' }), rowsOf(null, [['1', '2']]))
    )
    expect(mapped?.reason).toBe('CSV_NO_COLUMNS')
    expect(mapped?.message).toBe('No columns to import')
    const t = usersTable()
    const age = t.schema.columns.find((c) => c.name === 'age')
    if (age) age.extra = 'STORED GENERATED'
    const generatedOnly = await caughtOf(importRows(shop(t), ns, form(), rowsOf(['age'], [['1']])))
    expect(generatedOnly?.reason).toBe('CSV_NO_COLUMNS')
    expect(generatedOnly?.message).toBe('No columns to import')
  })

  it('leaves a generated column out of the INSERT, and names it in the result, whether the header names it or not', async () => {
    const generated = () => {
      const t = fakeTable('users', ['id', 'gen', 'name'], [])
      const gen = t.schema.columns.find((c) => c.name === 'gen')
      if (gen) gen.extra = 'VIRTUAL GENERATED'
      return t
    }
    const named = shop(generated())
    const r = await importRows(named, ns, form(), rowsOf(['id', 'gen', 'name'], [['1', 'g', 'A']]))
    expect(r).toMatchObject({ columns: ['id', 'name'], skippedColumns: ['gen'], inserted: 1 })
    expect(inserted(named)[2]).toEqual(['id', 'name'])
    expect(inserted(named)[3]).toEqual([['1', 'A']])
    const positional = shop(generated())
    const p = await importRows(positional, ns, form({ header: '0' }), rowsOf(null, [['1', 'g', 'A']]))
    expect(p).toMatchObject({ columns: ['id', 'name'], skippedColumns: ['gen'] })
    expect(inserted(positional)[3]).toEqual([['1', 'A']])
    const plain = shop(usersTable())
    const q = await importRows(plain, ns, form(), rowsOf(['id'], [['1']]))
    expect(q).toMatchObject({ skippedColumns: [] })
  })

  it('takes each column’s value from the field the mapping names, leaving the blank-named ones out', async () => {
    const a = shop(usersTable())
    await importRows(a, ns, form({ header: '0', columns: '["id","","name"]' }), rowsOf(null, [['1', 'skip', 'A']]))
    expect(inserted(a)[2]).toEqual(['id', 'name'])
    expect(inserted(a)[3]).toEqual([['1', 'A']])
  })

  it('takes a name made of spaces as blank, too', async () => {
    const a = shop(usersTable())
    await importRows(a, ns, form({ header: '0', columns: '["id","  ","name"]' }), rowsOf(null, [['1', 'skip', 'A']]))
    expect(inserted(a)[2]).toEqual(['id', 'name'])
    expect(inserted(a)[3]).toEqual([['1', 'A']])
  })

  it('asks for the system values only when a column that takes them is written', async () => {
    const t = () => {
      const tbl = fakeTable('users', ['id', 'name'], [])
      const id = tbl.schema.columns.find((c) => c.name === 'id')
      if (id) id.extra = 'identity always'
      return tbl
    }
    const withId = shop(t())
    await importRows(withId, ns, form(), rowsOf(['id', 'name'], [['1', 'A']]))
    expect(inserted(withId)[4]).toEqual({ overriding: true })
    const withoutId = shop(t())
    await importRows(withoutId, ns, form(), rowsOf(['name'], [['A']]))
    expect(inserted(withoutId)[4]).toEqual({ overriding: false })
  })

  it('sends the duplicate rule and the primary key only when a rule is chosen', async () => {
    for (const onDuplicate of ['ignore', 'replace']) {
      const a = shop(usersTable())
      await importRows(a, ns, form({ onDuplicate }), rowsOf(['id'], [['1']]))
      expect(inserted(a)[4]).toEqual({ overriding: false, onDuplicate, keyColumns: ['id'] })
    }
    const a = shop(usersTable())
    await importRows(a, ns, form({ onDuplicate: 'error' }), rowsOf(['id'], [['1']]))
    expect(inserted(a)[4]).toEqual({ overriding: false })
  })
})

describe('importRows: skipping rows and reading values', () => {
  it('skips the first rows after the header and counts them', async () => {
    const a = shop(usersTable())
    const r = await importRows(a, ns, form({ skip: '2' }), csvSource('id,name\n1,a\n2,b\n3,c\n', { ...form() }))
    expect(r).toMatchObject({ inserted: 1, skipped: 2 })
    expect(inserted(a)[3]).toEqual([['3', 'c']])
    const all = await importRows(shop(usersTable()), ns, form({ skip: '9' }), csvSource('id\n1\n2\n', { ...form() }))
    expect(all).toMatchObject({ inserted: 0, skipped: 2 })
    const noSkip = await importRows(shop(usersTable()), ns, form(), csvSource('id\n1\n2\n', { ...form() }))
    expect(noSkip).toMatchObject({ inserted: 2, skipped: 0 })
  })

  it('keeps the first record as data when it is not a header, and skips from it', async () => {
    const a = shop(usersTable())
    const r = await importRows(a, ns, form({ header: '0', skip: '1' }), csvSource('1\n2\n3\n', { ...form() }))
    expect(r).toMatchObject({ inserted: 2, skipped: 1 })
    expect(inserted(a)[3]).toEqual([['2'], ['3']])
  })

  it('reads bytes and base64 for the columns that take them: binary stays binary, text is decoded', async () => {
    const t = fakeTable('blobs', ['id', 'data'], [])
    const data = t.schema.columns.find((c) => c.name === 'data')
    if (data) data.dataType = 'blob'
    const bytes = { base64: Buffer.from('héllo').toString('base64') }
    const source: RowsSource = {
      header: ['id', 'data'],
      format: 'xml',
      records: () => [
        { line: 1, cells: [bytes, bytes] },
        { line: 2, cells: ['x', 'AQI='] },
        { line: 3, cells: ['y', ''] },
        { line: 4, cells: ['z', 'AQ=='] },
        { line: 5, cells: [null, null] },
      ],
    }
    const a = shop(t)
    await importRows(a, ns, form({ table: 'blobs' }), source)
    expect(inserted(a)[3]).toEqual([
      ['héllo', { $bin: Buffer.from('héllo').toString('base64') }],
      ['x', { $bin: 'AQI=' }],
      ['y', { $bin: '' }],
      ['z', { $bin: 'AQ==' }],
      [null, null],
    ])
  })

  it('refuses text that is not base64 in a binary column, with the line and the column', async () => {
    const t = fakeTable('blobs', ['id', 'data'], [])
    const data = t.schema.columns.find((c) => c.name === 'data')
    if (data) data.dataType = 'blob'
    for (const bad of ['AQI', 'not base64!', 'AQ=', 'A===']) {
      const source = csvSource(`id,data\n1,AQI=\n2,${bad}\n`, { ...form() })
      const e = await caughtOf(importRows(shop(t), ns, form({ table: 'blobs' }), source))
      expect(e?.reason, bad).toBe('CSV_BINARY')
      expect(e?.message, bad).toBe('Line 3: column data expects base64 binary data')
      expect(e?.params, bad).toEqual({ line: 3, column: 'data' })
    }
  })
})

describe('importRows: the result', () => {
  it('names the format of the source, the table, the columns and what the server said', async () => {
    class Warns extends FakeAdapter {
      override async insertRows(...args: Parameters<FakeAdapter['insertRows']>) {
        const r = await super.insertRows(...args)
        return { ...r, warnings: ['truncated'] }
      }
    }
    const a = new Warns({ databases: { shop: { tables: { users: usersTable() } } } })
    const r = await importRows(a, ns, form(), csvSource('id,name\n1,a\n', { ...form() }))
    expect(r).toMatchObject({
      format: 'csv',
      table: 'users',
      columns: ['id', 'name'],
      skippedColumns: [],
      inserted: 1,
      warnings: ['truncated'],
      skipped: 0,
    })
    expect(r).not.toHaveProperty('created')
    const plain = await importRows(shop(usersTable()), ns, form(), csvSource('id\n1\n', { ...form() }))
    expect(plain).toMatchObject({ warnings: [] })
    expect(plain.format === 'csv' && plain.durationMs).toBeGreaterThanOrEqual(0)
    expect(plain.format === 'csv' && plain.durationMs).toBeLessThan(60_000)
  })

  it('refuses without a target table, and an empty file', async () => {
    const noTable = ImportFormSchema.parse({ file: new File([''], 'x.csv'), format: 'csv' })
    const e = await caughtOf(importRows(shop(usersTable()), ns, noTable, csvSource('id\n1\n', { ...noTable })))
    expect(e?.reason).toBe('CSV_NO_TABLE')
    expect(e?.message).toBe('CSV import requires a target table')
    const empty = await caughtOf(importRows(shop(usersTable()), ns, form(), csvSource('', { ...form() })))
    expect(empty?.reason).toBe('CSV_EMPTY')
    expect(empty?.message).toBe('The CSV file is empty')
  })
})

describe('importRows: the server refuses some rows', () => {
  const failing = (rows: [number, number] | undefined, detail?: string) =>
    new (class extends FakeAdapter {
      override async insertRows(...args: Parameters<FakeAdapter['insertRows']>): Promise<{ affectedRows: number }> {
        // The rows are read before the server answers: the importer knows the line of each it has handed over.
        const handedOver = [...args[3]].length
        expect(handedOver).toBeGreaterThan(0)
        throw new AdapterError('QUERY_FAILED', 'whole message', detail, rows ? { rows } : {})
      }
    })({ databases: { shop: { tables: { users: usersTable() } } } })
  // Lines 2, 4 and 5 hold the rows (a blank line 3 is not one): row indexes 0, 1, 2.
  const text = 'id,name\n1,a\n\n3,c\n4,d\n'

  it('names the line of a single row, as the file numbers it, with the server’s own words', async () => {
    const e = await caughtOf(importRows(failing([1, 1], 'duplicate key'), ns, form(), csvSource(text, { ...form() })))
    expect(e?.reason).toBe('CSV_ROW_FAILED')
    expect(e?.message).toBe('Line 4: duplicate key')
    expect(e?.params).toEqual({ line: 4, message: 'duplicate key' })
    const noDetail = await caughtOf(importRows(failing([0, 0]), ns, form(), csvSource(text, { ...form() })))
    expect(noDetail?.message).toBe('Line 2: whole message')
    expect(noDetail?.params).toEqual({ line: 2, message: 'whole message' })
  })

  it('names the first and last line of a range', async () => {
    const e = await caughtOf(importRows(failing([0, 2], 'bad batch'), ns, form(), csvSource(text, { ...form() })))
    expect(e?.reason).toBe('CSV_ROWS_FAILED')
    expect(e?.message).toBe('Lines 2–5: bad batch')
    expect(e?.params).toEqual({ from: 2, to: 5, message: 'bad batch' })
  })

  it('counts from the row’s place when the file’s line is not known', async () => {
    const single = await caughtOf(importRows(failing([7, 7], 'x'), ns, form(), csvSource(text, { ...form() })))
    expect(single?.message).toBe('Line 8: x')
    expect(single?.params).toEqual({ line: 8, message: 'x' })
    const range = await caughtOf(importRows(failing([6, 9], 'x'), ns, form(), csvSource(text, { ...form() })))
    expect(range?.message).toBe('Lines 7–10: x')
    expect(range?.params).toEqual({ from: 7, to: 10, message: 'x' })
    const mixed = await caughtOf(importRows(failing([1, 9], 'x'), ns, form(), csvSource(text, { ...form() })))
    expect(mixed?.message).toBe('Lines 4–10: x')
  })

  it('passes on an error that names no rows, and any other error', async () => {
    const plain = failing(undefined)
    await expect(importRows(plain, ns, form(), csvSource(text, { ...form() }))).rejects.toBeInstanceOf(AdapterError)
    class Boom extends FakeAdapter {
      override async insertRows(): Promise<{ affectedRows: number }> {
        throw new TypeError('boom')
      }
    }
    const boom = new Boom({ databases: { shop: { tables: { users: usersTable() } } } })
    await expect(importRows(boom, ns, form(), csvSource(text, { ...form() }))).rejects.toThrow('boom')
  })
})

describe('importRows: a table made for the file', () => {
  /** A fake in which the CREATE TABLE of the importer makes the table (with the columns named). */
  class Creating extends FakeAdapter {
    failCreate: string | null = null
    leadWithSuccess = false
    failInsert: Error | null = null
    failDrop = false
    constructor(
      private readonly made: string[],
      existing: ReturnType<typeof fakeTable>[] = []
    ) {
      super({ databases: { shop: { tables: Object.fromEntries(existing.map((t) => [t.schema.name, t])) } } })
    }
    override async executeSql(
      ns: Parameters<FakeAdapter['executeSql']>[0],
      sql: string,
      options: Parameters<FakeAdapter['executeSql']>[2]
    ): Promise<StatementResult[]> {
      await super.executeSql(ns, sql, options)
      if (/^\s*DROP TABLE/i.test(sql)) {
        if (this.failDrop) throw new Error('drop failed')
        return [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }]
      }
      if (this.failCreate) {
        const lead: StatementResult[] = this.leadWithSuccess
          ? [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }]
          : []
        return [...lead, { kind: 'error', sql, message: this.failCreate }]
      }
      const databases = (this as unknown as { databases: Record<string, { tables: Record<string, unknown> }> })
        .databases
      const db = databases[ns.database]
      if (db) db.tables.newt = fakeTable('newt', this.made, [])
      return [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }]
    }
    override async insertRows(...args: Parameters<FakeAdapter['insertRows']>) {
      if (this.failInsert) throw this.failInsert
      return super.insertRows(...args)
    }
  }
  const create = (over: Record<string, string> = {}) => form({ table: 'newt', createTable: '1', ...over })
  const sqlsOf = (a: FakeAdapter) => a.calls.filter((c) => c.method === 'executeSql').map((c) => c.args[1] as string)

  it('creates the table from the header and the values, then loads the rows into it', async () => {
    const a = new Creating(['a', 'b'])
    const r = await importRows(a, ns, create(), csvSource('a,b\n1,x\n2,y\n', { ...form() }))
    // The types are those of the values (the header row is not one of them).
    expect(r).toMatchObject({
      format: 'csv',
      table: 'newt',
      columns: ['a', 'b'],
      inserted: 2,
      created: [
        { name: 'a', dataType: 'INT' },
        { name: 'b', dataType: 'VARCHAR(255)' },
      ],
    })
    expect(sqlsOf(a)).toHaveLength(1)
    expect(sqlsOf(a)[0]).toMatch(/CREATE TABLE/i)
    expect(sqlsOf(a)[0]).toContain('`newt`')
    expect(sqlsOf(a)[0]).toContain('INT')
    const createCall = a.calls.find((c) => c.method === 'executeSql')
    expect(createCall?.args[2]).toMatchObject({ maxRows: 1, timeoutMs: 60_000, stopOnError: true })
    expect(inserted(a)[3]).toEqual([
      ['1', 'x'],
      ['2', 'y'],
    ])
  })

  it('makes a column for the widest row, naming the ones the header does not', async () => {
    const a = new Creating(['a', 'col2'])
    const r = await importRows(a, ns, create(), csvSource('a\n1,x\n', { ...form() }))
    expect(r.format === 'csv' && 'created' in r && r.created?.map((c) => c.name)).toEqual(['a', 'col2'])
  })

  it('names the columns col1, col2… and types them from every row, when the file has no header', async () => {
    const a = new Creating(['col1', 'col2'])
    const r = await importRows(a, ns, create({ header: '0' }), csvSource('1,x\n2,y\n', { ...form() }))
    expect(r).toMatchObject({
      columns: ['col1', 'col2'],
      created: [
        { name: 'col1', dataType: 'INT' },
        { name: 'col2', dataType: 'VARCHAR(255)' },
      ],
    })
    expect(inserted(a)[3]).toEqual([
      ['1', 'x'],
      ['2', 'y'],
    ])
  })

  it('keeps the file’s own names whatever column mapping is sent', async () => {
    const a = new Creating(['a', 'b'])
    const r = await importRows(a, ns, create({ columns: '["x","y"]' }), csvSource('a,b\n1,2\n', { ...form() }))
    expect(r).toMatchObject({ columns: ['a', 'b'] })
  })

  it('refuses a table that exists already, and makes nothing', async () => {
    const a = new Creating(['a'], [fakeTable('newt', ['a'], [])])
    const e = await caughtOf(importRows(a, ns, create(), csvSource('a\n1\n', { ...form() })))
    expect(e?.reason).toBe('TABLE_EXISTS')
    expect(e?.message).toBe('The table newt exists already')
    expect(e?.params).toEqual({ table: 'newt' })
    expect(sqlsOf(a)).toEqual([])
  })

  it('makes the table when only other tables exist, with no key (a file says nothing about keys)', async () => {
    const a = new Creating(['a'], [usersTable()])
    const r = await importRows(a, ns, create(), csvSource('a\n1\n', { ...form() }))
    expect(r).toMatchObject({ table: 'newt', inserted: 1 })
    expect(sqlsOf(a)[0]).not.toMatch(/PRIMARY KEY/i)
  })

  it('finds the refusal wherever it is among the answers to the CREATE', async () => {
    const a = new Creating(['a'])
    a.failCreate = 'late failure'
    a.leadWithSuccess = true
    const e = await caughtOf(importRows(a, ns, create(), csvSource('a\n1\n', { ...form() })))
    expect(e?.reason).toBe('CREATE_INVALID_NAME')
    expect(e?.message).toBe('The table could not be created: late failure')
  })

  it('refuses a table the server will not make, with its words, and drops nothing', async () => {
    const a = new Creating(['a'])
    a.failCreate = 'name too long'
    const e = await caughtOf(importRows(a, ns, create(), csvSource('a\n1\n', { ...form() })))
    expect(e?.reason).toBe('CREATE_INVALID_NAME')
    expect(e?.message).toBe('The table could not be created: name too long')
    expect(e?.params).toEqual({ name: 'newt', message: 'name too long' })
    expect(sqlsOf(a)).toHaveLength(1)
  })

  it('drops the table it made when the rows cannot be loaded, and reports the original error', async () => {
    const a = new Creating(['a'])
    a.failInsert = new TypeError('load failed')
    await expect(importRows(a, ns, create(), csvSource('a\n1\n', { ...form() }))).rejects.toThrow('load failed')
    const sqls = sqlsOf(a)
    expect(sqls).toHaveLength(2)
    expect(sqls[1]).toMatch(/^\s*DROP TABLE/i)
    expect(sqls[1]).toContain('`newt`')
    expect(a.calls.filter((c) => c.method === 'executeSql')[1]?.args[2]).toMatchObject({
      maxRows: 1,
      timeoutMs: 60_000,
      stopOnError: true,
    })
  })

  it('drops it when the loading is refused for a problem of the file, found after the table was made', async () => {
    // The table the server made has only the column a: the file's second column is not in it.
    const a = new Creating(['a'])
    const e = await caughtOf(importRows(a, ns, create(), csvSource('a\n1,2\n', { ...form() })))
    expect(e?.reason).toBe('CSV_UNKNOWN_COLUMNS')
    expect(sqlsOf(a).at(-1)).toMatch(/^\s*DROP TABLE/i)
  })

  it('still reports the original error when the table cannot be dropped', async () => {
    const a = new Creating(['a'])
    a.failInsert = new TypeError('load failed')
    a.failDrop = true
    await expect(importRows(a, ns, create(), csvSource('a\n1\n', { ...form() }))).rejects.toThrow('load failed')
  })

  it('drops nothing when the table was not made for this file', async () => {
    const a = new Creating(['a'], [usersTable()])
    a.failInsert = new TypeError('load failed')
    await expect(importRows(a, ns, form(), csvSource('id\n1\n', { ...form() }))).rejects.toThrow('load failed')
    expect(sqlsOf(a)).toEqual([])
  })

  it('reports a quote left open as a problem of the file, whether found before the table is made or while loading', async () => {
    const before = new Creating(['a'])
    const e = await caughtOf(importRows(before, ns, create(), csvSource('a\n1\n2,"open\n', { ...form() })))
    expect(e?.reason).toBe('CSV_UNTERMINATED_QUOTE')
    expect(e?.params).toEqual({ line: 3 })
    expect(sqlsOf(before)).toEqual([])
    const during = shop(usersTable())
    const d = await caughtOf(importRows(during, ns, form(), csvSource('id\n1\n"open\n', { ...form() })))
    expect(d?.reason).toBe('CSV_UNTERMINATED_QUOTE')
    expect(d?.params).toEqual({ line: 3 })
  })
})
