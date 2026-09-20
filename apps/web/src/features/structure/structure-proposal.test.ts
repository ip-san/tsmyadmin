import type { ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { proposeTypes } from './structure-proposal.ts'

const col = (name: string, dataType: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  dataType,
  nullable: true,
  default: null,
  defaultIsExpression: false,
  extra: '',
  comment: null,
  collation: null,
  check: null,
  generated: null,
  ...extra,
})

describe('proposeTypes', () => {
  const columns = [col('code', 'varchar(255)'), col('born', 'varchar(10)'), col('name', 'varchar(50)'), col('n', 'int')]
  const names = ['code', 'born', 'name', 'n']

  it('proposes the narrowest type the values of a text column fit, and leaves the others', () => {
    const rows = [
      ['1', '2020-01-31', 'Ann', 5],
      ['22', '1999-12-01', 'Bo', 6],
      [null, '2001-02-03', null, 7],
    ]
    expect(proposeTypes(columns, names, rows, 'mysql')).toEqual([
      { column: 'code', from: 'varchar(255)', to: 'INT', kind: 'int' },
      { column: 'born', from: 'varchar(10)', to: 'DATE', kind: 'date' },
    ])
  })

  it('proposes a decimal with the digits seen, and TIMESTAMP for PostgreSQL date-times', () => {
    const rows = [
      ['1.50', '2020-01-31 10:00:00'],
      ['12.5', '2020-02-01 11:30:00'],
    ]
    const cols = [col('price', 'text'), col('at', 'character varying')]
    expect(proposeTypes(cols, ['price', 'at'], rows, 'postgres').map((p) => p.to)).toEqual([
      'DECIMAL(4,2)',
      'TIMESTAMP',
    ])
  })

  it('proposes nothing for a column with no value, a mixed one, or one that counts by itself', () => {
    const rows = [
      [null, '1', 'x'],
      [null, 'a', 'y'],
    ]
    const cols = [
      col('empty', 'varchar(9)'),
      col('mixed', 'varchar(9)'),
      col('id', 'varchar(9)', { extra: 'auto_increment' }),
    ]
    expect(proposeTypes(cols, ['empty', 'mixed', 'id'], rows, 'mysql')).toEqual([])
  })
})
