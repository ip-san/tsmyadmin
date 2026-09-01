import { describe, expect, it } from 'vitest'
import { isHostAllowed } from './allowlist.ts'

describe('isHostAllowed', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(isHostAllowed('DB.internal', ['db.internal'])).toBe(true)
    expect(isHostAllowed('db.internal.', ['db.internal'])).toBe(true)
    expect(isHostAllowed('[::1]', ['::1'])).toBe(true)
    expect(isHostAllowed('evil.internal', ['db.internal'])).toBe(false)
  })

  it('supports wildcard suffixes without matching the bare suffix', () => {
    expect(isHostAllowed('prod.rds.amazonaws.com', ['*.rds.amazonaws.com'])).toBe(true)
    expect(isHostAllowed('rds.amazonaws.com', ['*.rds.amazonaws.com'])).toBe(false)
    expect(isHostAllowed('x.notrds.amazonaws.com', ['*.rds.amazonaws.com'])).toBe(false)
  })

  it('"*" allows everything, empty host never matches', () => {
    expect(isHostAllowed('anything', ['*'])).toBe(true)
    expect(isHostAllowed('', ['*'])).toBe(false)
    expect(isHostAllowed('127.0.0.1', [])).toBe(false)
  })
})
