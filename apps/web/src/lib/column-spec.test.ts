import type { ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { EMPTY_COLUMN, fromColumnDef, retypeColumn, toColumnSpec, validateColumn } from '@/lib/column-spec.ts'

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
      collation: null,
      onUpdate: null,
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

  it('carries the attributes MySQL would drop from a rewritten column', () => {
    const c = def({ extra: 'on update CURRENT_TIMESTAMP(3)', collation: 'latin1_bin' })
    expect(fromColumnDef(c, 'mysql')).toMatchObject({ collation: 'latin1_bin', onUpdate: 'CURRENT_TIMESTAMP(3)' })
    expect(toColumnSpec(fromColumnDef(c, 'mysql'))).toMatchObject({
      collation: 'latin1_bin',
      onUpdate: 'CURRENT_TIMESTAMP(3)',
    })
    // PostgreSQL emits only the clauses that change, so it must not repeat a collation it never asked for.
    expect(fromColumnDef(c, 'postgres')).toMatchObject({ collation: null, onUpdate: null })
  })

  it('drops those attributes when the type changes, and restores them when it changes back', () => {
    const initial = fromColumnDef(
      def({ dataType: 'varchar(50)', extra: 'on update CURRENT_TIMESTAMP', collation: 'latin1_bin' }),
      'mysql'
    )
    // `COLLATE latin1_bin` on a JSON column and `ON UPDATE` on a non-timestamp are both errors.
    expect(retypeColumn(initial, initial, 'JSON')).toMatchObject({
      dataType: 'JSON',
      collation: null,
      onUpdate: null,
    })
    const changed = retypeColumn(initial, initial, 'JSON')
    expect(retypeColumn(changed, initial, ' VARCHAR(50) ')).toMatchObject({
      collation: 'latin1_bin',
      onUpdate: 'CURRENT_TIMESTAMP',
    })
  })
})

describe('validateColumn', () => {
  it('requires name and type', () => {
    expect(validateColumn(EMPTY_COLUMN)).toBe('name')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a' })).toBe('dataType')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a', dataType: 'int' })).toBeNull()
  })
})
