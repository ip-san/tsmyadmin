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
  toColumnSpec,
  validateColumn,
} from './column-spec.ts'

/**
 * How a column is written down from the form and read back: the type split into name and rest, the invisible parts
 * that travel with it, and what a new type does to them. MySQL rewrites the whole column on every change, so each
 * of these is a part of a definition that could silently be lost (found by mutation testing).
 */

const form = (extra: Partial<ColumnFormValues> = {}): ColumnFormValues => ({
  ...EMPTY_COLUMN,
  name: 'c',
  dataType: 'INT',
  ...extra,
})
const def = (extra: Partial<ColumnDef> = {}): ColumnDef =>
  ({
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
    ...extra,
  }) as ColumnDef

describe('toColumnSpec: an ordinary column', () => {
  it('trims the name and the type, keeps the default as typed, and an empty comment is none', () => {
    expect(
      toColumnSpec(
        form({ name: '  id ', dataType: ' BIGINT(20) ', nullable: false, autoIncrement: true, comment: '  ' })
      )
    ).toEqual({
      name: 'id',
      dataType: 'BIGINT(20)',
      nullable: false,
      default: null,
      autoIncrement: true,
      comment: null,
      collation: null,
      onUpdate: null,
      check: null,
      generated: null,
    })
    expect(toColumnSpec(form({ comment: '' })).comment).toBeNull()
    expect(toColumnSpec(form({ comment: ' kept as typed ' })).comment).toBe(' kept as typed ')
  })

  it('writes a default as nothing, a literal or an expression, the text untrimmed', () => {
    expect(toColumnSpec(form({ defaultKind: 'none', defaultValue: 'ignored' })).default).toBeNull()
    expect(toColumnSpec(form({ defaultKind: 'literal', defaultValue: ' x ' })).default).toEqual({
      kind: 'literal',
      value: ' x ',
    })
    expect(toColumnSpec(form({ defaultKind: 'expression', defaultValue: 'now()' })).default).toEqual({
      kind: 'expression',
      sql: 'now()',
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
})

describe('toColumnSpec: a generated column', () => {
  it('has no default, identity or ON UPDATE of its own, and the expression trimmed', () => {
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

describe('validateColumn', () => {
  it('names the first thing missing: the name, then the type, then a generated expression', () => {
    expect(validateColumn(form({ name: '', dataType: '' }))).toBe('name')
    expect(validateColumn(form({ name: '   ' }))).toBe('name')
    expect(validateColumn(form({ dataType: '' }))).toBe('dataType')
    expect(validateColumn(form({ dataType: '  ' }))).toBe('dataType')
    expect(validateColumn(form({ generated: { expression: '', stored: true } }))).toBe('generated')
    expect(validateColumn(form({ generated: { expression: '   ', stored: false } }))).toBe('generated')
    expect(validateColumn(form({ generated: { expression: 'a', stored: true } }))).toBeNull()
    expect(validateColumn(form())).toBeNull()
    expect(validateColumn(form({ name: ' c ', dataType: ' INT ' }))).toBeNull()
  })
})

describe('splitType', () => {
  it('takes the longest known name, whatever the case, and keeps the rest as it is', () => {
    expect(splitType('mysql', 'DOUBLE PRECISION')).toEqual({ base: 'DOUBLE PRECISION', rest: '' })
    expect(splitType('mysql', 'double precision(10)')).toEqual({ base: 'DOUBLE PRECISION', rest: '(10)' })
    expect(splitType('mysql', 'double(10,2)')).toEqual({ base: 'DOUBLE', rest: '(10,2)' })
    expect(splitType('mysql', 'varchar(255)')).toEqual({ base: 'VARCHAR', rest: '(255)' })
    expect(splitType('mysql', 'INT UNSIGNED')).toEqual({ base: 'INT', rest: ' UNSIGNED' })
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

  it('keeps a name that is not listed, and text that starts with no name whole', () => {
    expect(splitType('mysql', 'MYTYPE(3) x')).toEqual({ base: 'MYTYPE', rest: '(3) x' })
    expect(splitType('mysql', '(255)')).toEqual({ base: '', rest: '(255)' })
    expect(splitType('mysql', '')).toEqual({ base: '', rest: '' })
    expect(splitType('mysql', '9lives')).toEqual({ base: '', rest: '9lives' })
    expect(splitType('mysql', '_t1 y')).toEqual({ base: '_t1', rest: ' y' })
    expect(splitType('mysql', 'a(1)b')).toEqual({ base: 'a', rest: '(1)b' })
    expect(splitType('mysql', '1abc x')).toEqual({ base: '', rest: '1abc x' })
  })
})

describe('retypeName and defaultArgs', () => {
  it('fills in the usual arguments of a type that needs them, in any case', () => {
    expect(defaultArgs('VARCHAR')).toBe('(255)')
    expect(defaultArgs('varbinary')).toBe('(255)')
    expect(defaultArgs('Decimal')).toBe('(10,2)')
    expect(defaultArgs('NUMERIC')).toBe('(10,2)')
    expect(defaultArgs('INT')).toBe('')
    expect(defaultArgs('')).toBe('')
  })

  it("keeps what the user typed after the old name, but not the old name's own usual arguments", () => {
    expect(retypeName('mysql', 'VARCHAR(255)', 'INT')).toBe('INT')
    expect(retypeName('mysql', 'VARCHAR(100)', 'TEXT')).toBe('TEXT(100)')
    expect(retypeName('mysql', 'INT', 'VARCHAR')).toBe('VARCHAR(255)')
    expect(retypeName('mysql', 'DECIMAL(10,2)', 'NUMERIC')).toBe('NUMERIC(10,2)')
    expect(retypeName('mysql', 'DECIMAL(12,4)', 'NUMERIC')).toBe('NUMERIC(12,4)')
    expect(retypeName('mysql', '', 'DECIMAL')).toBe('DECIMAL(10,2)')
    expect(retypeName('mysql', 'INT UNSIGNED', 'BIGINT')).toBe('BIGINT UNSIGNED')
    expect(retypeName('mysql', 'int', 'VARCHAR')).toBe('VARCHAR(255)')
  })
})

describe('fromColumnDef and fromCentralColumn', () => {
  it('reads a default as a literal or an expression, and none for an identity, serial or generated column', () => {
    expect(fromColumnDef(def({ default: 'x' }), 'mysql')).toMatchObject({
      defaultKind: 'literal',
      defaultValue: 'x',
      autoIncrement: false,
    })
    expect(fromColumnDef(def({ default: 'now()', defaultIsExpression: true }), 'postgres')).toMatchObject({
      defaultKind: 'expression',
      defaultValue: 'now()',
    })
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
    expect(fromColumnDef(def({ default: null }), 'mysql')).toMatchObject({ defaultKind: 'none', defaultValue: '' })
    expect(fromColumnDef(def({ default: '' }), 'mysql')).toMatchObject({ defaultKind: 'literal', defaultValue: '' })
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

  it('reads ON UPDATE on MySQL only', () => {
    const column = def({ dataType: 'timestamp', extra: 'on update CURRENT_TIMESTAMP' })
    expect(fromColumnDef(column, 'mysql').onUpdate).toBe('CURRENT_TIMESTAMP')
    expect(fromColumnDef(column, 'postgres').onUpdate).toBeNull()
    expect(fromColumnDef(def(), 'mysql').onUpdate).toBeNull()
  })

  it('starts a column from a central one, with its default as a literal or an expression', () => {
    const central = (extra: Partial<CentralColumnBody> = {}) =>
      ({
        name: 'n',
        dataType: 'INT',
        nullable: false,
        default: null,
        defaultIsExpression: false,
        comment: 'c',
        ...extra,
      }) as CentralColumnBody
    expect(fromColumnDef(def(), 'mysql')).toBeDefined()
    expect(fromCentralColumn(central())).toEqual({
      ...EMPTY_COLUMN,
      name: 'n',
      dataType: 'INT',
      nullable: false,
      comment: 'c',
    })
    expect(fromCentralColumn(central({ default: 'x' }))).toMatchObject({ defaultKind: 'literal', defaultValue: 'x' })
    expect(fromCentralColumn(central({ default: 'now()', defaultIsExpression: true }))).toMatchObject({
      defaultKind: 'expression',
      defaultValue: 'now()',
    })
    expect(fromCentralColumn(central({ default: '' }))).toMatchObject({ defaultKind: 'literal', defaultValue: '' })
  })
})

describe('retypeColumn: the collation', () => {
  const retyped = (dataType: string, v: Partial<ColumnFormValues> = {}, initial: Partial<ColumnFormValues> = {}) =>
    retypeColumn(form({ collation: 'utf8mb4_bin', ...v }), form({ collation: 'latin1_bin', ...initial }), dataType)

  it('keeps it for a type that can hold one, and drops it for one that cannot', () => {
    for (const keeps of [
      'VARCHAR(100)',
      'char(3)',
      'TEXT',
      'LONGTEXT',
      "ENUM('a','b')",
      "SET('a')",
      'CHARACTER VARYING(5)',
      'CHARACTER(5)',
      'LONG VARCHAR',
      'long',
      'tinytext',
    ]) {
      expect(retyped(keeps).collation, keeps).toBe('utf8mb4_bin')
    }
    for (const drops of [
      'JSON',
      'INT',
      'BLOB',
      'DATETIME',
      'NVARCHAR(5)',
      'NATIONAL VARCHAR(5)',
      'VARCHARX',
      'XVARCHAR',
    ]) {
      expect(retyped(drops).collation, drops).toBeNull()
    }
  })

  it("goes back to the first value when the form's was dropped, and steps aside for one the user typed", () => {
    expect(retyped('VARCHAR(5)', { collation: null }).collation).toBe('latin1_bin')
    expect(retyped('VARCHAR(5)', { collation: null }, { collation: null }).collation).toBeNull()
    for (const typed of [
      'VARCHAR(5) COLLATE utf8mb4_bin',
      'varchar(5) collate x',
      'VARCHAR(5) CHARACTER SET latin1',
      'VARCHAR(5) CHARSET latin1',
      'VARCHAR(5) character  set x',
    ]) {
      expect(retyped(typed).collation, typed).toBeNull()
    }
    expect(retyped('VARCHAR(5) COLLATEX').collation).toBe('utf8mb4_bin')
  })

  it('reads the type without its comments and string literals, so a word inside them is not a clause', () => {
    expect(retyped("ENUM('collate','charset')").collation).toBe('utf8mb4_bin')
    expect(retyped('ENUM("collate")').collation).toBe('utf8mb4_bin')
    expect(retyped("ENUM('it''s collate')").collation).toBe('utf8mb4_bin')
    expect(retyped("ENUM('a\\' collate')").collation).toBe('utf8mb4_bin')
    expect(retyped('ENUM(`collate`)').collation).toBe('utf8mb4_bin')
    expect(retyped("ENUM('a') COLLATE utf8mb4_bin").collation).toBeNull()
    expect(retyped('/* widen */ VARCHAR(100)').collation).toBe('utf8mb4_bin')
    expect(retyped('/* COLLATE */ VARCHAR(100)').collation).toBe('utf8mb4_bin')
    expect(retyped('VARCHAR(5) /* COLLATE never closed').collation).toBe('utf8mb4_bin')
    expect(retyped('VARCHAR(5) /* x */ COLLATE y').collation).toBeNull()
    expect(retyped("VARCHAR(5) 'unclosed COLLATE").collation).toBe('utf8mb4_bin')
    expect(retyped("/**/ENUM('x')").collation).toBe('utf8mb4_bin')
    expect(retyped('a / b VARCHAR').collation).toBeNull()
  })
})

describe('retypeColumn: ON UPDATE and the timestamp default', () => {
  const retyped = (dataType: string, v: Partial<ColumnFormValues> = {}) =>
    retypeColumn(form({ onUpdate: 'CURRENT_TIMESTAMP', ...v }), form(), dataType)

  it('follows the fractional precision of a TIMESTAMP or DATETIME, and goes with any other type', () => {
    expect(retyped('TIMESTAMP').onUpdate).toBe('CURRENT_TIMESTAMP')
    expect(retyped('timestamp(3)').onUpdate).toBe('CURRENT_TIMESTAMP(3)')
    expect(retyped('DATETIME(6)').onUpdate).toBe('CURRENT_TIMESTAMP(6)')
    expect(retyped('DATETIME (2)').onUpdate).toBe('CURRENT_TIMESTAMP(2)')
    expect(retyped('/* x */ TIMESTAMP(1)').onUpdate).toBe('CURRENT_TIMESTAMP(1)')
    expect(retyped('INT').onUpdate).toBeNull()
    expect(retyped('DATE').onUpdate).toBeNull()
    expect(retyped('TIMESTAMP(3)', { onUpdate: null }).onUpdate).toBeNull()
  })

  it('moves a DEFAULT CURRENT_TIMESTAMP shown in the form to the same precision, and no other default', () => {
    const exp = (defaultValue: string, dataType = 'TIMESTAMP(3)', extra: Partial<ColumnFormValues> = {}) =>
      retyped(dataType, { defaultKind: 'expression', defaultValue, ...extra }).defaultValue
    expect(exp('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP(3)')
    expect(exp(' current_timestamp(6) ')).toBe('CURRENT_TIMESTAMP(3)')
    expect(exp('CURRENT_TIMESTAMP(3)', 'DATETIME')).toBe('CURRENT_TIMESTAMP')
    expect(exp('NOW()')).toBe('NOW()')
    expect(exp('CURRENT_TIMESTAMP + 1')).toBe('CURRENT_TIMESTAMP + 1')
    expect(exp('CURRENT_TIMESTAMP', 'INT')).toBe('CURRENT_TIMESTAMP')
    expect(exp('CURRENT_TIMESTAMP', 'TIMESTAMP(3)', { defaultKind: 'literal' })).toBe('CURRENT_TIMESTAMP')
    expect(exp('CURRENT_TIMESTAMP', 'TIMESTAMP(3)', { defaultKind: 'none' })).toBe('CURRENT_TIMESTAMP')
  })

  it('keeps the rest of the form and sets the new type', () => {
    const out = retypeColumn(form({ name: 'x', comment: 'k', nullable: false }), form(), 'BIGINT')
    expect(out).toMatchObject({ name: 'x', comment: 'k', nullable: false, dataType: 'BIGINT' })
  })
})
