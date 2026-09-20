import { describe, expect, it } from 'vitest'
import { expandVariables } from './variables.ts'

const context = { db: 'shop', schema: 'app', user: 'ann', host: 'db.example', dialect: 'mysql' as const }

describe('expandVariables', () => {
  it('fills in the place the statement is loaded into', () => {
    expect(expandVariables('SELECT * FROM [DB].orders -- [USER]@[HOST] [SCHEMA]', context)).toBe(
      'SELECT * FROM shop.orders -- ann@db.example app'
    )
  })

  it('quotes a name that is not a plain identifier, per dialect, where it stands as one', () => {
    const odd = { ...context, db: 'my db', schema: 'a"b' }
    expect(expandVariables('SELECT * FROM [DB].t', odd)).toBe('SELECT * FROM `my db`.t')
    expect(expandVariables('SELECT * FROM [SCHEMA].t', { ...odd, dialect: 'postgres' })).toBe('SELECT * FROM "a""b".t')
    expect(expandVariables('USE [DB]', { ...odd, db: 'we`ird' })).toBe('USE `we``ird`')
  })

  it('writes a name inside a string literal with the quote doubled, not as an identifier', () => {
    const odd = { ...context, db: "o'brien" }
    expect(expandVariables('SELECT \'[DB]\', "[DB]", `[DB]`', odd)).toBe("SELECT 'o''brien', \"o'brien\", `o'brien`")
    expect(expandVariables("WHERE schema_name = '[DB]' AND x = '\\'[DB]'", context)).toBe(
      "WHERE schema_name = 'shop' AND x = '\\'shop'"
    )
  })

  it('leaves a name it does not know, a missing value, and other brackets alone', () => {
    expect(expandVariables('[TABLE] [db] [DB', context)).toBe('[TABLE] [db] [DB')
    expect(expandVariables('[SCHEMA] arr[1]', { ...context, schema: undefined })).toBe('[SCHEMA] arr[1]')
  })
})
