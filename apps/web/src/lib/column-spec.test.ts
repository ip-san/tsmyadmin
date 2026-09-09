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

  it('keeps the collation while the new type can hold it, and drops it when it cannot', () => {
    const initial = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    // Widening a string column is the most common type edit: losing the collation would silently change
    // comparison and ordering (verified against MySQL 8.4).
    for (const t of ['VARCHAR(100)', 'TEXT', 'char(10)', "ENUM('a')", 'CHARACTER VARYING(80)', 'LONG VARCHAR']) {
      expect(retypeColumn(initial, initial, t)).toMatchObject({ collation: 'latin1_bin' })
    }
    for (const t of ['JSON', 'INT', 'DATE', 'BLOB']) {
      expect(retypeColumn(initial, initial, t)).toMatchObject({ collation: null })
    }
  })

  it('steps aside when the user types a collation or charset into the type box', () => {
    const initial = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    // Emitting the carried one too would be "Multiple COLLATE clauses" / a charset mismatch.
    for (const t of ['VARCHAR(100) COLLATE utf8mb4_general_ci', 'VARCHAR(100) CHARACTER SET latin1']) {
      expect(retypeColumn(initial, initial, t)).toMatchObject({ collation: null })
    }
  })

  it('reads the type past comments and string literals the user typed', () => {
    const str = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    expect(retypeColumn(str, str, '/* widen */ VARCHAR(100)')).toMatchObject({ collation: 'latin1_bin' })
    // "collate" inside an ENUM value is data, not a clause.
    expect(retypeColumn(str, str, "ENUM('collate','charset')")).toMatchObject({ collation: 'latin1_bin' })

    const ts = fromColumnDef(def({ dataType: 'timestamp', extra: 'on update CURRENT_TIMESTAMP' }), 'mysql')
    expect(retypeColumn(ts, ts, '/* c */ TIMESTAMP(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
  })

  it('moves a CURRENT_TIMESTAMP default to the new precision as well', () => {
    // MySQL wants the default's precision to match the type too, or the whole MODIFY is rejected.
    const c = fromColumnDef(
      def({
        dataType: 'timestamp',
        default: 'CURRENT_TIMESTAMP',
        extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
      }),
      'mysql'
    )
    expect(retypeColumn(c, c, 'TIMESTAMP(3)')).toMatchObject({
      defaultValue: 'CURRENT_TIMESTAMP(3)',
      onUpdate: 'CURRENT_TIMESTAMP(3)',
    })
    // A default that is not CURRENT_TIMESTAMP is the user's to keep.
    const other = { ...c, defaultValue: 'uuid()' }
    expect(retypeColumn(other, c, 'TIMESTAMP(3)')).toMatchObject({ defaultValue: 'uuid()' })
  })

  it('keeps ON UPDATE only for a timestamp type of the same precision', () => {
    const plain = fromColumnDef(def({ dataType: 'timestamp', extra: 'on update CURRENT_TIMESTAMP' }), 'mysql')
    expect(retypeColumn(plain, plain, 'TIMESTAMP')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
    expect(retypeColumn(plain, plain, 'DATETIME')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
    // The clause follows the new precision instead of being dropped: an updated_at column's whole point.
    expect(retypeColumn(plain, plain, 'TIMESTAMP(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
    // A type typed with a trailing NULL still counts as a timestamp.
    expect(retypeColumn(plain, plain, 'TIMESTAMP(6) NULL')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(6)' })
    expect(retypeColumn(plain, plain, 'VARCHAR(30)')).toMatchObject({ onUpdate: null })

    const fsp = fromColumnDef(def({ dataType: 'datetime(3)', extra: 'on update CURRENT_TIMESTAMP(3)' }), 'mysql')
    expect(retypeColumn(fsp, fsp, 'DATETIME(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
    expect(retypeColumn(fsp, fsp, 'DATETIME')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
  })
})

describe('validateColumn', () => {
  it('requires name and type', () => {
    expect(validateColumn(EMPTY_COLUMN)).toBe('name')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a' })).toBe('dataType')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a', dataType: 'int' })).toBeNull()
  })
})
