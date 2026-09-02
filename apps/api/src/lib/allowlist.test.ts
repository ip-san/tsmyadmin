import { describe, expect, it } from 'vitest'
import { entriesWithoutPort, isHostAllowed, parseEntry } from './allowlist.ts'

describe('isHostAllowed', () => {
  it('matches exact hosts case-insensitively (any port when the entry has none)', () => {
    expect(isHostAllowed('DB.internal', 5432, ['db.internal'])).toBe(true)
    expect(isHostAllowed('db.internal.', 1, ['db.internal'])).toBe(true)
    expect(isHostAllowed('[::1]', 3306, ['::1'])).toBe(true)
    expect(isHostAllowed('evil.internal', 5432, ['db.internal'])).toBe(false)
  })

  it('restricts the port when the entry names one', () => {
    expect(isHostAllowed('db.internal', 5432, ['db.internal:5432'])).toBe(true)
    expect(isHostAllowed('db.internal', 22, ['db.internal:5432'])).toBe(false)
    expect(isHostAllowed('::1', 3306, ['[::1]:3306'])).toBe(true)
    expect(isHostAllowed('::1', 3307, ['[::1]:3306'])).toBe(false)
    expect(isHostAllowed('x.rds.amazonaws.com', 5432, ['*.rds.amazonaws.com:5432'])).toBe(true)
    expect(isHostAllowed('x.rds.amazonaws.com', 80, ['*.rds.amazonaws.com:5432'])).toBe(false)
    expect(isHostAllowed('anything', 80, ['*:5432'])).toBe(false)
    expect(isHostAllowed('anything', 5432, ['*:5432'])).toBe(true)
  })

  it('supports wildcard suffixes without matching the bare suffix', () => {
    expect(isHostAllowed('prod.rds.amazonaws.com', 5432, ['*.rds.amazonaws.com'])).toBe(true)
    expect(isHostAllowed('rds.amazonaws.com', 5432, ['*.rds.amazonaws.com'])).toBe(false)
    expect(isHostAllowed('x.notrds.amazonaws.com', 5432, ['*.rds.amazonaws.com'])).toBe(false)
  })

  it('"*" allows everything, empty host never matches', () => {
    expect(isHostAllowed('anything', 1, ['*'])).toBe(true)
    expect(isHostAllowed('', 1, ['*'])).toBe(false)
    expect(isHostAllowed('127.0.0.1', 3306, [])).toBe(false)
  })
})

describe('parseEntry / entriesWithoutPort', () => {
  it('parses host, bracketed IPv6 and wildcard entries with optional ports', () => {
    expect(parseEntry('db:3306')).toEqual({ host: 'db', port: 3306 })
    expect(parseEntry('[::1]:5432')).toEqual({ host: '::1', port: 5432 })
    expect(parseEntry('::1')).toEqual({ host: '::1', port: null })
    expect(parseEntry('db:99999')).toEqual({ host: 'db:99999', port: null })
    expect(parseEntry('*.x.com:5432')).toEqual({ host: '*.x.com', port: 5432 })
  })

  it('lists entries that allow any port', () => {
    expect(entriesWithoutPort(['a:1', 'b', '*', '[::1]:2'])).toEqual(['b', '*'])
  })
})
