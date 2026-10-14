import type { CentralColumnBody, ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  type ColumnFormValues,
  defaultArgs,
  EMPTY_COLUMN,
  fromCentralColumn,
  fromColumnDef,
  retypeColumn,
  retypeName,
  splitType,
  TYPE_NAMES,
  toColumnSpec,
  validateColumn,
} from '@/lib/column-spec.ts'

/**
 * How a column is written down from the form and read back: the type split into name and rest, the invisible parts
 * that travel with it, and what a new type does to them. MySQL rewrites the whole column on every change, so each
 * of these is a part of a definition that could silently be lost (the edge cases were found by mutation testing).
 */

const def = (over: Partial<ColumnDef> = {}): ColumnDef => ({
  name: 'c',
  dataType: 'int',
  nullable: true,
  default: null,
  defaultIsExpression: false,
  extra: '',
  comment: null,
  collation: null,
  check: null,
  generated: null,
  ...over,
})

const form = (extra: Partial<ColumnFormValues> = {}): ColumnFormValues => ({
  ...EMPTY_COLUMN,
  name: 'c',
  dataType: 'INT',
  ...extra,
})

const central = (extra: Partial<CentralColumnBody> = {}): CentralColumnBody => ({
  database: 'shop',
  name: 'created_at',
  dataType: 'datetime',
  nullable: false,
  default: null,
  defaultIsExpression: false,
  comment: 'when',
  ...extra,
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
      check: null,
      generated: null,
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

  it('writes a default as nothing, a literal or an expression, the text untrimmed; a comment as typed or none', () => {
    expect(toColumnSpec(form({ defaultKind: 'none', defaultValue: 'ignored' })).default).toBeNull()
    expect(toColumnSpec(form({ defaultKind: 'literal', defaultValue: ' x ' })).default).toEqual({
      kind: 'literal',
      value: ' x ',
    })
    expect(toColumnSpec(form({ comment: '' })).comment).toBeNull()
    expect(toColumnSpec(form({ comment: ' kept as typed ' })).comment).toBe(' kept as typed ')
    expect(toColumnSpec(form({ nullable: false, autoIncrement: true }))).toMatchObject({
      nullable: false,
      autoIncrement: true,
    })
  })

  it('carries the parts the form does not show', () => {
    const spec = toColumnSpec(form({ collation: 'utf8mb4_bin', onUpdate: 'CURRENT_TIMESTAMP', check: 'c > 0' }))
    expect(spec).toMatchObject({
      collation: 'utf8mb4_bin',
      onUpdate: 'CURRENT_TIMESTAMP',
      check: 'c > 0',
      generated: null,
    })
  })

  it('gives a generated column no default, identity or ON UPDATE of its own, and the expression trimmed', () => {
    const spec = toColumnSpec(
      form({
        name: ' g ',
        dataType: ' INT ',
        nullable: false,
        defaultKind: 'literal',
        defaultValue: '1',
        autoIncrement: true,
        onUpdate: 'CURRENT_TIMESTAMP',
        collation: 'utf8mb4_bin',
        check: 'g > 0',
        comment: 'note',
        generated: { expression: '  a + 1 ', stored: true },
      })
    )
    expect(spec).toEqual({
      name: 'g',
      dataType: 'INT',
      nullable: false,
      default: null,
      autoIncrement: false,
      comment: 'note',
      collation: 'utf8mb4_bin',
      onUpdate: null,
      check: 'g > 0',
      generated: { expression: 'a + 1', stored: true },
    })
    expect(toColumnSpec(form({ comment: '   ', generated: { expression: 'a', stored: false } }))).toMatchObject({
      comment: null,
      generated: { expression: 'a', stored: false },
    })
  })
})

describe('fromColumnDef', () => {
  it('follows the catalog on whether a default is a literal or an expression', () => {
    // The dialects report this differently; the adapter normalises it, so the form just reads the flag.
    expect(fromColumnDef(def({ default: 'x' }), 'mysql')).toMatchObject({ defaultKind: 'literal', defaultValue: 'x' })
    expect(fromColumnDef(def({ default: 'CURRENT_TIMESTAMP', defaultIsExpression: true }), 'mysql')).toMatchObject({
      defaultKind: 'expression',
    })
    expect(fromColumnDef(def({ default: null }), 'mysql')).toMatchObject({ defaultKind: 'none', defaultValue: '' })
    expect(fromColumnDef(def({ default: '' }), 'mysql')).toMatchObject({ defaultKind: 'literal', defaultValue: '' })
  })

  it('keeps PostgreSQL defaults as raw expressions and detects identity/serial', () => {
    expect(fromColumnDef(def({ default: "'x'::text", defaultIsExpression: true }), 'postgres')).toMatchObject({
      defaultKind: 'expression',
      defaultValue: "'x'::text",
    })
    expect(fromColumnDef(def({ default: "nextval('s'::regclass)", extra: 'serial' }), 'postgres')).toMatchObject({
      autoIncrement: true,
      defaultKind: 'none',
    })
    expect(fromColumnDef(def({ extra: 'auto_increment' }), 'mysql').autoIncrement).toBe(true)
  })

  it('reads no default for an identity, serial or generated column, whatever the catalog printed', () => {
    for (const extra of ['auto_increment', 'identity by default', 'identity always', 'serial']) {
      expect(fromColumnDef(def({ default: '5', extra }), 'mysql'), extra).toMatchObject({
        defaultKind: 'none',
        defaultValue: '',
        autoIncrement: true,
      })
    }
    expect(
      fromColumnDef(
        def({ default: 'a + 1', defaultIsExpression: true, generated: { expression: 'a + 1', stored: true } }),
        'postgres'
      )
    ).toMatchObject({
      defaultKind: 'none',
      defaultValue: '',
      generated: { expression: 'a + 1', stored: true },
    })
  })

  it('carries the type, nullability, comment, collation and check, a missing comment being empty', () => {
    expect(
      fromColumnDef(
        def({ nullable: false, comment: 'note', collation: 'utf8mb4_bin', check: 'c > 0', dataType: 'varchar(9)' }),
        'postgres'
      )
    ).toMatchObject({
      name: 'c',
      dataType: 'varchar(9)',
      nullable: false,
      comment: 'note',
      collation: 'utf8mb4_bin',
      check: 'c > 0',
    })
    expect(fromColumnDef(def({ comment: null }), 'mysql').comment).toBe('')
  })

  it('carries the attributes MySQL would drop from a rewritten column', () => {
    const c = def({ extra: 'on update CURRENT_TIMESTAMP(3)', collation: 'latin1_bin' })
    expect(fromColumnDef(c, 'mysql')).toMatchObject({ collation: 'latin1_bin', onUpdate: 'CURRENT_TIMESTAMP(3)' })
    expect(toColumnSpec(fromColumnDef(c, 'mysql'))).toMatchObject({
      collation: 'latin1_bin',
      onUpdate: 'CURRENT_TIMESTAMP(3)',
    })
    // PostgreSQL carries the collation too (it can be changed there), but emits it only when it differs from the
    // current definition; ON UPDATE is MySQL's alone.
    expect(fromColumnDef(c, 'postgres')).toMatchObject({ collation: 'latin1_bin', onUpdate: null })
    expect(fromColumnDef(def(), 'mysql').onUpdate).toBeNull()
  })

  it('keeps the collation while the new type can hold it, and drops it when it cannot', () => {
    const initial = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    // Widening a string column is the most common type edit: losing the collation would silently change
    // comparison and ordering (verified against MySQL 8.4).
    for (const t of [
      'VARCHAR(100)',
      'TEXT',
      'char(10)',
      "ENUM('a')",
      "SET('a')",
      'CHARACTER VARYING(80)',
      'CHARACTER(5)',
      'LONG VARCHAR',
      'long',
      'LONGTEXT',
      'tinytext',
    ]) {
      expect(retypeColumn(initial, initial, t), t).toMatchObject({ collation: 'latin1_bin' })
    }
    for (const t of [
      'JSON',
      'INT',
      'DATE',
      'DATETIME',
      'BLOB',
      'NVARCHAR(5)',
      'NATIONAL VARCHAR(5)',
      'VARCHARX',
      'XVARCHAR',
    ]) {
      expect(retypeColumn(initial, initial, t), t).toMatchObject({ collation: null })
    }
  })

  it("goes back to the first collation when the form's was dropped, and to none when there was none", () => {
    const initial = fromColumnDef(def({ dataType: 'int', collation: 'latin1_bin' }), 'mysql')
    expect(retypeColumn({ ...initial, collation: null }, initial, 'VARCHAR(5)')).toMatchObject({
      collation: 'latin1_bin',
    })
    const none = fromColumnDef(def({ dataType: 'int' }), 'mysql')
    expect(retypeColumn({ ...none, collation: null }, none, 'VARCHAR(5)')).toMatchObject({ collation: null })
  })

  it('steps aside when the user types a collation or charset into the type box', () => {
    const initial = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    // Emitting the carried one too would be "Multiple COLLATE clauses" / a charset mismatch.
    for (const t of [
      'VARCHAR(100) COLLATE utf8mb4_general_ci',
      'varchar(5) collate x',
      'VARCHAR(100) CHARACTER SET latin1',
      'VARCHAR(5) CHARSET latin1',
      'VARCHAR(5) character  set x',
    ]) {
      expect(retypeColumn(initial, initial, t), t).toMatchObject({ collation: null })
    }
    // A longer word is another word.
    expect(retypeColumn(initial, initial, 'VARCHAR(5) COLLATEX')).toMatchObject({ collation: 'latin1_bin' })
  })

  it('reads the type past comments and string literals the user typed', () => {
    const str = fromColumnDef(def({ dataType: 'varchar(50)', collation: 'latin1_bin' }), 'mysql')
    // "collate" inside an ENUM value, a comment or an unclosed run is data, not a clause.
    for (const t of [
      '/* widen */ VARCHAR(100)',
      '/* COLLATE */ VARCHAR(100)',
      "/**/ENUM('x')",
      "ENUM('collate','charset')",
      'ENUM("collate")',
      "ENUM('it''s collate')",
      "ENUM('a\\' collate')",
      'ENUM(`collate`)',
      'VARCHAR(5) /* COLLATE never closed',
      "VARCHAR(5) 'unclosed COLLATE",
    ]) {
      expect(retypeColumn(str, str, t), t).toMatchObject({ collation: 'latin1_bin' })
    }
    for (const t of ["ENUM('a') COLLATE utf8mb4_bin", 'VARCHAR(5) /* x */ COLLATE y', 'a / b VARCHAR']) {
      expect(retypeColumn(str, str, t), t).toMatchObject({ collation: null })
    }

    const ts = fromColumnDef(def({ dataType: 'timestamp', extra: 'on update CURRENT_TIMESTAMP' }), 'mysql')
    expect(retypeColumn(ts, ts, '/* c */ TIMESTAMP(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
  })

  it('moves a CURRENT_TIMESTAMP default to the new precision as well', () => {
    // MySQL wants the default's precision to match the type too, or the whole MODIFY is rejected.
    const c = fromColumnDef(
      def({
        dataType: 'timestamp',
        default: 'CURRENT_TIMESTAMP',
        defaultIsExpression: true,
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

  it('moves only an expression default that is CURRENT_TIMESTAMP alone, in any case, with its blanks', () => {
    const exp = (defaultValue: string, dataType = 'TIMESTAMP(3)', extra: Partial<ColumnFormValues> = {}) =>
      retypeColumn(form({ defaultKind: 'expression', defaultValue, ...extra }), form(), dataType).defaultValue
    expect(exp('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP(3)')
    expect(exp(' current_timestamp(6) ')).toBe('CURRENT_TIMESTAMP(3)')
    expect(exp('CURRENT_TIMESTAMP(3)', 'DATETIME')).toBe('CURRENT_TIMESTAMP')
    expect(exp('NOW()')).toBe('NOW()')
    expect(exp('CURRENT_TIMESTAMP + 1')).toBe('CURRENT_TIMESTAMP + 1')
    expect(exp('CURRENT_TIMESTAMP', 'INT')).toBe('CURRENT_TIMESTAMP')
    expect(exp('CURRENT_TIMESTAMP', 'TIMESTAMP(3)', { defaultKind: 'literal' })).toBe('CURRENT_TIMESTAMP')
    expect(exp('CURRENT_TIMESTAMP', 'TIMESTAMP(3)', { defaultKind: 'none' })).toBe('CURRENT_TIMESTAMP')
  })

  it('never invents an ON UPDATE on a column that had none', () => {
    const plain = fromColumnDef(def({ dataType: 'varchar(20)' }), 'mysql')
    expect(retypeColumn(plain, plain, 'TIMESTAMP')).toMatchObject({ onUpdate: null })
    expect(retypeColumn(plain, plain, 'DATETIME(3)')).toMatchObject({ onUpdate: null })
  })

  it('carries the column CHECK and the existing comment into the form', () => {
    // MODIFY COLUMN replaces the whole definition: whatever the form does not carry is dropped.
    const c = def({ check: '`c` > 0', comment: 'kept' })
    expect(fromColumnDef(c, 'mysql')).toMatchObject({ check: '`c` > 0', comment: 'kept' })
    expect(toColumnSpec(fromColumnDef(c, 'mysql'))).toMatchObject({ check: '`c` > 0', comment: 'kept' })
  })

  it('keeps ON UPDATE only for a timestamp type of the same precision', () => {
    const plain = fromColumnDef(def({ dataType: 'timestamp', extra: 'on update CURRENT_TIMESTAMP' }), 'mysql')
    expect(retypeColumn(plain, plain, 'TIMESTAMP')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
    expect(retypeColumn(plain, plain, 'DATETIME')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
    // The clause follows the new precision instead of being dropped: an updated_at column's whole point.
    expect(retypeColumn(plain, plain, 'TIMESTAMP(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
    expect(retypeColumn(plain, plain, 'DATETIME (2)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(2)' })
    // A type typed with a trailing NULL still counts as a timestamp.
    expect(retypeColumn(plain, plain, 'TIMESTAMP(6) NULL')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(6)' })
    expect(retypeColumn(plain, plain, 'VARCHAR(30)')).toMatchObject({ onUpdate: null })
    expect(retypeColumn(plain, plain, 'DATE')).toMatchObject({ onUpdate: null })

    const fsp = fromColumnDef(def({ dataType: 'datetime(3)', extra: 'on update CURRENT_TIMESTAMP(3)' }), 'mysql')
    expect(retypeColumn(fsp, fsp, 'DATETIME(3)')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP(3)' })
    expect(retypeColumn(fsp, fsp, 'DATETIME')).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
  })

  it('keeps the rest of the form and sets the new type', () => {
    const out = retypeColumn(form({ name: 'x', comment: 'k', nullable: false }), form(), 'BIGINT')
    expect(out).toMatchObject({ name: 'x', comment: 'k', nullable: false, dataType: 'BIGINT' })
  })
})

describe('validateColumn', () => {
  it('names the first thing missing: the name, then the type, then a generated expression', () => {
    expect(validateColumn(EMPTY_COLUMN)).toBe('name')
    expect(validateColumn(form({ name: '   ' }))).toBe('name')
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a' })).toBe('dataType')
    expect(validateColumn(form({ dataType: '  ' }))).toBe('dataType')
    expect(validateColumn(form({ generated: { expression: '   ', stored: false } }))).toBe('generated')
    expect(validateColumn(form({ generated: { expression: 'a', stored: true } }))).toBeNull()
    expect(validateColumn({ ...EMPTY_COLUMN, name: 'a', dataType: 'int' })).toBeNull()
    expect(validateColumn(form({ name: ' c ', dataType: ' INT ' }))).toBeNull()
  })

  it('starts a new column from a central column, its default kind included', () => {
    expect(fromCentralColumn(central({ default: 'CURRENT_TIMESTAMP', defaultIsExpression: true }))).toEqual({
      ...EMPTY_COLUMN,
      name: 'created_at',
      dataType: 'datetime',
      nullable: false,
      defaultKind: 'expression',
      defaultValue: 'CURRENT_TIMESTAMP',
      comment: 'when',
    })
    expect(fromCentralColumn(central({ default: 'new' })).defaultKind).toBe('literal')
    expect(fromCentralColumn(central({ default: '' }))).toMatchObject({ defaultKind: 'literal', defaultValue: '' })
    expect(fromCentralColumn(central()).defaultKind).toBe('none')
  })
})

describe('splitType / retypeName', () => {
  it('splits a listed name from its arguments whatever the casing, longest name first', () => {
    expect(splitType('mysql', 'varchar(255)')).toEqual({ base: 'VARCHAR', rest: '(255)' })
    expect(splitType('mysql', 'int unsigned')).toEqual({ base: 'INT', rest: ' unsigned' })
    expect(splitType('mysql', 'BIGINT')).toEqual({ base: 'BIGINT', rest: '' })
    expect(splitType('mysql', 'DOUBLE PRECISION')).toEqual({ base: 'DOUBLE PRECISION', rest: '' })
    expect(splitType('mysql', 'double precision(10)')).toEqual({ base: 'DOUBLE PRECISION', rest: '(10)' })
    expect(splitType('mysql', 'double(10,2)')).toEqual({ base: 'DOUBLE', rest: '(10,2)' })
    expect(splitType('postgres', 'timestamp with time zone')).toEqual({ base: 'timestamp with time zone', rest: '' })
    expect(splitType('postgres', 'timestamp(3) with time zone')).toEqual({
      base: 'timestamp',
      rest: '(3) with time zone',
    })
    expect(splitType('postgres', 'integer[]')).toEqual({ base: 'integer', rest: '[]' })
  })

  it('drops the blanks before the type and not after, and takes a longer word for another type', () => {
    expect(splitType('mysql', '  INT(11)')).toEqual({ base: 'INT', rest: '(11)' })
    expect(splitType('mysql', 'INT  ')).toEqual({ base: 'INT', rest: '  ' })
    expect(splitType('mysql', 'INTEGERS')).toEqual({ base: 'INTEGERS', rest: '' })
    expect(splitType('mysql', 'INT_X(3)')).toEqual({ base: 'INT_X', rest: '(3)' })
    expect(splitType('mysql', 'INT2')).toEqual({ base: 'INT2', rest: '' })
  })

  it('keeps an unlisted name and text with no name as they are', () => {
    expect(splitType('postgres', 'citext')).toEqual({ base: 'citext', rest: '' })
    expect(splitType('postgres', 'geometry(Point,4326)')).toEqual({ base: 'geometry', rest: '(Point,4326)' })
    expect(splitType('mysql', 'MYTYPE(3) x')).toEqual({ base: 'MYTYPE', rest: '(3) x' })
    expect(splitType('mysql', '_t1 y')).toEqual({ base: '_t1', rest: ' y' })
    expect(splitType('mysql', 'a(1)b')).toEqual({ base: 'a', rest: '(1)b' })
    expect(splitType('mysql', '')).toEqual({ base: '', rest: '' })
    expect(splitType('mysql', '(255)')).toEqual({ base: '', rest: '(255)' })
    expect(splitType('mysql', '9lives')).toEqual({ base: '', rest: '9lives' })
    expect(splitType('mysql', '1abc x')).toEqual({ base: '', rest: '1abc x' })
  })

  it('knows the usual arguments of a type that needs them, in any case', () => {
    expect(defaultArgs('VARCHAR')).toBe('(255)')
    expect(defaultArgs('varbinary')).toBe('(255)')
    expect(defaultArgs('Decimal')).toBe('(10,2)')
    expect(defaultArgs('NUMERIC')).toBe('(10,2)')
    expect(defaultArgs('INT')).toBe('')
    expect(defaultArgs('')).toBe('')
  })

  it("fills the usual arguments of a new name but keeps what the user typed, not the old name's own", () => {
    expect(retypeName('mysql', '', 'VARCHAR')).toBe('VARCHAR(255)')
    expect(retypeName('mysql', '', 'DECIMAL')).toBe('DECIMAL(10,2)')
    expect(retypeName('mysql', 'VARCHAR(255)', 'INT')).toBe('INT')
    expect(retypeName('mysql', 'VARCHAR(100)', 'CHAR')).toBe('CHAR(100)')
    expect(retypeName('mysql', 'VARCHAR(100)', 'TEXT')).toBe('TEXT(100)')
    expect(retypeName('mysql', 'DECIMAL(10,2)', 'NUMERIC')).toBe('NUMERIC(10,2)')
    expect(retypeName('mysql', 'DECIMAL(12,4)', 'NUMERIC')).toBe('NUMERIC(12,4)')
    expect(retypeName('mysql', 'INT UNSIGNED', 'BIGINT')).toBe('BIGINT UNSIGNED')
    expect(retypeName('mysql', 'int', 'VARCHAR')).toBe('VARCHAR(255)')
    expect(retypeName('postgres', 'numeric(10,2)', 'text')).toBe('text')
  })
})

describe('type names', () => {
  it('lists every name once and never a name that only differs by case', () => {
    for (const dialect of ['mysql', 'postgres'] as const) {
      const lower = TYPE_NAMES[dialect].map((n) => n.toLowerCase())
      expect(new Set(lower).size).toBe(lower.length)
    }
  })
})
