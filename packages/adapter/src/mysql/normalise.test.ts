import type { FieldPacket } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { normalise } from './normalise.ts'
import { mysqlColumnMeta } from './values.ts'

type Extra = { flags?: number | undefined; characterSet?: number }
const field = (name: string, columnType: number, extra: Extra = {}) =>
  ({ name, columnType, flags: 0, characterSet: 33, ...extra }) as unknown as FieldPacket
const header = (affectedRows: number) => ({ affectedRows, insertId: 0, fieldCount: 0 })

describe('mysqlColumnMeta: the type name the console shows', () => {
  const type = (columnType: number, extra: Extra = {}) => mysqlColumnMeta(field('c', columnType, extra)).dataType

  it('names the common types, and an unknown one by its number', () => {
    expect(mysqlColumnMeta(field('id', 3))).toEqual({ name: 'id', dataType: 'int' })
    expect(type(1)).toBe('tinyint')
    expect(type(8)).toBe('bigint')
    expect(type(12)).toBe('datetime')
    expect(type(245)).toBe('json')
    expect(type(246)).toBe('decimal')
    expect(type(255)).toBe('geometry')
    expect(type(999)).toBe('type999')
    expect(mysqlColumnMeta({ name: 'x' } as FieldPacket).dataType).toBe('type-1')
  })

  it('adds unsigned to the numeric types that take it, by the flag, and to no other', () => {
    const UNSIGNED = 32
    expect(type(3, { flags: UNSIGNED })).toBe('int unsigned')
    expect(type(8, { flags: UNSIGNED | 1 })).toBe('bigint unsigned')
    expect(type(5, { flags: UNSIGNED })).toBe('double unsigned')
    expect(type(0, { flags: UNSIGNED })).toBe('decimal unsigned')
    expect(type(15, { flags: UNSIGNED })).toBe('varchar')
    expect(type(7, { flags: UNSIGNED })).toBe('timestamp')
    expect(type(3, { flags: 0 })).toBe('int')
    expect(type(3, { flags: undefined })).toBe('int')
  })

  it('names an enum or a set by its flag whatever the column type, and text or binary types by the character set', () => {
    expect(type(254, { flags: 256 })).toBe('enum')
    expect(type(254, { flags: 2048 })).toBe('set')
    expect(type(253, { characterSet: 33 })).toBe('varchar')
    expect(type(253, { characterSet: 63 })).toBe('varbinary')
    expect(type(254, { characterSet: 33 })).toBe('char')
    expect(type(254, { characterSet: 63 })).toBe('binary')
    expect(type(252, { characterSet: 33 })).toBe('text')
    expect(type(252, { characterSet: 63 })).toBe('blob')
    expect(type(249, { characterSet: 33 })).toBe('tinytext')
    expect(type(250, { characterSet: 63 })).toBe('mediumblob')
    expect(type(251, { characterSet: 33 })).toBe('longtext')
    expect(type(251, { characterSet: 63 })).toBe('longblob')
  })
})

describe("normalise: what the driver answered, as the adapter's own result", () => {
  it('reads a write as its affected rows and no columns', () => {
    expect(normalise(header(3), undefined)).toEqual({ columns: [], rows: [], affectedRows: 3, hasRows: false })
  })

  it('reads one result set: its columns, and its rows as wire cells', () => {
    const out = normalise(
      [
        [1, 'a', null],
        [2n, Buffer.from([1]), { k: 1 }],
      ],
      [field('id', 3), field('s', 253), field('n', 253)]
    )
    expect(out).toEqual({
      columns: [
        { name: 'id', dataType: 'int' },
        { name: 's', dataType: 'varchar' },
        { name: 'n', dataType: 'varchar' },
      ],
      rows: [
        [1, 'a', null],
        ['2', { $bin: 'AQ==' }, '{"k":1}'],
      ],
      affectedRows: 0,
      hasRows: true,
    })
  })

  it('reads an empty result set as no rows with its columns, and one without field packets as no columns', () => {
    expect(normalise([], [field('id', 3)])).toEqual({
      columns: [{ name: 'id', dataType: 'int' }],
      rows: [],
      affectedRows: 0,
      hasRows: true,
    })
    expect(normalise([], undefined)).toEqual({ columns: [], rows: [], affectedRows: 0, hasRows: true })
  })

  it('cuts the values to the limits it is given', () => {
    const out = normalise(
      [['abcdef', Buffer.from([1, 2, 3])]],
      [field('a', 253), field('b', 252, { characterSet: 63 })],
      {
        textLimit: 3,
        binaryLimit: 2,
      }
    )
    expect((out as { rows: unknown[][] }).rows).toEqual([[{ $text: 'abc', length: 6 }, { $bin: 'AQI=' }]])
  })

  it('reads several result sets, as many as there are, keeping the writes among them and skipping a set without fields', () => {
    const out = normalise([[[1]], header(5), [[2, 3]], [[9]]], [
      [field('a', 3)],
      [],
      [field('b', 3), field('c', 3)],
    ] as unknown as FieldPacket[][])
    expect(out).toEqual([
      { columns: [{ name: 'a', dataType: 'int' }], rows: [[1]], affectedRows: 0, hasRows: true },
      { columns: [], rows: [], affectedRows: 5, hasRows: false },
      {
        columns: [
          { name: 'b', dataType: 'int' },
          { name: 'c', dataType: 'int' },
        ],
        rows: [[2, 3]],
        affectedRows: 0,
        hasRows: true,
      },
    ])
  })

  it('treats a list of rows as one set when the fields are one list of packets, even if empty', () => {
    expect(Array.isArray(normalise([[1]], [field('a', 3)]))).toBe(false)
    expect(Array.isArray(normalise([[1]], []))).toBe(false)
    expect(Array.isArray(normalise([[[1]]], [[field('a', 3)]] as unknown as FieldPacket[][]))).toBe(true)
  })
})

describe('normalise: sets and fields that do not line up', () => {
  it('reads as many sets as there are rows, ignoring a field list beyond them', () => {
    const out = normalise([[[1]]], [[field('a', 3)], [field('b', 3)]] as unknown as FieldPacket[][])
    expect(out).toEqual([{ columns: [{ name: 'a', dataType: 'int' }], rows: [[1]], affectedRows: 0, hasRows: true }])
  })

  it('takes only an object that has affectedRows for a write', () => {
    const odd = normalise([[1]], [field('a', 3)])
    expect((odd as { hasRows: boolean }).hasRows).toBe(true)
    expect(normalise({ affectedRows: 0 }, undefined)).toEqual({
      columns: [],
      rows: [],
      affectedRows: 0,
      hasRows: false,
    })
  })
})
