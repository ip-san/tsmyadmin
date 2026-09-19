import { describe, expect, it } from 'vitest'
import { expandVariables } from './variables.ts'

const context = { db: 'shop', schema: 'app', user: 'ann', host: 'db.example' }

describe('expandVariables', () => {
  it('fills in the place the statement is loaded into', () => {
    expect(expandVariables('SELECT * FROM [DB].orders -- [USER]@[HOST] [SCHEMA]', context)).toBe(
      'SELECT * FROM shop.orders -- ann@db.example app'
    )
  })

  it('leaves a name it does not know, a missing value, and other brackets alone', () => {
    expect(expandVariables('[TABLE] [db] [DB', context)).toBe('[TABLE] [db] [DB')
    expect(expandVariables('[SCHEMA] arr[1]', { ...context, schema: undefined })).toBe('[SCHEMA] arr[1]')
  })
})
