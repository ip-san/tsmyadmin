import type { ProcessInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { abbreviateQuery, isActiveProcess, sortProcesses } from './processes.ts'

describe('isActiveProcess', () => {
  it('hides sleeping and idle connections but keeps the ones holding a transaction open', () => {
    expect(isActiveProcess({ state: 'Sleep' })).toBe(false)
    expect(isActiveProcess({ state: 'idle' })).toBe(false)
    expect(isActiveProcess({ state: 'Query' })).toBe(true)
    expect(isActiveProcess({ state: 'active' })).toBe(true)
    expect(isActiveProcess({ state: 'active (Lock: relation)' })).toBe(true)
    expect(isActiveProcess({ state: 'idle in transaction' })).toBe(true)
    expect(isActiveProcess({ state: null })).toBe(true)
  })
})

const proc = (id: string, over: Partial<ProcessInfo> = {}): ProcessInfo => ({
  id,
  user: null,
  host: null,
  database: null,
  state: null,
  timeSec: null,
  query: null,
  self: false,
  ...over,
})

describe('sortProcesses', () => {
  it('orders ids as numbers, not text', () => {
    const sorted = sortProcesses([proc('9'), proc('10'), proc('2')], 'id', 'asc')
    expect(sorted.map((p) => p.id)).toEqual(['2', '9', '10'])
    expect(sortProcesses(sorted, 'id', 'desc').map((p) => p.id)).toEqual(['10', '9', '2'])
  })

  it('puts missing values last in both directions', () => {
    const list = [proc('1', { timeSec: null }), proc('2', { timeSec: 5 }), proc('3', { timeSec: 1 })]
    expect(sortProcesses(list, 'timeSec', 'asc').map((p) => p.id)).toEqual(['3', '2', '1'])
    expect(sortProcesses(list, 'timeSec', 'desc').map((p) => p.id)).toEqual(['2', '3', '1'])
  })

  it('leaves the list it was given as it was', () => {
    const list = [proc('2', { user: 'b' }), proc('1', { user: 'a' })]
    sortProcesses(list, 'user', 'asc')
    expect(list.map((p) => p.id)).toEqual(['2', '1'])
  })
})

describe('abbreviateQuery', () => {
  it('cuts to 100 characters unless the whole statement is asked for', () => {
    const long = 'x'.repeat(150)
    expect(abbreviateQuery(long, false)).toBe(`${'x'.repeat(100)}…`)
    expect(abbreviateQuery(long, true)).toBe(long)
    expect(abbreviateQuery('SELECT 1', false)).toBe('SELECT 1')
  })
})
