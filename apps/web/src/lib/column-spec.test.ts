import type { ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { EMPTY_COLUMN, fromColumnDef, toColumnSpec, validateColumn } from '@/lib/column-spec.ts'

const def = (over: Partial<ColumnDef>): ColumnDef => ({
  name: 'c',
  dataType: 'int',
  nullable: true,
  default: null,
  extra: '',
  comment: null,
  collation: null,
  ...over,
})

describe('toColumnSpec', () => {
  it('maps default kinds and trims', () => {
    expect(toColumnSpec({ ...EMPTY_COLUMN, name: ' n ', dataType: ' INT ', comment: ' ' })).toEqual({
      name: 'n',
      dataType: 'INT',
      nullable: true,
      default: null,
      autoIncrement: false,
      comment: null,
    })
    expect(
      toColumnSpec({ ...EMPTY_COLUMN, name: 'n', dataType: 'x', defaultKind: 'literal', defaultValue: "it's" }).default
    ).toEqual({
      kind: 'literal',
      value: "it's",
    })
    expect(
      toColumnSpec({ ...EMPTY_COLUMN, name: 'n', dataType: 'x', defaultKind: 'expression', defaultValue: 'now()' })
        .default
    ).toEqual({
      kind: 'expression',
      sql: 'now()',
    })
  })
})

describe('fromColumnDef', () => {
  it('treats MySQL plain defaults as literals and generated ones as expressions', () => {
    expect(fromColumnDef(def({ default: 'x' }), 'mysql')).toMatchObject({ defaultKind: 'literal', defaultValue: 'x' })
    expect(fromColumnDef(def({ default: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED' }), 'mysql')).toMatchObject({
      defaultKind: 'expression',
    })
  })

  it('keeps PostgreSQL defaults as raw expressions and detects identity/serial', () => {
    expect(fromColumnDef(def({ default: "'x'::text" }), 'postgres')).toMatchObject({
      defaultKind: 'expression',
      defaultValue: "'x'::text",
    })
    expect(fromColumnDef(def({ default: "nextval('s'::regclass)", extra: 'serial' }), 'postgres')).toMatchObject({
      autoIncrement: true,
      defaultKind: 'none',
    })
    expect(fromColumnDef(def({ extra: 'auto_increment' }), 'mysql').autoIncrement).toBe(true)
  })
})

describe('validateColumn', () => {
  it('requires name and type', () => {
    expect(validateColumn(EMPTY_COLUMN)).toBe('name')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a' })).toBe('dataType')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a', dataType: 'int' })).toBeNull()
  })
})
