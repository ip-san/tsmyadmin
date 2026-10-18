import { describe, expect, it } from 'vitest'
import { column, fk, inShop, table } from '@/test/schema-fixtures.ts'
import { comparedType, keyTypeMismatches, nameTypeMismatches, typeKind } from './type-mismatches.ts'

const users = (idType: string, over: Parameters<typeof column>[2] = {}) =>
  table('users', { columns: [column('id', idType, over)] })
const orders = (userIdType: string, over: Parameters<typeof column>[2] = {}) =>
  table('orders', {
    columns: [column('id', 'int'), column('user_id', userIdType, over)],
    foreignKeys: [fk(['user_id'], 'users')],
  })

describe('comparedType', () => {
  it('leaves out lengths, precisions and display widths, and case', () => {
    expect(comparedType('INT(11)')).toBe('int')
    expect(comparedType('varchar(20)')).toBe('varchar')
    expect(comparedType('decimal(10,2)')).toBe('decimal')
    expect(comparedType(' tinyint(1) ')).toBe('tinyint')
  })

  it('names a type by one of its names on either server, keeping unsigned apart', () => {
    expect(comparedType('character varying(20)')).toBe('varchar')
    expect(comparedType('integer')).toBe('int')
    expect(comparedType('numeric(12,2)')).toBe('decimal')
    expect(comparedType('timestamp(3) with time zone')).toBe('timestamptz')
    expect(comparedType('bigint(20) unsigned')).toBe('bigint unsigned')
    expect(comparedType('int unsigned zerofill')).toBe('int unsigned zerofill')
    expect(comparedType('integer zerofill')).toBe('int zerofill')
    expect(comparedType('integer unsigned zerofill')).toBe('int unsigned zerofill')
    // Spaced twice, as a type may be written: still one name.
    expect(comparedType('double  precision')).toBe('double')
    expect(typeKind('integer zerofill')).toBe('integer')
    expect(comparedType('integer[]')).toBe('integer[]')
  })
})

describe('typeKind', () => {
  it('puts integers of every width, signed or not, in one kind, and text of every length in another', () => {
    const integers = [
      'tinyint(1)',
      'int',
      'integer',
      'bigint unsigned',
      'int8',
      'serial',
      'int(10) unsigned zerofill',
      'int zerofill',
    ]
    expect(integers.map(typeKind)).toEqual(integers.map(() => 'integer'))
    expect(['varchar(8)', 'character varying(20)', 'text', 'char(2)', 'longtext'].map(typeKind)).toEqual(
      Array(5).fill('text')
    )
  })

  it("keeps PostgreSQL's blank-padded character apart from text, not MySQL's char", () => {
    expect(['character(2)', 'CHARACTER', 'bpchar'].map(typeKind)).toEqual(['bpchar', 'bpchar', 'bpchar'])
    expect(typeKind('character varying(2)')).toBe('text')
    expect(typeKind('char(2)')).toBe('text')
    expect(['double precision', 'real', 'float'].map(typeKind)).toEqual(['float', 'float', 'float'])
  })

  it('takes a kind by the whole name, not by how it starts or ends', () => {
    // Arrays, a geometric type, domains: their names only start or end like a kind's.
    for (const type of ['integer[]', 'text[]', 'double precision[]', 'point', 'richtext', 'cereal', 'my_character'])
      expect(typeKind(type)).toBe(type)
    expect(typeKind(' character(2)')).toBe('bpchar')
  })

  it('keeps every other type a kind of its own', () => {
    expect(typeKind('numeric(10,0)')).toBe('decimal')
    expect(typeKind('uuid')).toBe('uuid')
    expect(typeKind('date')).toBe('date')
  })
})

describe('keyTypeMismatches', () => {
  it('names a key column of another kind of type than the column it refers to', () => {
    expect(keyTypeMismatches([users('integer'), orders('numeric(10,0)')], inShop)).toEqual([
      {
        table: 'orders',
        key: 'fk_users',
        column: 'user_id',
        type: 'numeric(10,0)',
        refTable: 'users',
        refColumn: 'id',
        refType: 'integer',
        collations: null,
      },
    ])
  })

  it('takes types of one kind for one: a width, a length, a sign, a name', () => {
    expect(keyTypeMismatches([users('int(11)'), orders('BIGINT unsigned')], inShop)).toEqual([])
    expect(keyTypeMismatches([users('varchar(10)'), orders('character varying(255)')], inShop)).toEqual([])
    expect(keyTypeMismatches([users('text'), orders('varchar(20)')], inShop)).toEqual([])
  })

  it('names the keys of the tables in order of their names', () => {
    const second = table('zorders', { columns: [column('user_id', 'text')], foreignKeys: [fk(['user_id'], 'users')] })
    const first = table('aorders', { columns: [column('user_id', 'text')], foreignKeys: [fk(['user_id'], 'users')] })
    expect(keyTypeMismatches([users('int'), second, first], inShop).map((m) => m.table)).toEqual(['aorders', 'zorders'])
  })

  it('names a key column of another collation, and not one with no collation known on a side', () => {
    const text = (collation: string | null) => ({ collation })
    const differ = keyTypeMismatches(
      [users('varchar(20)', text('utf8mb4_bin')), orders('varchar(20)', text('utf8mb4_general_ci'))],
      inShop
    )
    expect(differ.map((m) => m.collations)).toEqual([{ from: 'utf8mb4_general_ci', to: 'utf8mb4_bin' }])
    expect(
      keyTypeMismatches([users('varchar(20)', text(null)), orders('varchar(20)', text('utf8mb4_bin'))], inShop)
    ).toEqual([])
    expect(
      keyTypeMismatches([users('varchar(20)', text('utf8mb4_bin')), orders('varchar(20)', text(null))], inShop)
    ).toEqual([])
    expect(
      keyTypeMismatches([users('varchar(20)', text('utf8mb4_bin')), orders('varchar(20)', text('utf8mb4_bin'))], inShop)
    ).toEqual([])
  })

  it('compares each column of a key of two with the column it refers to', () => {
    const pairs = table('pairs', { columns: [column('a', 'int'), column('b', 'int')] })
    const refs = table('refs', {
      columns: [column('x', 'bigint'), column('y', 'text')],
      foreignKeys: [fk(['x', 'y'], 'pairs', { refColumns: ['a', 'b'] })],
    })
    expect(keyTypeMismatches([pairs, refs], inShop).map((m) => [m.column, m.refColumn])).toEqual([['y', 'b']])
  })

  it('does not compare keys into another namespace, to a table not read, or to a column not found', () => {
    const elsewhere = table('orders', {
      columns: [column('user_id', 'text')],
      foreignKeys: [fk(['user_id'], 'users', { refNamespace: { database: 'archive' } })],
    })
    expect(keyTypeMismatches([users('integer'), elsewhere], inShop)).toEqual([])
    expect(keyTypeMismatches([orders('text')], inShop)).toEqual([])
    const noColumn = table('orders', { foreignKeys: [fk(['user_id'], 'users')] })
    expect(keyTypeMismatches([users('integer'), noColumn], inShop)).toEqual([])
  })

  it('does not look at views', () => {
    const view = { ...orders('text'), kind: 'view' as const }
    expect(keyTypeMismatches([users('integer'), view], inShop)).toEqual([])
  })
})

describe('nameTypeMismatches', () => {
  it('names an _id column of two types, the type most tables give first, tables by name', () => {
    const map = nameTypeMismatches([
      table('posts', { columns: [column('user_id', 'bigint')] }),
      table('comments', { columns: [column('user_id', 'bigint')] }),
      table('logs', { columns: [column('user_id', 'INT(11)')] }),
      table('tags', { columns: [column('tag_id', 'int'), column('name', 'text')] }),
    ])
    expect(map).toEqual([
      {
        column: 'user_id',
        types: [
          { type: 'bigint', tables: ['comments', 'posts'] },
          { type: 'int', tables: ['logs'] },
        ],
      },
    ])
  })

  it('takes types that differ only in length, width or case for one, and names ties by type', () => {
    expect(
      nameTypeMismatches([
        table('a', { columns: [column('session_id', 'varchar(64)')] }),
        table('b', { columns: [column('session_id', 'character varying(128)')] }),
      ])
    ).toEqual([])
    expect(
      nameTypeMismatches([
        table('a', { columns: [column('x_id', 'INT')] }),
        table('b', { columns: [column('x_id', 'int(11)')] }),
      ])
    ).toEqual([])
    const tie = nameTypeMismatches([
      table('a', { columns: [column('x_id', 'uuid')] }),
      table('b', { columns: [column('x_id', 'bigint')] }),
    ])
    expect(tie[0]?.types.map((x) => x.type)).toEqual(['bigint', 'uuid'])
  })

  it('tells a signed from an unsigned integer, and an int from a bigint', () => {
    const map = nameTypeMismatches([
      table('a', { columns: [column('x_id', 'int')] }),
      table('b', { columns: [column('x_id', 'int unsigned')] }),
      table('c', { columns: [column('y_id', 'int')] }),
      table('d', { columns: [column('y_id', 'bigint')] }),
    ])
    expect(map.map((m) => m.types.map((x) => x.type))).toEqual([
      ['int', 'int unsigned'],
      ['bigint', 'int'],
    ])
  })

  it('looks only at names ending in _id (in any case), of tables, sorted by name', () => {
    const map = nameTypeMismatches([
      table('a', { columns: [column('name', 'text'), column('Owner_ID', 'int'), column('b_id', 'int')] }),
      table('b', { columns: [column('name', 'varchar(20)'), column('Owner_ID', 'bigint'), column('b_id', 'bigint')] }),
      table('v', { kind: 'view', columns: [column('c_id', 'int')] }),
      table('w', { kind: 'view', columns: [column('c_id', 'bigint')] }),
    ])
    expect(map.map((m) => m.column)).toEqual(['b_id', 'Owner_ID'])
  })
})
