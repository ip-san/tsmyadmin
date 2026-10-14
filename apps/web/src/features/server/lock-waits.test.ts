import type { LockWait } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { blockerAsProcess, isNearLimit, usagePercent } from './lock-waits.ts'

describe('connection usage', () => {
  it('is a whole percentage of max_connections, or null without a maximum', () => {
    expect(usagePercent({ current: 1, max: 3, idleInTransaction: 0 })).toBe(33)
    expect(usagePercent({ current: 151, max: 151, idleInTransaction: 0 })).toBe(100)
    expect(usagePercent({ current: 5, max: null, idleInTransaction: null })).toBeNull()
    expect(usagePercent({ current: 5, max: 0, idleInTransaction: null })).toBeNull()
  })

  it('warns from 80% of the limit on', () => {
    expect(isNearLimit({ current: 79, max: 100, idleInTransaction: 0 })).toBe(false)
    expect(isNearLimit({ current: 80, max: 100, idleInTransaction: 0 })).toBe(true)
    expect(isNearLimit({ current: 120, max: 100, idleInTransaction: 0 })).toBe(true)
    expect(isNearLimit({ current: 500, max: null, idleInTransaction: 0 })).toBe(false)
    expect(isNearLimit({ current: 1, max: 0, idleInTransaction: 0 })).toBe(false)
  })
})

describe('blockerAsProcess', () => {
  it('hands the blocking session to the kill dialog, with its transaction age as the time', () => {
    const wait: LockWait = {
      blocked: { id: '9', user: 'app', database: 'shop', waitSec: 4, query: 'UPDATE t SET v = 2' },
      blocking: {
        id: '8',
        user: 'app',
        database: 'shop',
        state: 'idle in transaction',
        idleInTransaction: true,
        transactionSec: 60,
        query: 'UPDATE t SET v = 1',
      },
      table: 'shop.t',
      mode: 'X',
    }
    expect(blockerAsProcess(wait)).toEqual({
      id: '8',
      user: 'app',
      host: null,
      database: 'shop',
      state: 'idle in transaction',
      timeSec: 60,
      query: 'UPDATE t SET v = 1',
      self: false,
    })
  })
})
