import type { Cell, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { normalizationHints } from './normalization.ts'

function table(columns: [string, string][], extra: Partial<TableSchema> = {}): TableSchema {
  return {
    name: 'orders',
    kind: 'table',
    comment: null,
    engine: null,
    rowEstimate: null,
    partitioned: false,
    hasChildren: false,
    inherits: [],
    collation: null,
    columns: columns.map(([name, dataType]) => ({
      name,
      dataType,
      nullable: true,
      default: null,
      defaultIsExpression: false,
      extra: '',
      comment: null,
      collation: null,
    })),
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    referencedBy: [],
    ...extra,
  } as TableSchema
}

const kinds = (hints: { kind: string }[]) => hints.map((h) => h.kind)

describe('normalization hints', () => {
  it('flags a missing primary key and numbered copies of one column', () => {
    const t = table(
      [
        ['phone1', 'varchar(20)'],
        ['phone2', 'varchar(20)'],
        ['addr_1', 'text'],
        ['addr_2', 'text'],
        ['md5', 'char(32)'],
      ],
      { primaryKey: [] }
    )
    expect(normalizationHints(t, [], null)).toEqual([
      { kind: 'noPrimaryKey' },
      { kind: 'repeatingGroup', columns: ['phone1', 'phone2'] },
      { kind: 'repeatingGroup', columns: ['addr_1', 'addr_2'] },
    ])
  })

  it('finds lists in one value, but not sentences with a comma', () => {
    const t = table([
      ['id', 'int'],
      ['tags', 'varchar(100)'],
      ['note', 'text'],
    ])
    const rows: Cell[][] = [
      [1, 'red,green', 'Hello, this is a longer sentence here'],
      [2, 'blue; red', 'Plain'],
      [3, 'a|b|c', 'Another note, with words that go on'],
      [4, 'solo', null],
    ]
    expect(normalizationHints(t, [], { columns: ['id', 'tags', 'note'], rows })).toEqual([
      { kind: 'listValues', column: 'tags', count: 3 },
    ])
  })

  it('suggests a foreign key where a table of that name exists and none is declared', () => {
    const t = table(
      [
        ['id', 'int'],
        ['customer_id', 'int'],
        ['categoryId', 'int'],
        ['user_id', 'int'],
        ['paid', 'int'],
        ['grid', 'int'],
      ],
      { foreignKeys: [{ name: 'fk', columns: ['user_id'] } as TableSchema['foreignKeys'][number]] }
    )
    // `pa` and `gr` tables exist, yet paid and grid are words, not references.
    expect(normalizationHints(t, ['customers', 'categories', 'users', 'orders', 'pas', 'gr'], null)).toEqual([
      { kind: 'missingForeignKey', column: 'customer_id', table: 'customers' },
      { kind: 'missingForeignKey', column: 'categoryId', table: 'categories' },
    ])
  })

  it('reads a partial and a transitive dependency from enough rows', () => {
    const t = table(
      [
        ['order_id', 'int'],
        ['line', 'int'],
        ['order_date', 'date'],
        ['zip', 'varchar(8)'],
        ['city', 'varchar(20)'],
        ['qty', 'int'],
      ],
      { primaryKey: ['order_id', 'line'] }
    )
    const rows: Cell[][] = []
    for (let i = 0; i < 24; i++) {
      const order = Math.floor(i / 3)
      const zip = ['100', '200', '300'][i % 3] ?? ''
      rows.push([order, i % 3, `2026-01-0${(order % 9) + 1}`, zip, `city-${zip}`, i])
    }
    const columns = ['order_id', 'line', 'order_date', 'zip', 'city', 'qty']
    const hints = normalizationHints(t, [], { columns, rows })
    expect(hints).toContainEqual({ kind: 'partialDependency', key: 'order_id', column: 'order_date' })
    // zip and city decide each other: one hint for the pair, not two.
    expect(hints.filter((h) => h.kind === 'transitiveDependency')).toEqual([
      { kind: 'transitiveDependency', from: 'city', column: 'zip' },
    ])
    // A column with every value different (qty) decides everything, and is not reported.
    expect(hints.some((h) => 'from' in h && h.from === 'qty')).toBe(false)
    // Two-valued columns that happen to line up (every admin on the light theme) are chance, not a dependency.
    const flags = table([
      ['id', 'int'],
      ['is_admin', 'boolean'],
      ['theme', 'varchar(5)'],
    ])
    const flagRows: Cell[][] = Array.from({ length: 24 }, (_, i) => [i, i % 2 === 0, i % 2 === 0 ? 'light' : 'dark'])
    expect(normalizationHints(flags, [], { columns: ['id', 'is_admin', 'theme'], rows: flagRows })).toEqual([])
    // Too few rows: nothing is read from the values.
    expect(kinds(normalizationHints(t, [], { columns, rows: rows.slice(0, 10) }))).toEqual([])
  })
})
