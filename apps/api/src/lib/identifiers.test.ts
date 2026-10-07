import { describe, expect, it } from 'vitest'
import { identifierTooLong, tooLongIdentifier } from './identifiers.ts'

const name = (n: number, ch = 'a') => ch.repeat(n)

describe('tooLongIdentifier', () => {
  it('measures MySQL in characters and PostgreSQL in bytes, only on name-carrying keys', () => {
    const ok = 'x'.repeat(63)
    expect(tooLongIdentifier({ op: 'createDatabase', name: ok }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(64) }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(65) }, 'mysql')).toEqual({
      name: 'x'.repeat(65),
      max: 64,
    })
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(64) }, 'postgres')).toEqual({
      name: 'x'.repeat(64),
      max: 63,
    })
    // 22 three-byte characters are 66 bytes: over the PostgreSQL limit, well within MySQL's.
    const kana = 'あ'.repeat(22)
    expect(tooLongIdentifier({ op: 'renameTable', table: 't', newName: kana }, 'postgres')?.name).toBe(kana)
    expect(tooLongIdentifier({ op: 'renameTable', table: 't', newName: kana }, 'mysql')).toBeNull()
    // Comments, defaults and hosts are not identifiers; column names are.
    expect(
      tooLongIdentifier({ op: 'x', comment: 'c'.repeat(200), user: { name: 'u', host: 'h'.repeat(100) } }, 'mysql')
    ).toBeNull()
    expect(tooLongIdentifier({ op: 'addIndex', columns: [{ name: 'c'.repeat(70) }] }, 'mysql')?.max).toBe(64)
    expect(tooLongIdentifier({ user: 'u'.repeat(70) }, 'postgres')?.max).toBe(63)
  })

  it('holds a name to 64 characters on MySQL and 63 bytes on PostgreSQL', () => {
    expect(tooLongIdentifier({ name: name(64) }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ name: name(65) }, 'mysql')).toEqual({ name: name(65), max: 64 })
    expect(tooLongIdentifier({ name: name(63) }, 'postgres')).toBeNull()
    expect(tooLongIdentifier({ name: name(64) }, 'postgres')).toEqual({ name: name(64), max: 63 })
  })

  it('counts characters on MySQL and bytes on PostgreSQL, where a name of 32 three-byte characters is too long', () => {
    const wide = name(32, 'あ')
    expect(tooLongIdentifier({ table: wide }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ table: wide }, 'postgres')).toEqual({ name: wide, max: 63 })
  })

  it('holds a MySQL account name to 32 characters; PostgreSQL has no shorter limit for a role', () => {
    expect(tooLongIdentifier({ user: name(32) }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ user: name(33) }, 'mysql')).toEqual({ name: name(33), max: 32 })
    expect(tooLongIdentifier({ user: name(33) }, 'postgres')).toBeNull()
  })

  it('looks at every key that names an object, and at none that does not', () => {
    for (const key of ['name', 'newName', 'table', 'database', 'schema', 'refTable', 'valueColumn'])
      expect(tooLongIdentifier({ [key]: name(70) }, 'mysql'), key).not.toBeNull()
    for (const key of ['comment', 'default', 'host', 'expression'])
      expect(tooLongIdentifier({ [key]: name(500) }, 'mysql'), key).toBeNull()
  })

  it('finds a name inside a list of column names, a list of objects and a nested object', () => {
    expect(tooLongIdentifier({ op: 'addIndex', columns: ['id', name(70)] }, 'mysql')).toMatchObject({ max: 64 })
    expect(tooLongIdentifier({ refColumns: [name(70)] }, 'mysql')).not.toBeNull()
    expect(tooLongIdentifier({ keyColumns: [name(70)] }, 'mysql')).not.toBeNull()
    expect(tooLongIdentifier({ columns: [{ name: 'id' }, { name: name(70) }] }, 'mysql')).not.toBeNull()
    expect(tooLongIdentifier({ fk: { refTable: name(70) } }, 'mysql')).not.toBeNull()
  })

  it('does not take a list of other things (values, statements) for names', () => {
    expect(tooLongIdentifier({ values: [name(500)] }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ statements: [name(500)] }, 'mysql')).toBeNull()
  })

  it('reads an account as name and host, and does not hold the host pattern to a name limit', () => {
    expect(tooLongIdentifier({ user: { name: 'app', host: name(200, '1') } }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ user: { name: name(70), host: '%' } }, 'mysql')).not.toBeNull()
  })

  it('is null for an op with nothing to check', () => {
    expect(tooLongIdentifier({}, 'mysql')).toBeNull()
    expect(tooLongIdentifier(null, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ name: 3 }, 'mysql')).toBeNull()
  })
})

describe('identifierTooLong', () => {
  it('is a VALIDATION error that names the identifier, its limit, and gives the client the reason to render', () => {
    expect(identifierTooLong({ name: 'x'.repeat(100), max: 64 })).toEqual({
      code: 'VALIDATION',
      message: `Identifier "${'x'.repeat(100)}" is longer than 64`,
      reason: 'IDENTIFIER_TOO_LONG',
      params: { name: 'x'.repeat(80), max: 64 },
    })
  })
})
