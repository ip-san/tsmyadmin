import { describe, expect, it } from 'vitest'
import { capabilities } from './capabilities.ts'
import { DialectSchema } from './schemas/dialect.ts'

describe('capabilities', () => {
  it('is defined for every dialect', () => {
    for (const dialect of DialectSchema.options) expect(capabilities(dialect)).toBeDefined()
  })

  it('says only MySQL reads a backslash in a string literal as an escape', () => {
    expect(capabilities('mysql').literalBackslashEscapes).toBe(true)
    expect(capabilities('postgres').literalBackslashEscapes).toBe(false)
  })

  it('says which character quotes an identifier', () => {
    expect(capabilities('mysql').identifierQuote).toBe('`')
    expect(capabilities('postgres').identifierQuote).toBe('"')
  })

  it('says how long a name may be, in the unit the server counts', () => {
    expect(capabilities('mysql').identifier).toEqual({ max: 64, unit: 'chars', accountMax: 32 })
    expect(capabilities('postgres').identifier).toEqual({ max: 63, unit: 'bytes', accountMax: null })
  })

  it('says only PostgreSQL runs DDL inside a transaction, and how each opens one', () => {
    expect(capabilities('postgres')).toMatchObject({ transactionalDdl: true, beginTransaction: 'BEGIN' })
    expect(capabilities('mysql')).toMatchObject({ transactionalDdl: false, beginTransaction: 'START TRANSACTION' })
  })

  it('names the statement that switches foreign key checks off, which is never empty', () => {
    for (const dialect of DialectSchema.options) expect(capabilities(dialect).foreignKeyChecksOff).toMatch(/^SET /)
  })

  it('says only MySQL can copy the rows of a database into one that already has the tables', () => {
    expect(capabilities('mysql').copyDatabaseWithoutStructure).toBe(true)
    expect(capabilities('postgres').copyDatabaseWithoutStructure).toBe(false)
  })

  it('says how a dump is written: PostgreSQL in sections ordered by dependency, MySQL object by object and locked', () => {
    expect(capabilities('postgres').dump).toMatchObject({
      dropsInOneSection: true,
      dependencyCatalog: true,
      deferForeignKeys: true,
      materializedViews: true,
      lockTables: false,
    })
    expect(capabilities('mysql').dump).toMatchObject({
      dropsInOneSection: false,
      dependencyCatalog: false,
      deferForeignKeys: false,
      materializedViews: false,
      lockTables: true,
    })
  })

  it('names the statements that put a dump in UTC, and the one that undoes it only where it is needed', () => {
    expect(capabilities('postgres').dump.utc).toEqual({ set: "SET TIME ZONE 'UTC'", restore: null })
    expect(capabilities('mysql').dump.utc.restore).toMatch(/^SET TIME_ZONE/)
  })

  it('says only MySQL has events and only PostgreSQL overloads routines', () => {
    expect(capabilities('mysql')).toMatchObject({ events: true, routineOverloads: false })
    expect(capabilities('postgres')).toMatchObject({ events: false, routineOverloads: true })
  })

  it('says a MySQL database is what PostgreSQL calls a schema, and that only MySQL scripts have DELIMITER', () => {
    expect(capabilities('mysql')).toMatchObject({ databasesAreSchemas: true, scriptDelimiter: true })
    expect(capabilities('postgres')).toMatchObject({ databasesAreSchemas: false, scriptDelimiter: false })
  })
})
